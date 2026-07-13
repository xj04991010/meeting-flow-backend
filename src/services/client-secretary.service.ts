import { createClient, getClients } from '../repositories/clients.repo';
import {
  getClientLatestNote,
  getClientWeeklyNotes,
  getLatestNotesForAllClients,
  type ClientDateLink,
  type ClientWeeklyNoteData,
  upsertClientWeeklyNote,
} from '../repositories/client-weekly-notes.repo';
import { getDashboardUrl } from '../utils/env';
import { sendTelegram } from './telegram.service';

type NoteField = 'current_status' | 'progress_note' | 'next_week_note' | 'shooting_note' | 'urgent_note';

const SHOOTING_SECTION = '【待拍攝內容】';
const COMPANY_HELP_SECTION = '【需公司判斷／緊急協辦】';

export type ClientSecretaryCommand =
  | { type: 'summary'; range: 'today' | 'week' }
  | { type: 'create_client'; clientName: string }
  | { type: 'status'; clientName: string }
  | { type: 'set_light'; clientName: string; light: 'green' | 'yellow' | 'red'; reason: string }
  | { type: 'append_note'; clientName: string; field: NoteField; text: string };

const LIGHT_MAP = {
  綠: 'green',
  黃: 'yellow',
  紅: 'red',
} as const;

function normalizeCommandText(value: string) {
  return value
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export function parseSupplementNote(value?: string | null) {
  const normalized = String(value || '').trim();
  if (!normalized.includes(SHOOTING_SECTION) && !normalized.includes(COMPANY_HELP_SECTION)) {
    return { shootingNote: '', companyHelp: normalized };
  }

  const shootingStart = normalized.indexOf(SHOOTING_SECTION);
  const companyStart = normalized.indexOf(COMPANY_HELP_SECTION);
  return {
    shootingNote: shootingStart >= 0
      ? normalized.slice(
        shootingStart + SHOOTING_SECTION.length,
        companyStart > shootingStart ? companyStart : undefined,
      ).trim()
      : '',
    companyHelp: companyStart >= 0
      ? normalized.slice(
        companyStart + COMPANY_HELP_SECTION.length,
        shootingStart > companyStart ? shootingStart : undefined,
      ).trim()
      : '',
  };
}

export function serializeSupplementNote(shootingNote: string, companyHelp: string) {
  return [
    shootingNote.trim() ? `${SHOOTING_SECTION}\n${shootingNote.trim()}` : '',
    companyHelp.trim() ? `${COMPANY_HELP_SECTION}\n${companyHelp.trim()}` : '',
  ].filter(Boolean).join('\n\n');
}

function appendLine(current: string, value: string) {
  return current.trim() ? `${current.trim()}\n${value.trim()}` : value.trim();
}

export function getTaipeiDateKey(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

export function getTaipeiWeekKey(date = new Date()) {
  const dateKey = getTaipeiDateKey(date);
  const taipeiDate = new Date(`${dateKey}T00:00:00+08:00`);
  const day = taipeiDate.getDay();
  taipeiDate.setDate(taipeiDate.getDate() - day + (day === 0 ? -6 : 1));
  return getTaipeiDateKey(taipeiDate);
}

export function parseClientSecretaryCommand(
  input: string,
  clientNames: string[],
): ClientSecretaryCommand | null {
  const text = normalizeCommandText(input);
  const lower = text.toLowerCase();

  if (['/today', 'today', '今天', '今日'].includes(lower)) {
    return { type: 'summary', range: 'today' };
  }
  if (['/week', 'week', '本週', '本周', '這週', '这周'].includes(lower)) {
    return { type: 'summary', range: 'week' };
  }

  const createMatch = text.match(/^(?:\/client|新增客戶|新增業主)\s+(.+)$/i);
  if (createMatch?.[1]?.trim()) {
    return { type: 'create_client', clientName: createMatch[1].trim() };
  }

  const matchedClient = [...clientNames]
    .sort((a, b) => b.length - a.length)
    .find((clientName) => lower.startsWith(clientName.toLowerCase()));
  if (!matchedClient) return null;

  const remainder = text.slice(matchedClient.length).trim().replace(/^[:：]\s*/, '');
  if (!remainder) return { type: 'status', clientName: matchedClient };

  if (/^(?:狀態|進度|status)$/i.test(remainder)) {
    return { type: 'status', clientName: matchedClient };
  }

  const lightMatch = remainder.match(/^(?:改|設為|设为|切換|切换)?\s*(紅|黃|綠)燈(?:\s+|[:：])?(.*)$/i);
  if (lightMatch) {
    return {
      type: 'set_light',
      clientName: matchedClient,
      light: LIGHT_MAP[lightMatch[1] as keyof typeof LIGHT_MAP],
      reason: lightMatch[2]?.trim() || '',
    };
  }

  const fieldPrefixes: Array<{ pattern: RegExp; field: NoteField }> = [
    { pattern: /^(?:目前狀態|現在狀態|狀態更新)\s*[:：]?\s*/i, field: 'current_status' },
    { pattern: /^(?:本週|本周|本週進度|本周進度)\s*[:：]?\s*/i, field: 'progress_note' },
    { pattern: /^(?:下週|下周|下週進度|下周進度|下週推進|下周推進)\s*[:：]?\s*/i, field: 'next_week_note' },
    { pattern: /^(?:待拍攝內容|待拍攝|拍攝清單)\s*[:：]?\s*/i, field: 'shooting_note' },
    { pattern: /^(?:緊急|緊急事項|協辦|公司協助|需公司協助)\s*[:：]?\s*/i, field: 'urgent_note' },
  ];

  for (const { pattern, field } of fieldPrefixes) {
    if (!pattern.test(remainder)) continue;
    const noteText = remainder.replace(pattern, '').trim();
    return noteText ? { type: 'append_note', clientName: matchedClient, field, text: noteText } : null;
  }

  return {
    type: 'append_note',
    clientName: matchedClient,
    field: 'progress_note',
    text: remainder,
  };
}

function copyNoteForWeek(
  clientName: string,
  weekKey: string,
  source?: Record<string, unknown> | null,
): ClientWeeklyNoteData {
  return {
    client_name: clientName,
    week_key: weekKey,
    traffic_light: source?.traffic_light === 'red' || source?.traffic_light === 'yellow'
      ? source.traffic_light
      : 'green',
    current_status: typeof source?.current_status === 'string' ? source.current_status : '',
    progress_note: typeof source?.progress_note === 'string' ? source.progress_note : '',
    next_week_note: typeof source?.next_week_note === 'string' ? source.next_week_note : '',
    urgent_note: typeof source?.urgent_note === 'string' ? source.urgent_note : '',
    raw_count: Number(source?.raw_count) || 0,
    edited_count: Number(source?.edited_count) || 0,
    scheduled_count: Number(source?.scheduled_count) || 0,
    unshot_count: Number(source?.unshot_count) || 0,
    date_links: Array.isArray(source?.date_links) ? source.date_links as ClientWeeklyNoteData['date_links'] : [],
  };
}

function lightLabel(value?: string) {
  if (value === 'red') return '紅燈';
  if (value === 'yellow') return '黃燈';
  return '綠燈';
}

async function sendSummary(chatId: number, userId: string, range: 'today' | 'week') {
  const clients = await getClients(userId);
  if (!clients.length) {
    await sendTelegram(chatId, `目前還沒有客戶。先到 Dashboard 新增：${getDashboardUrl(userId)}`);
    return;
  }

  const weekKey = getTaipeiWeekKey();
  const currentNotes = await getClientWeeklyNotes(userId, weekKey);
  const notes = currentNotes.length ? currentNotes : await getLatestNotesForAllClients(userId);
  const today = getTaipeiDateKey();
  const lines: string[] = [];

  for (const client of clients) {
    const note = notes.find((item) => item.client_name === client.name);
    if (!note) continue;
    const dateLinks: ClientDateLink[] = Array.isArray(note.date_links) ? note.date_links : [];
    const dueToday = dateLinks.filter((link) => link.date === today);

    if (range === 'today') {
      if (!dueToday.length && note.traffic_light === 'green') continue;
      const supplement = parseSupplementNote(note.urgent_note);
      const dueText = dueToday.length
        ? dueToday.map((link) => link.label).join('、')
        : supplement.companyHelp || supplement.shootingNote || '需持續追蹤';
      lines.push(`【${client.name}】${lightLabel(note.traffic_light)}：${dueText}`);
      continue;
    }

    const progress = note.progress_note || note.current_status || '本週尚未更新';
    lines.push(`【${client.name}】${lightLabel(note.traffic_light)}：${progress}`);
  }

  const title = range === 'today' ? `今日追蹤 ${today}` : `本週客戶進度 ${weekKey}`;
  const body = lines.length ? lines.join('\n') : '目前沒有需要追蹤的事項。';
  await sendTelegram(chatId, `${title}\n\n${body}\n\nDashboard：${getDashboardUrl(userId)}`);
}

export async function handleClientSecretaryMessage(
  chatId: number,
  userId: string,
  input: string,
): Promise<boolean> {
  const clients = await getClients(userId);
  const command = parseClientSecretaryCommand(input, clients.map((client) => client.name));
  if (!command) return false;

  if (command.type === 'summary') {
    await sendSummary(chatId, userId, command.range);
    return true;
  }

  if (command.type === 'create_client') {
    try {
      await createClient(userId, { name: command.clientName, status: 'active' });
      await sendTelegram(chatId, `已新增客戶【${command.clientName}】。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicate = /duplicate|unique/i.test(message);
      await sendTelegram(chatId, duplicate
        ? `客戶【${command.clientName}】已經存在。`
        : `新增客戶失敗：${message}`);
    }
    return true;
  }

  const weekKey = getTaipeiWeekKey();
  const currentNotes = await getClientWeeklyNotes(userId, weekKey);
  const currentNote = currentNotes.find((note) => note.client_name === command.clientName)
    || await getClientLatestNote(userId, command.clientName);

  if (command.type === 'status') {
    if (!currentNote) {
      await sendTelegram(chatId, `【${command.clientName}】目前沒有週進度紀錄。`);
      return true;
    }
    const supplement = parseSupplementNote(currentNote.urgent_note);
    const counts = `毛片 ${currentNote.raw_count || 0}｜成片 ${currentNote.edited_count || 0}｜已排程 ${currentNote.scheduled_count || 0}｜本月未拍 ${currentNote.unshot_count || 0}`;
    await sendTelegram(
      chatId,
      `【${command.clientName}】${lightLabel(currentNote.traffic_light)}\n`
      + `目前狀態：${currentNote.current_status || '尚未更新'}\n`
      + `本週：${currentNote.progress_note || '尚未更新'}\n`
      + `下週：${currentNote.next_week_note || '尚未更新'}\n`
      + `待拍攝：${supplement.shootingNote || '無'}\n`
      + `協辦：${supplement.companyHelp || '無'}\n`
      + counts,
    );
    return true;
  }

  const nextNote = copyNoteForWeek(command.clientName, weekKey, currentNote);
  if (command.type === 'set_light') {
    nextNote.traffic_light = command.light;
    if (command.reason) {
      if (command.light === 'green') {
        nextNote.progress_note = appendLine(nextNote.progress_note || '', command.reason);
      } else {
        const supplement = parseSupplementNote(nextNote.urgent_note);
        nextNote.urgent_note = serializeSupplementNote(
          supplement.shootingNote,
          appendLine(supplement.companyHelp, command.reason),
        );
      }
    }
    await upsertClientWeeklyNote(userId, nextNote);
    await sendTelegram(chatId, `已將【${command.clientName}】改為${lightLabel(command.light)}${command.reason ? '，並記下原因。' : '。'}`);
    return true;
  }

  if (command.field === 'current_status') {
    nextNote.current_status = command.text;
  } else if (command.field === 'shooting_note') {
    const supplement = parseSupplementNote(nextNote.urgent_note);
    nextNote.urgent_note = serializeSupplementNote(
      appendLine(supplement.shootingNote, command.text),
      supplement.companyHelp,
    );
  } else if (command.field === 'urgent_note') {
    const supplement = parseSupplementNote(nextNote.urgent_note);
    nextNote.urgent_note = serializeSupplementNote(
      supplement.shootingNote,
      appendLine(supplement.companyHelp, command.text),
    );
  } else {
    nextNote[command.field] = appendLine(nextNote[command.field] || '', command.text);
  }
  await upsertClientWeeklyNote(userId, nextNote);
  const fieldLabels: Record<NoteField, string> = {
    current_status: '目前狀態',
    progress_note: '本週進度',
    next_week_note: '下週推進',
    shooting_note: '待拍攝內容',
    urgent_note: '需公司判斷或協辦',
  };
  const fieldLabel = fieldLabels[command.field];
  await sendTelegram(chatId, `已加入【${command.clientName}】的${fieldLabel}。`);
  return true;
}

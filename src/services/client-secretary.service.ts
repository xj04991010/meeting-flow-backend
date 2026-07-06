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

type NoteField = 'progress_note' | 'next_week_note' | 'urgent_note';

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
  return value.trim().replace(/\s+/g, ' ');
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
    { pattern: /^(?:本週|本周|本週進度|本周進度)\s*[:：]?\s*/i, field: 'progress_note' },
    { pattern: /^(?:下週|下周|下週進度|下周進度|下週推進|下周推進)\s*[:：]?\s*/i, field: 'next_week_note' },
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
      const dueText = dueToday.length
        ? dueToday.map((link) => link.label).join('、')
        : note.urgent_note || '需持續追蹤';
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
    const counts = `毛片 ${currentNote.raw_count || 0}｜成片 ${currentNote.edited_count || 0}｜已排程 ${currentNote.scheduled_count || 0}｜本月未拍 ${currentNote.unshot_count || 0}`;
    await sendTelegram(
      chatId,
      `【${command.clientName}】${lightLabel(currentNote.traffic_light)}\n`
      + `本週：${currentNote.progress_note || '尚未更新'}\n`
      + `下週：${currentNote.next_week_note || '尚未更新'}\n`
      + `協辦：${currentNote.urgent_note || '無'}\n`
      + counts,
    );
    return true;
  }

  const nextNote = copyNoteForWeek(command.clientName, weekKey, currentNote);
  if (command.type === 'set_light') {
    nextNote.traffic_light = command.light;
    if (command.reason) {
      const field = command.light === 'green' ? 'progress_note' : 'urgent_note';
      nextNote[field] = nextNote[field]
        ? `${nextNote[field]}\n${command.reason}`
        : command.reason;
    }
    await upsertClientWeeklyNote(userId, nextNote);
    await sendTelegram(chatId, `已將【${command.clientName}】改為${lightLabel(command.light)}${command.reason ? '，並記下原因。' : '。'}`);
    return true;
  }

  nextNote[command.field] = nextNote[command.field]
    ? `${nextNote[command.field]}\n${command.text}`
    : command.text;
  await upsertClientWeeklyNote(userId, nextNote);
  const fieldLabel = command.field === 'progress_note'
    ? '本週進度'
    : command.field === 'next_week_note'
      ? '下週進度'
      : '緊急事項或協辦';
  await sendTelegram(chatId, `已加入【${command.clientName}】的${fieldLabel}。`);
  return true;
}

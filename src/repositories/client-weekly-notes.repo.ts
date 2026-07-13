import { supabase } from '../utils/db';

export type ClientNoteField = 'progress' | 'nextPush' | 'companyHelp';

export type ClientDateLink = {
  id: string;
  label: string;
  date: string;
  source?: string;
  field?: ClientNoteField;
};

export type ClientCalendarDateLink = ClientDateLink & {
  client_name: string;
};

export type ClientWeeklyNoteData = {
  client_name: string;
  week_key: string;
  traffic_light?: 'green' | 'yellow' | 'red';
  current_status?: string;
  progress_note?: string;
  next_week_note?: string;
  urgent_note?: string;
  raw_count?: number;
  edited_count?: number;
  scheduled_count?: number;
  unshot_count?: number;
  date_links?: ClientDateLink[];
};

const OPTIONAL_NOTE_FIELDS = [
  'traffic_light',
  'current_status',
  'progress_note',
  'next_week_note',
  'urgent_note',
  'raw_count',
  'edited_count',
  'scheduled_count',
  'unshot_count',
  'date_links',
] as const;

export function buildClientWeeklyNotePayload(userId: string, data: ClientWeeklyNoteData) {
  const clientName = data.client_name?.trim();
  const weekKey = data.week_key?.trim();
  if (!clientName || !weekKey) {
    throw new Error('client_name and week_key are required');
  }

  const payload: Record<string, unknown> = {
    user_id: userId,
    client_name: clientName,
    week_key: weekKey,
  };

  for (const field of OPTIONAL_NOTE_FIELDS) {
    const value = data[field];
    if (value !== undefined) payload[field] = value;
  }

  return payload;
}

export async function upsertClientWeeklyNote(userId: string, data: ClientWeeklyNoteData) {
  const payload = buildClientWeeklyNotePayload(userId, data);

  const { data: result, error } = await supabase
    .from('client_weekly_notes')
    .upsert(payload, { onConflict: 'user_id,client_name,week_key' })
    .select()
    .single();

  if (error) {
    console.error('Error upserting client weekly note:', error);
    throw error;
  }
  return result;
}

export async function getClientWeeklyNotes(userId: string, weekKey: string) {
  const { data, error } = await supabase
    .from('client_weekly_notes')
    .select('*')
    .eq('user_id', userId)
    .eq('week_key', weekKey);

  if (error) {
    console.error('Error fetching client weekly notes:', error);
    throw error;
  }
  return data;
}

export async function getClientWeeklyNoteWeeks(userId: string, limit = 24) {
  const { data, error } = await supabase
    .from('client_weekly_notes')
    .select('week_key')
    .eq('user_id', userId)
    .order('week_key', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Error fetching client weekly note weeks:', error);
    throw error;
  }

  const weeks = (data || [])
    .map((row) => row.week_key)
    .filter((value): value is string => typeof value === 'string');
  return [...new Set(weeks)].slice(0, limit);
}

export async function getClientLatestNote(userId: string, clientName: string) {
  const { data, error } = await supabase
    .from('client_weekly_notes')
    .select('*')
    .eq('user_id', userId)
    .eq('client_name', clientName)
    .order('week_key', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching latest client note:', error);
    throw error;
  }
  return data;
}

export async function getLatestNotesForAllClients(userId: string) {
  const { data, error } = await supabase
    .from('client_weekly_notes')
    .select('*')
    .eq('user_id', userId)
    .order('week_key', { ascending: false })
    .limit(300);

  if (error) {
    console.error('Error fetching latest notes for all clients:', error);
    throw error;
  }
  
  const latestNotes = new Map<string, any>();
  if (data) {
    for (const row of data) {
      if (!latestNotes.has(row.client_name)) {
        latestNotes.set(row.client_name, row);
      }
    }
  }
  return Array.from(latestNotes.values());
}

export function collectClientDateLinksForMonth(
  notes: Array<Record<string, any>>,
  month: string,
): ClientCalendarDateLink[] {
  const result: ClientCalendarDateLink[] = [];
  for (const note of notes) {
    const clientName = String(note.client_name || '未分類客戶');
    const links = Array.isArray(note.date_links) ? note.date_links : [];
    for (const link of links) {
      if (!link?.date || !String(link.date).startsWith(`${month}-`)) continue;
      result.push({
        id: String(link.id || `${clientName}-${link.date}-${result.length}`),
        label: String(link.label || '未命名日期'),
        date: String(link.date),
        source: typeof link.source === 'string' ? link.source : undefined,
        field: link.field === 'progress' || link.field === 'nextPush' || link.field === 'companyHelp'
          ? link.field
          : undefined,
        client_name: clientName,
      });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getClientDateLinksForMonth(userId: string, month: string) {
  const notes = await getLatestNotesForAllClients(userId);
  return collectClientDateLinksForMonth(notes, month);
}

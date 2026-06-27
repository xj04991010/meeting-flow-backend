import { supabase } from '../utils/db';

export type ClientWeeklyNoteData = {
  id?: string;
  user_id?: string;
  client_name: string;
  week_key: string;
  traffic_light?: 'green' | 'yellow' | 'red';
  current_status?: string;
  progress_note?: string;
  next_week_note?: string;
  urgent_note?: string;
  date_links?: any[];
};

export async function upsertClientWeeklyNote(userId: string, data: ClientWeeklyNoteData) {
  // If id is provided, we update. Otherwise we upsert by unique constraint (user_id, client_name, week_key).
  const payload = {
    ...data,
    user_id: userId,
  };

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

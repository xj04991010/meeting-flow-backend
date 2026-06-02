import { supabase } from '../utils/db';

export interface UserSettings {
  ai_provider: string;
  ai_model: string;
  api_key: string;
}

export async function getUserSettings(userId: string): Promise<UserSettings | null> {
  const { data } = await supabase.from('users').select('ai_provider, ai_model, api_key').eq('id', userId).single();
  if (!data || !data.api_key) return null;
  return data as UserSettings;
}

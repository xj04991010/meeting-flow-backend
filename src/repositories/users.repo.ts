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

export async function getOrCreateUser(telegramChatId: number): Promise<string> {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_chat_id', telegramChatId)
    .maybeSingle();

  if (user) return user.id;

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ telegram_chat_id: telegramChatId })
    .select('id')
    .single();

  if (error) throw error;
  return newUser.id;
}

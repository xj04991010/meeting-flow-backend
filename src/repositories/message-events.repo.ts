import { supabase } from '../utils/db';

export async function markTelegramUpdateReceived(updateId: number): Promise<{ duplicated: boolean }> {
  const { error } = await supabase
    .from('message_events')
    .insert({ telegram_update_id: updateId });

  // PostgreSQL unique constraint violation error code is 23505
  if (error?.code === '23505') {
    return { duplicated: true };
  }

  if (error) {
    console.error('markTelegramUpdateReceived error:', error);
    throw error;
  }

  return { duplicated: false };
}

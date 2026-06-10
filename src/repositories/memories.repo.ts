import { supabase } from '../utils/db';
import { hasMeaningfulText } from './tasks.repo';

export async function insertMemories(userId: string, batchId: string | null, memories: string[]) {
  if (!memories || memories.length === 0) return 0;
  const rows = memories.filter(hasMeaningfulText).map(content => ({
    user_id: userId,
    content: content.trim(),
    source_batch_id: batchId
  }));
  if (rows.length === 0) return 0;
  
  const { error } = await supabase.from('memories').insert(rows);
  if (!error) return rows.length;

  if (error.code === '42703' || /source_batch_id/.test(error.message || '')) {
    const fallbackRows = rows.map(({ user_id, content }) => ({ user_id, content }));
    const fallback = await supabase.from('memories').insert(fallbackRows);
    if (fallback.error) console.error('insertMemories fallback error', fallback.error);
    return rows.length;
  }

  console.error('insertMemories error', error);
  return rows.length;
}

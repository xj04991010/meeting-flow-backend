import { supabase } from '../utils/db';
import { hasMeaningfulText } from './tasks.repo';

export async function insertMemories(userId: string, memories: string[]) {
  if (!memories || memories.length === 0) return 0;
  const rows = memories.filter(hasMeaningfulText).map(content => ({
    user_id: userId,
    content: content.trim()
  }));
  if (rows.length === 0) return 0;
  
  const { error } = await supabase.from('memories').insert(rows);
  if (error) console.error('insertMemories error', error);
  return rows.length;
}

import { supabase } from '../utils/db';
import { PARSER_VERSION } from '../utils/env';

export async function createSourceBatch(userId: string, rawText: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('source_batches')
    .insert({
      user_id: userId,
      source_type: 'telegram',
      raw_text: rawText,
      parser_version: PARSER_VERSION,
      status: 'pending' // new status field to track AI extraction state
    })
    .select('id')
    .single();

  if (error) {
    console.error('createSourceBatch error:', error);
    return null;
  }
  return data.id;
}

export async function updateSourceBatchSummary(batchId: string, aiSummary: string) {
  await supabase
    .from('source_batches')
    .update({ summary: aiSummary, status: 'completed' })
    .eq('id', batchId);
}

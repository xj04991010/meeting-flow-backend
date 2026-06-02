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

export async function updateSourceBatchSummary(batchId: string, aiSummary: string, output?: any) {
  const updatePayload: any = { summary: aiSummary, status: 'completed' };

  if (output && output.type === 'SUCCESS') {
    const taskCount = output.tasks?.length || 0;
    const eventCount = output.events?.length || 0;
    const reviewCount = [
      ...(output.tasks || []).map((t: any) => t.needs_review),
      ...(output.events || []).map((e: any) => e.needs_review)
    ].filter(Boolean).length;

    updatePayload.metadata = {
      task_count: taskCount,
      event_count: eventCount,
      review_count: reviewCount,
      unresolved_notes: output.prep_gap_notes || []
    };
  }

  await supabase
    .from('source_batches')
    .update(updatePayload)
    .eq('id', batchId);
}

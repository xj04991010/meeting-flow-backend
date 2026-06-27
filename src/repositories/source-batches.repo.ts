import { supabase } from '../utils/db';
import { PARSER_VERSION } from '../utils/env';
import { hasMeaningfulText, makeReviewFlag, normalizeConfidence } from './tasks.repo';

export async function createSourceBatch(userId: string, rawText: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('source_batches')
    .insert({
      user_id: userId,
      source_type: 'telegram',
      raw_text: rawText,
      parser_version: PARSER_VERSION
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
  const updatePayload: any = { summary: aiSummary };

  if (output && output.type === 'SUCCESS') {
    const taskCount = output.tasks?.length || 0;
    const eventCount = output.events?.length || 0;
    const reviewCount = taskCount + eventCount + (output.prep_gap_notes?.length || 0);

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

export async function getLatestSourceBatch(userId: string) {
  const { data } = await supabase
    .from('source_batches')
    .select('id, summary, raw_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function createSourceBatchV1(userId: string, rawText: string, result: any): Promise<string | null> {
  const taskCount = result.tasks?.length || 0;
  const eventCount = result.events?.length || 0;
  const reviewTaskCount = (result.tasks || []).filter((task: any) => (
    hasMeaningfulText(task.title)
    && makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)
  )).length;
  const reviewEventCount = (result.events || []).filter((event: any) => (
    hasMeaningfulText(event.title)
    && makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time))
  )).length;
  const unresolvedNotes = (result.unresolved_notes || []).filter((note: unknown) => hasMeaningfulText(note));
  const reviewCount = reviewTaskCount + reviewEventCount + unresolvedNotes.length;

  const { data, error } = await supabase
    .from('source_batches')
    .insert({
      user_id: userId,
      source_type: 'telegram',
      raw_text: rawText,
      parser_version: PARSER_VERSION,
      summary: result.reply_message || null,
      metadata: {
        task_count: taskCount,
        event_count: eventCount,
        review_count: reviewCount,
        unresolved_notes: unresolvedNotes
      }
    })
    .select('id')
    .single();

  if (error) {
    console.error('createSourceBatchV1 error', error);
    return null;
  }
  return data.id;
}

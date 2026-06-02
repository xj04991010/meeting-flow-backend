import { supabase } from '../utils/db';
import { AiExtractionOutput } from '../schemas/ai-output.schema';

export async function insertAiCandidates(userId: string, batchId: string, output: AiExtractionOutput) {
  const rows = [];

  for (const task of output.tasks) {
    rows.push({
      user_id: userId,
      source_batch_id: batchId,
      candidate_type: 'TASK',
      payload: task,
      confidence: output.confidence,
      status: 'pending'
    });
  }

  for (const event of output.events) {
    rows.push({
      user_id: userId,
      source_batch_id: batchId,
      candidate_type: 'EVENT',
      payload: event,
      confidence: output.confidence,
      status: 'pending'
    });
  }

  for (const memory of output.memories) {
    rows.push({
      user_id: userId,
      source_batch_id: batchId,
      candidate_type: 'MEMORY',
      payload: memory,
      confidence: output.confidence,
      status: 'pending'
    });
  }

  if (rows.length > 0) {
    const { error } = await supabase.from('ai_candidates').insert(rows);
    if (error) {
      console.error('insertAiCandidates error:', error);
      throw error;
    }
  }

  return rows.length;
}

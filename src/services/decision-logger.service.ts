import { supabase } from '../utils/db';

export type DecisionFeedback = 'accepted' | 'edited' | 'rejected' | 'ignored';

export async function createDecisionLog(params: {
  userId: string;
  sourceBatchId?: string | null;
  decisionType: string;
  inputText: string;
  selectedMemories?: any[];
  outputJson: any;
  model: string;
  confidence?: number;
}): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('decision_logs')
      .insert({
        user_id: params.userId,
        source_batch_id: params.sourceBatchId || null,
        decision_type: params.decisionType,
        input_text: params.inputText,
        selected_memories: params.selectedMemories || [],
        output_json: params.outputJson,
        model: params.model,
        confidence: params.confidence || 0.8
      })
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create decision log:', error);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error('Exception creating decision log:', err);
    return null;
  }
}

export async function updateDecisionLog(
  logId: string,
  feedback: DecisionFeedback
): Promise<void> {
  try {
    await supabase
      .from('decision_logs')
      .update({ user_feedback: feedback })
      .eq('id', logId);
  } catch (err) {
    console.error('Exception updating decision log:', err);
  }
}

export async function updateDecisionLogByBatchId(
  sourceBatchId: string,
  feedback: DecisionFeedback
): Promise<void> {
  try {
    await supabase
      .from('decision_logs')
      .update({ user_feedback: feedback })
      .eq('source_batch_id', sourceBatchId);
  } catch (err) {
    console.error('Exception updating decision log by batch id:', err);
  }
}

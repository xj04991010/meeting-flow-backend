import { supabase } from '../utils/db';
import { updateDecisionLogByBatchId } from './decision-logger.service';

export async function saveUserFeedback(params: {
  userId: string;
  decisionLogId: string;
  feedbackType: 'accepted' | 'edited' | 'rejected' | 'ignored';
  originalPayload: any;
  finalPayload?: any;
  diff?: any;
}) {
  try {
    const { error } = await supabase.from('user_feedback').insert({
      user_id: params.userId,
      decision_log_id: params.decisionLogId,
      feedback_type: params.feedbackType,
      original_payload: params.originalPayload,
      final_payload: params.finalPayload,
      diff: params.diff
    });
    if (error) throw error;
  } catch (err) {
    console.error('Error saving user feedback:', err);
  }
}

export async function learnFromEdit(decisionLogId: string, diff: any) {
  // This is a placeholder for actual learning logic which might involve:
  // 1. Finding matching playbook rules that were applied
  // 2. Adjusting their weights if the user edited fields those rules generated
  console.log(`Learning from edit for decision log ${decisionLogId}:`, diff);
  // Future implementation:
  // await updateRuleWeight(ruleId, -0.1);
}

export async function getAccuracyStats(userId: string) {
  try {
    const { data, error } = await supabase
      .from('user_feedback')
      .select('feedback_type')
      .eq('user_id', userId);
      
    if (error || !data) return { total: 0, accuracy: 0 };
    
    const total = data.length;
    if (total === 0) return { total: 0, accuracy: 0 };
    
    const acceptedCount = data.filter(d => d.feedback_type === 'accepted').length;
    return {
      total,
      acceptedCount,
      accuracy: acceptedCount / total
    };
  } catch (err) {
    console.error('Error getting accuracy stats:', err);
    return { total: 0, accuracy: 0 };
  }
}

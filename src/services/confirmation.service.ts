import { supabase } from '../utils/db';
import { sendTelegram, editTelegramMessage, answerCallbackQuery } from './telegram.service';
import { updateSourceBatchSummary } from '../repositories/source-batches.repo';

export async function processConfirmationJob(userId: string, chatId: number, callbackId: string, data: string, messageId: number) {
  try {
    const [action, batchId] = data.split(':');

    if (!batchId) {
      await answerCallbackQuery(callbackId, 'Invalid callback data.');
      return;
    }

    if (action === 'ignore') {
      const { data: ignoredCandidates } = await supabase.from('ai_candidates').select('*').eq('source_batch_id', batchId);
      
      await supabase.from('ai_candidates').update({ status: 'ignored' }).eq('source_batch_id', batchId);
      await updateSourceBatchSummary(batchId, 'Ignored by user.');
      
      if (ignoredCandidates) {
        const evalLogs = ignoredCandidates.map(c => ({
          user_id: userId,
          source_batch_id: batchId,
          original_candidate: c.payload,
          final_action: 'ignored'
        }));
        await supabase.from('ai_evaluations').insert(evalLogs);
      }
      
      await editTelegramMessage(chatId, messageId, '🗑️ 此批次的解析結果已全數捨棄。');
      await answerCallbackQuery(callbackId, '已捨棄。');
      return;
    }

    if (action === 'confirm_all') {
      // 1. Fetch all pending candidates for this batch
      const { data: candidates, error } = await supabase
        .from('ai_candidates')
        .select('*')
        .eq('source_batch_id', batchId)
        .eq('status', 'pending');

      if (error || !candidates || candidates.length === 0) {
        await answerCallbackQuery(callbackId, '找不到待確認的項目，或已確認過。');
        return;
      }

      // 2. Process and write to formal tables
      for (const candidate of candidates) {
        const payload = candidate.payload as any;

        if (candidate.candidate_type === 'TASK') {
          await supabase.from('tasks').insert({
            user_id: userId,
            source_batch_id: batchId,
            title: payload.title,
            deadline: payload.due_at,
            priority: payload.priority || 'medium',
            category: payload.category || '其他',
            status: 'pending',
            confidence: candidate.confidence,
            needs_review: false
          });
        } else if (candidate.candidate_type === 'EVENT') {
          await supabase.from('calendar_intents').insert({
            user_id: userId,
            source_batch_id: batchId,
            title: payload.title,
            start_time: payload.start_at,
            end_time: payload.end_at,
            action_type: 'propose_create',
            status: 'ready',
            sync_status: 'ready',
            confidence: candidate.confidence,
            needs_review: false
          });
        } else if (candidate.candidate_type === 'MEMORY') {
          await supabase.from('memories').insert({
            user_id: userId,
            content: payload.content,
            importance: payload.importance || 5,
            memory_type: payload.memory_type || null,
            entity_type: payload.entity_type || null,
            evidence_text: payload.evidence_text || null,
            source_batch_id: batchId
          });
        }

        // Mark candidate as confirmed
        await supabase.from('ai_candidates').update({ status: 'confirmed' }).eq('id', candidate.id);
      }
      
      // Save to eval dataset
      const evalLogs = candidates.map(c => ({
        user_id: userId,
        source_batch_id: batchId,
        original_candidate: c.payload,
        final_action: 'confirmed_as_is',
        final_payload: c.payload
      }));
      await supabase.from('ai_evaluations').insert(evalLogs);

      await updateSourceBatchSummary(batchId, 'Confirmed all items by user.');
      
      await editTelegramMessage(chatId, messageId, `✅ **確認完畢**\n\n已將 ${candidates.length} 個項目同步寫入正式資料庫與日曆同步佇列。`);
      await answerCallbackQuery(callbackId, '已全數確認！');
      return;
    }

    await answerCallbackQuery(callbackId, '未知的操作。');
  } catch (err: any) {
    console.error('processConfirmationJob error:', err);
    await answerCallbackQuery(callbackId, '處理失敗。');
  }
}

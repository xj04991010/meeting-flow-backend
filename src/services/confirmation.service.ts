import { supabase } from '../utils/db';
import { sendTelegram, editTelegramMessage, answerCallbackQuery } from './telegram.service';
import { updateSourceBatchSummary } from '../repositories/source-batches.repo';
import { updateDecisionLogByBatchId } from './decision-logger.service';
import { reinforceMemory, penalizeMemory } from './memory.service';

export async function processConfirmationJob(userId: string, chatId: number, callbackId: string, data: string, messageId: number) {
  try {
    if (data.startsWith('sync_batch_')) {
      const batchId = data.replace('sync_batch_', '');
      await handleConfirmBatch(userId, chatId, callbackId, batchId, messageId);
      return;
    }

    if (data.startsWith('reject_batch_')) {
      const batchId = data.replace('reject_batch_', '');
      await handleRejectBatch(userId, chatId, callbackId, batchId, messageId);
      return;
    }

    if (data.startsWith('undo_batch_')) {
      const batchId = data.replace('undo_batch_', '');
      await handleUndoBatch(userId, chatId, callbackId, batchId, messageId);
      return;
    }

    if (data.startsWith('undo_update_')) {
      const batchId = data.replace('undo_update_', '');
      await handleUndoUpdate(userId, chatId, callbackId, batchId, messageId);
      return;
    }

    if (data.startsWith('undo_delete_')) {
      const batchId = data.replace('undo_delete_', '');
      await handleUndoDelete(userId, chatId, callbackId, batchId, messageId);
      return;
    }

    if (data.startsWith('delete_task_')) {
      const taskId = data.replace('delete_task_', '');
      await supabase.from('tasks').delete().eq('id', taskId).eq('user_id', userId);
      await editTelegramMessage(chatId, messageId, `✅ 任務已成功刪除。`);
      await answerCallbackQuery(callbackId, '已刪除！');
      return;
    }

    if (data.startsWith('del_all_kw_')) {
      const keyword = data.replace('del_all_kw_', '');
      await supabase.from('tasks').delete().eq('user_id', userId).ilike('title', `%${keyword}%`);
      await editTelegramMessage(chatId, messageId, `✅ 所有包含「${keyword}」的任務已成功刪除。`);
      await answerCallbackQuery(callbackId, '已全數刪除！');
      return;
    }

    if (data === 'del_all_content_confirm') {
      await supabase.from('tasks').delete().eq('user_id', userId);
      await supabase.from('calendar_intents').delete().eq('user_id', userId);
      await supabase.from('source_batches').delete().eq('user_id', userId);
      await supabase.from('memories').delete().eq('user_id', userId);
      await editTelegramMessage(chatId, messageId, `✅ 所有任務、行程與會議紀錄已全數清空。`);
      await answerCallbackQuery(callbackId, '已清空！');
      return;
    }

    if (data === 'cancel_delete') {
      await editTelegramMessage(chatId, messageId, `❌ 已取消刪除操作。`);
      await answerCallbackQuery(callbackId, '已取消');
      return;
    }

    if (data.startsWith('confirm_update_')) {
      const parts = data.split('_');
      // confirm_update_complete_taskId
      // confirm_update_reschedule_taskId_time
      const action = parts[2];
      const taskId = parts[3];
      
      if (action === 'complete') {
        await supabase.from('tasks').update({ status: 'completed' }).eq('id', taskId).eq('user_id', userId);
        await editTelegramMessage(chatId, messageId, `✅ 任務已標記為完成。`);
        await answerCallbackQuery(callbackId, '已完成！');
      } else if (action === 'reschedule') {
        const newTime = parts.slice(4).join('_'); // just in case time has underscores
        await supabase.from('tasks').update({ deadline: newTime }).eq('id', taskId).eq('user_id', userId);
        await editTelegramMessage(chatId, messageId, `✅ 任務已成功改期。`);
        await answerCallbackQuery(callbackId, '已改期！');
      }
      return;
    }

    if (data === 'cancel_update') {
      await editTelegramMessage(chatId, messageId, `❌ 已取消更新操作。`);
      await answerCallbackQuery(callbackId, '已取消');
      return;
    }

    if (data === 'view_memory') {
      await answerCallbackQuery(callbackId, '長按可查看記憶面板 (開發中)');
      return;
    }

    if (data.startsWith('postpone_task_')) {
      const taskId = data.replace('postpone_task_', '');
      const newTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('tasks').update({ deadline: newTime }).eq('id', taskId).eq('user_id', userId);
      await editTelegramMessage(chatId, messageId, `✅ 任務已延到明天。`);
      await answerCallbackQuery(callbackId, '已延到明天。');
      return;
    }
    
    // Reminders
    if (data.startsWith('remind_')) {
      const reminderPayload = data.replace('remind_', '');
      const knownOffsets = ['30m', '15m', '1h', '1d', '1w', '1m', 'tomorrow'];
      const suffix = knownOffsets.find((offset) => reminderPayload.endsWith(`_${offset}`));
      const timeAmt = suffix || reminderPayload.split('_')[0];
      const taskId = suffix
        ? reminderPayload.slice(0, -(suffix.length + 1))
        : reminderPayload.split('_').slice(1).join('_');
      let offsetMs = 0;
      if (timeAmt === '15m') offsetMs = 15 * 60 * 1000;
      if (timeAmt === '30m') offsetMs = 30 * 60 * 1000;
      if (timeAmt === '1h') offsetMs = 60 * 60 * 1000;
      if (timeAmt === '1d' || timeAmt === 'tomorrow') offsetMs = 24 * 60 * 60 * 1000;
      if (timeAmt === '1w') offsetMs = 7 * 24 * 60 * 60 * 1000;
      if (timeAmt === '1m') offsetMs = 30 * 24 * 60 * 60 * 1000;

      if (offsetMs > 0 && taskId) {
        const newTime = new Date(Date.now() + offsetMs).toISOString();
        await supabase.from('tasks').update({ deadline: newTime }).eq('id', taskId).eq('user_id', userId);
        await editTelegramMessage(chatId, messageId, `✅ 任務已成功延後！`);
        await answerCallbackQuery(callbackId, '提醒設定成功！');
      } else {
        await answerCallbackQuery(callbackId, '無效的提醒參數。');
      }
      return;
    }

    await answerCallbackQuery(callbackId, '未知的操作。');
  } catch (err: any) {
    console.error('processConfirmationJob error:', err);
    await answerCallbackQuery(callbackId, '處理失敗。');
  }
}

async function verifyBatchOwnership(batchId: string, userId: string) {
  const { data } = await supabase.from('source_batches').select('user_id').eq('id', batchId).single();
  return data && data.user_id === userId;
}

async function insertMemoryCandidate(userId: string, batchId: string, payload: any) {
  const row = {
    user_id: userId,
    content: payload.content,
    importance: payload.importance || 5,
    memory_type: payload.memory_type || null,
    entity_type: payload.entity_type || null,
    evidence_text: payload.evidence_text || null,
    source_batch_id: batchId
  };

  const { error } = await supabase.from('memories').insert(row);
  if (!error) return;

  if (error.code === '42703' || /(memory_type|source_batch_id)/.test(error.message || '')) {
    const fallback = await supabase.from('memories').insert({
      user_id: row.user_id,
      content: row.content,
      importance: row.importance,
      entity_type: row.entity_type,
      evidence_text: row.evidence_text
    });
    if (fallback.error) console.error('insertMemoryCandidate fallback error:', fallback.error);
    return;
  }

  console.error('insertMemoryCandidate error:', error);
}

async function handleRejectBatch(userId: string, chatId: number, callbackId: string, batchId: string, messageId: number) {
  if (!(await verifyBatchOwnership(batchId, userId))) {
    await answerCallbackQuery(callbackId, '無權限操作此項目。');
    return;
  }
  const { data: ignoredCandidates } = await supabase.from('ai_candidates').select('*').eq('source_batch_id', batchId);
  
  await supabase.from('ai_candidates').update({ status: 'ignored' }).eq('source_batch_id', batchId);
  
  // V3 Flow: Tasks and Intents are inserted immediately, so we must delete them on reject
  await supabase.from('tasks').delete().eq('source_batch_id', batchId).eq('user_id', userId);
  await supabase.from('calendar_intents').delete().eq('source_batch_id', batchId).eq('user_id', userId);
  await supabase.from('memories').delete().eq('source_batch_id', batchId).eq('user_id', userId);

  await updateSourceBatchSummary(batchId, 'Ignored by user.');
  
  if (ignoredCandidates) {
    const { data: dLog } = await supabase.from('decision_logs').select('id, selected_memories').eq('source_batch_id', batchId).single();
    if (dLog) {
      await updateDecisionLogByBatchId(batchId, 'rejected');
      if (dLog.selected_memories) {
        for (const memId of dLog.selected_memories) {
          await penalizeMemory(memId);
        }
      }
      
      const feedbackLogs = ignoredCandidates.map(c => ({
        user_id: userId,
        decision_log_id: dLog.id,
        feedback_type: 'rejected',
        original_payload: c.payload,
        final_payload: null
      }));
      await supabase.from('user_feedback').insert(feedbackLogs);
    }
  }
  
  await editTelegramMessage(chatId, messageId, '🗑️ 辨識錯誤，已將此草稿銷毀不留痕跡。');
  await answerCallbackQuery(callbackId, '已乾淨銷毀。');
}

async function handleConfirmBatch(userId: string, chatId: number, callbackId: string, batchId: string, messageId: number) {
  if (!(await verifyBatchOwnership(batchId, userId))) {
    await answerCallbackQuery(callbackId, '無權限操作此項目。');
    return;
  }
  const { data: candidates, error } = await supabase
    .from('ai_candidates')
    .select('*')
    .eq('source_batch_id', batchId)
    .eq('status', 'pending');

  if (error || !candidates || candidates.length === 0) {
    // Check if there are direct tasks/events for this batch (V3 flow without candidates)
    const { syncBatchInternal } = await import('../google');
    const result = await syncBatchInternal(userId);
    if ('error' in result && result.code === 'NOT_AUTHORIZED') {
      await answerCallbackQuery(callbackId, 'Google Calendar 尚未授權。');
      return;
    }
    await editTelegramMessage(chatId, messageId, `✅ **同步完畢**\n\n已成功將待處理事項同步至 Google 日曆。`);
    await answerCallbackQuery(callbackId, '已同步！');
    return;
  }

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
      await insertMemoryCandidate(userId, batchId, payload);
    } else if (candidate.candidate_type === 'UPDATE_TASK') {
      if (payload.action === 'complete') {
        await supabase.from('tasks').update({ status: 'completed' }).eq('id', payload.task_id).eq('user_id', userId);
      } else if (payload.action === 'reschedule') {
        await supabase.from('tasks').update({ deadline: payload.new_deadline }).eq('id', payload.task_id).eq('user_id', userId);
      }
    } else if (candidate.candidate_type === 'DELETE_TASK') {
      if (payload.delete_all) {
        await supabase.from('tasks').delete().eq('user_id', userId).in('id', payload.task_ids);
      } else {
        await supabase.from('tasks').delete().eq('id', payload.task_id).eq('user_id', userId);
      }
    }

    await supabase.from('ai_candidates').update({ status: 'confirmed' }).eq('id', candidate.id);
  }
  
  const { data: dLog } = await supabase.from('decision_logs').select('id, selected_memories').eq('source_batch_id', batchId).single();
  if (dLog) {
    await updateDecisionLogByBatchId(batchId, 'accepted');
    if (dLog.selected_memories) {
      for (const memId of dLog.selected_memories) {
        await reinforceMemory(memId);
      }
    }
    
    const feedbackLogs = candidates.map(c => ({
      user_id: userId,
      decision_log_id: dLog.id,
      feedback_type: 'accepted',
      original_payload: c.payload,
      final_payload: c.payload
    }));
    await supabase.from('user_feedback').insert(feedbackLogs);
  }

  await updateSourceBatchSummary(batchId, 'Confirmed all items by user.');
  
  await editTelegramMessage(chatId, messageId, `✅ **確認完畢**\n\n已將 ${candidates.length} 個項目同步寫入正式資料庫與日曆同步佇列。`);
  await answerCallbackQuery(callbackId, '已全數確認！');
}

export async function autoConfirmBatch(userId: string, batchId: string, chatId: number) {
  console.warn('autoConfirmBatch is disabled. Batch must be confirmed explicitly by the user.', { userId, batchId, chatId });
  return false;
}

async function handleUndoBatch(userId: string, chatId: number, callbackId: string, batchId: string, messageId: number) {
  if (!(await verifyBatchOwnership(batchId, userId))) {
    await answerCallbackQuery(callbackId, '無權限操作此項目。');
    return;
  }
  await supabase.from('tasks').delete().eq('source_batch_id', batchId).eq('user_id', userId);
  await supabase.from('calendar_intents').delete().eq('source_batch_id', batchId).eq('user_id', userId);
  await supabase.from('memories').delete().eq('source_batch_id', batchId).eq('user_id', userId);
  
  const { data: dLog } = await supabase.from('decision_logs').select('id, selected_memories').eq('source_batch_id', batchId).single();
  if (dLog) {
    await updateDecisionLogByBatchId(batchId, 'rejected');
    if (dLog.selected_memories) {
      for (const memId of dLog.selected_memories) {
        await penalizeMemory(memId);
      }
    }
  }
  
  await supabase.from('ai_candidates').update({ status: 'ignored' }).eq('source_batch_id', batchId);
  await updateSourceBatchSummary(batchId, 'Undone by user.');

  await editTelegramMessage(chatId, messageId, '↩️ 已撤銷本次新增，資料已乾淨清除。');
  await answerCallbackQuery(callbackId, '撤銷成功！');
}

async function handleUndoUpdate(userId: string, chatId: number, callbackId: string, batchId: string, messageId: number) {
  if (!(await verifyBatchOwnership(batchId, userId))) {
    await answerCallbackQuery(callbackId, '無權限操作此項目。');
    return;
  }
  const { data: candidates } = await supabase.from('ai_candidates').select('*').eq('source_batch_id', batchId).eq('candidate_type', 'UNDO_UPDATE_TASK');
  if (candidates && candidates.length > 0) {
    for (const c of candidates) {
      const p = c.payload as any;
      if (p.old_status) {
        await supabase.from('tasks').update({ status: p.old_status }).eq('id', p.task_id).eq('user_id', userId);
      } else if (p.old_deadline) {
        await supabase.from('tasks').update({ deadline: p.old_deadline }).eq('id', p.task_id).eq('user_id', userId);
      }
    }
    await supabase.from('ai_candidates').update({ status: 'ignored' }).eq('source_batch_id', batchId);
  }
  await editTelegramMessage(chatId, messageId, '↩️ 已撤銷修改，任務恢復原狀。');
  await answerCallbackQuery(callbackId, '撤銷修改成功！');
}

async function handleUndoDelete(userId: string, chatId: number, callbackId: string, batchId: string, messageId: number) {
  if (!(await verifyBatchOwnership(batchId, userId))) {
    await answerCallbackQuery(callbackId, '無權限操作此項目。');
    return;
  }
  const { data: candidates } = await supabase.from('ai_candidates').select('*').eq('source_batch_id', batchId).eq('candidate_type', 'UNDO_DELETE_TASK');
  if (candidates && candidates.length > 0) {
    for (const c of candidates) {
      const p = c.payload as any;
      if (p.task) {
        await supabase.from('tasks').insert(p.task);
      }
    }
    await supabase.from('ai_candidates').update({ status: 'ignored' }).eq('source_batch_id', batchId);
  }
  await editTelegramMessage(chatId, messageId, '♻️ 已復原刪除，任務滿血復活。');
  await answerCallbackQuery(callbackId, '復原刪除成功！');
}

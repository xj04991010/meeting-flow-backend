import { supabase } from '../utils/db';
import { sendTelegram, sendThinkingMessage, editTelegramMessage, answerCallbackQuery } from './telegram.service';
import { getOrCreateUser } from '../repositories/users.repo';
import { getDashboardUrl } from '../utils/env';
import { syncBatchInternal } from '../google';
import { getLatestSourceBatch, updateSourceBatchSummary } from '../repositories/source-batches.repo';
import { extractMeetingData, extractSupplementData, persistExtraction, buildTelegramSummary } from './message-handler.service';

export async function handleCallbackQuery(callback: any) {
  const data = callback.data;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const originalText = callback.message?.text || '';

  if (data && data.startsWith('remind_')) {
    const parts = data.split('_');
    const taskId = parts[1];
    const offsetStr = parts.slice(2).join('_');
    
    let targetTime = new Date();
    let displayTime = '';
    
    if (offsetStr === '30m') {
      targetTime.setMinutes(targetTime.getMinutes() + 30);
      displayTime = '30分鐘後';
    } else if (offsetStr === '1d') {
      targetTime.setDate(targetTime.getDate() + 1);
      displayTime = '明天';
    } else if (offsetStr === '1w') {
      targetTime.setDate(targetTime.getDate() + 7);
      displayTime = '下週';
    } else if (offsetStr === '1m') {
      targetTime.setMonth(targetTime.getMonth() + 1);
      displayTime = '一個月後';
    }

    const { error } = await supabase.from('tasks').update({
      deadline: targetTime.toISOString()
    }).eq('id', taskId);

    if (!error) {
      await answerCallbackQuery(callback.id, `已設定提醒：${displayTime}`);
      
      const newText = originalText + `\n\n✅ 已設定推播提醒：${displayTime}`;
      await editTelegramMessage(chatId, messageId, newText, [[{ text: '打開 Dashboard 修改', url: getDashboardUrl() }]]);
    } else {
      await answerCallbackQuery(callback.id, '設定失敗，請稍後再試。');
    }
    return;
  }

  if (data && data.startsWith('postpone_task_')) {
    const taskId = data.replace('postpone_task_', '');
    
    // Set to tomorrow 9 AM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const { error } = await supabase.from('tasks').update({
      deadline: tomorrow.toISOString()
    }).eq('id', taskId);

    if (!error) {
      await answerCallbackQuery(callback.id, '✅ 已為您延後至明天早上 9 點');
      const newText = originalText + `\n\n*(✔️ 已幫您延後至明天早上)*`;
      await editTelegramMessage(chatId, messageId, newText, []); // Remove buttons
    } else {
      await answerCallbackQuery(callback.id, '設定失敗，請稍後再試。');
    }
    return;
  }

  if (data && data.startsWith('sync_batch_')) {
    const batchId = data.replace('sync_batch_', '');
    
    // 1. Set all tasks to pending (removing needs_review flag)
    await supabase.from('tasks').update({ needs_review: false, status: 'pending' }).eq('source_batch_id', batchId).eq('needs_review', true);
    
    // 2. Set all events to ready
    await supabase.from('calendar_intents').update({ needs_review: false, sync_status: 'ready', status: 'ready' }).eq('source_batch_id', batchId).eq('needs_review', true);
    
    // 3. Trigger sync-batch API internally
    const { data: user } = await supabase.from('users').select('id').eq('telegram_chat_id', chatId).maybeSingle();
    if (user) {
       try {
         await syncBatchInternal(user.id);
       } catch (err) {
         console.error('Internal sync failed', err);
       }
    }

    // 4. Update message to remove the button and reflect sync status
    await answerCallbackQuery(callback.id, '✅ 已全部確認並嘗試同步！');
    const newText = originalText
      .replace('⚠️ **狀態：等待人工二次確認**', '✅ **狀態：已全部授權同步**')
      .replace('所有擷取的項目目前皆設為「待審閱」，請點擊下方按鈕前往 Dashboard 進行確認，確認後才會同步至您的 Google 日曆。', '所有行程已排入同步佇列！');
      
    await editTelegramMessage(chatId, messageId, newText, [[{ text: '打開 Dashboard 修改細節', url: getDashboardUrl() }]]);
    return;
  }

  if (data && data.startsWith('del_all_kw_')) {
    const keyword = data.replace('del_all_kw_', '');
    const { data: user } = await supabase.from('users').select('id').eq('telegram_chat_id', chatId).maybeSingle();
    
    if (user) {
      const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', user.id).ilike('title', `%${keyword}%`).limit(5);
      if (tasks && tasks.length > 0) {
        const ids = tasks.map(t => t.id);
        await supabase.from('tasks').delete().in('id', ids);
        await answerCallbackQuery(callback.id, `✅ 已為您刪除 ${tasks.length} 筆任務！`);
        
        const titles = tasks.map(t => `- ${t.title}`).join('\n');
        await editTelegramMessage(chatId, messageId, `✅ **已成功批次刪除以下任務：**\n\n${titles}`);
      } else {
        await answerCallbackQuery(callback.id, `找不到任務。`);
        await editTelegramMessage(chatId, messageId, `❌ 找不到相關任務，可能已被刪除。`);
      }
    }
    return;
  }

  if (data && data.startsWith('delete_task_')) {
    const taskId = data.replace('delete_task_', '');
    const { data: task } = await supabase.from('tasks').select('title').eq('id', taskId).single();
    if (task) {
      await supabase.from('tasks').delete().eq('id', taskId);
      await answerCallbackQuery(callback.id, `✅ 任務已刪除！`);
      await editTelegramMessage(chatId, messageId, `✅ 已成功為您刪除任務：「${task.title}」`);
    } else {
      await answerCallbackQuery(callback.id, `找不到該任務。`);
      await editTelegramMessage(chatId, messageId, `❌ 找不到該任務，可能已被刪除。`);
    }
    return;
  }

  if (data === 'cancel_delete') {
    await answerCallbackQuery(callback.id, `已取消操作。`);
    await editTelegramMessage(chatId, messageId, `操作已取消。`);
    return;
  }

  await answerCallbackQuery(callback.id, '新版流程已改到 Dashboard 處理。');

  if (!chatId || !messageId) return;

  await editTelegramMessage(
    chatId,
    messageId,
    '舊版逐條確認按鈕已停用。請到 Dashboard 檢查與修改批次結果。',
    [[{ text: '打開 Dashboard', web_app: { url: getDashboardUrl() } }]]
  );
}
import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { createSourceBatch } from '../../repositories/source-batches.repo';

export async function handleDeleteCommand(chatId: number, userId: string, keyword: string, thinkingId: number) {
  const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', userId).ilike('title', `%${keyword}%`).limit(5);
  
  if (tasks && tasks.length > 0) {
    const batchId = await createSourceBatch(userId, `[Batch Delete] ${keyword}`);
    if (!batchId) {
      await editTelegramMessage(chatId, thinkingId, `⚠️ 系統錯誤，無法建立刪除草稿。`);
      return;
    }

    let replyText = `⚡ **準備刪除任務** (請確認)\n\n為您找到以下包含「${keyword}」的任務：\n`;
    const candidates = [];

    tasks.forEach(t => {
      replyText += `🗑️ ${t.title}\n`;
      candidates.push({
        user_id: userId,
        source_batch_id: batchId,
        candidate_type: 'DELETE_TASK',
        payload: { task_id: t.id, delete_all: false }
      });
    });

    await supabase.from('ai_candidates').insert(candidates);

    const buttons = [
      [{ text: '✅ 確認全部刪除', callback_data: `sync_batch_${batchId}` }],
      [{ text: '❌ 撤回取消', callback_data: `reject_batch_${batchId}` }]
    ];
    
    await editTelegramMessage(chatId, thinkingId, replyText, buttons);
  } else {
    await editTelegramMessage(chatId, thinkingId, `找不到包含「${keyword}」的相關任務，請確認名稱是否正確。`);
  }
}

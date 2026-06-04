import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { createSourceBatch } from '../../repositories/source-batches.repo';

export async function handleDeleteCommand(chatId: number, userId: string, keyword: string, thinkingId: number) {
  const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', userId).ilike('title', `%${keyword}%`).limit(5);
  
  if (tasks && tasks.length > 0) {
    const batchId = await createSourceBatch(userId, `[Batch Delete] ${keyword}`);
    if (!batchId) {
      await editTelegramMessage(chatId, thinkingId, `⚠️ 系統錯誤，無法建立刪除草稿。`);
      return;
    }

    let replyText = `⚡ **已為您自動刪除任務**\n\n`;
    const candidates = [];

    for (const t of tasks) {
      replyText += `🗑️ ${t.title}\n`;
      candidates.push({
        user_id: userId,
        source_batch_id: batchId,
        candidate_type: 'UNDO_DELETE_TASK',
        payload: { task: t }
      });
      // Execute immediately
      await supabase.from('tasks').delete().eq('id', t.id).eq('user_id', userId);
    }

    await supabase.from('ai_candidates').insert(candidates);

    const buttons = [
      [{ text: '♻️ 復原刪除 (Undo)', callback_data: `undo_delete_${batchId}` }]
    ];
    
    await editTelegramMessage(chatId, thinkingId, replyText, buttons);
  } else {
    await editTelegramMessage(chatId, thinkingId, `找不到包含「${keyword}」的相關任務，請確認名稱是否正確。`);
  }
}

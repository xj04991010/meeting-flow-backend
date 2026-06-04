import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';
import { createSourceBatch } from '../../repositories/source-batches.repo';

export async function handleUpdateTasksCommand(
  chatId: number, 
  userId: string, 
  text: string, 
  updateAction: string | null, 
  newDeadlineIso: string | null, 
  thinkingId: number
) {
  const { data: tasks } = await supabase.from('tasks')
    .select('id, title, deadline, category')
    .eq('user_id', userId)
    .neq('status', 'completed')
    .limit(50);
    
  if (!tasks || tasks.length === 0) {
    await editTelegramMessage(chatId, thinkingId, `您目前沒有未完成的任務可以更新。`);
    return;
  }

  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const filterPrompt = `Current Date: ${todayStr}
The user wants to update tasks: "${text}"
Here are the user's pending tasks:
${JSON.stringify(tasks, null, 2)}

Determine which task IDs match the user's request.
Output JSON only:
{
  "task_ids_to_update": ["uuid1", "uuid2"]
}`;
  const filterContent = await callLLM(userId, [{ role: 'user', content: filterPrompt }], { type: 'json_object' });
  const parsed = JSON.parse(filterContent || '{"task_ids_to_update": []}');
  const task_ids_to_update = parsed.task_ids_to_update || [];
  
  if (!task_ids_to_update || task_ids_to_update.length === 0) {
    await editTelegramMessage(chatId, thinkingId, `找不到符合條件的任務來進行更新。`);
    return;
  }

  const matchedTasks = tasks.filter(t => task_ids_to_update.includes(t.id));
  
  if (updateAction !== 'complete' && updateAction !== 'reschedule') {
    await editTelegramMessage(chatId, thinkingId, `⚠️ 抱歉，我無法確定確切的更新時間，請再試一次。`);
    return;
  }

  // Create a batch for Undo
  const batchId = await createSourceBatch(userId, `[Batch Update] ${text}`);
  if (!batchId) {
    await editTelegramMessage(chatId, thinkingId, `⚠️ 系統錯誤，無法建立更新草稿。`);
    return;
  }

  let replyText = `⚡ **已為您自動修改任務**\n\n`;
  const candidates = [];

  for (const t of matchedTasks) {
    if (updateAction === 'complete') {
      replyText += `✅ [標記完成] ${t.title}\n`;
      candidates.push({
        user_id: userId,
        source_batch_id: batchId,
        candidate_type: 'UNDO_UPDATE_TASK',
        payload: { task_id: t.id, old_status: 'pending' }
      });
      // Execute immediately
      await supabase.from('tasks').update({ status: 'completed' }).eq('id', t.id).eq('user_id', userId);
    } else if (updateAction === 'reschedule' && newDeadlineIso) {
      const dateStr = new Date(newDeadlineIso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      replyText += `🕒 [改期至 ${dateStr}] ${t.title}\n`;
      candidates.push({
        user_id: userId,
        source_batch_id: batchId,
        candidate_type: 'UNDO_UPDATE_TASK',
        payload: { task_id: t.id, old_deadline: t.deadline }
      });
      // Execute immediately
      await supabase.from('tasks').update({ deadline: newDeadlineIso }).eq('id', t.id).eq('user_id', userId);
    }
  }

  await supabase.from('ai_candidates').insert(candidates);

  const buttons = [
    [{ text: '❌ 撤銷修改 (Undo)', callback_data: `undo_update_${batchId}` }]
  ];

  await editTelegramMessage(chatId, thinkingId, replyText, buttons);
}

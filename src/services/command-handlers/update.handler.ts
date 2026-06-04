import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

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

  if (updateAction === 'complete') {
    await supabase.from('tasks').update({ status: 'completed' }).in('id', task_ids_to_update);
    await editTelegramMessage(chatId, thinkingId, `✅ 已為您將 ${task_ids_to_update.length} 項任務標記為完成！`);
  } else if (updateAction === 'reschedule' && newDeadlineIso) {
    await supabase.from('tasks').update({ deadline: newDeadlineIso }).in('id', task_ids_to_update);
    await editTelegramMessage(chatId, thinkingId, `✅ 已為您將 ${task_ids_to_update.length} 項任務重新安排期限！`);
  } else {
    await editTelegramMessage(chatId, thinkingId, `⚠️ 抱歉，我無法確定確切的更新時間，請再試一次。`);
  }
}

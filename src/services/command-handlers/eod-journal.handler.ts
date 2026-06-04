import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleEodJournalCommand(chatId: number, userId: string, text: string, thinkingId: number) {
  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  // 1. Save journal
  await supabase.from('daily_journals').insert({
    user_id: userId,
    date: todayStr,
    content: text
  });

  // 2. Fetch pending tasks to see if any can be auto-completed
  const { data: pendingTasks } = await supabase.from('tasks')
    .select('id, title')
    .eq('user_id', userId)
    .neq('status', 'completed')
    .limit(50);

  let completedIds: string[] = [];
  if (pendingTasks && pendingTasks.length > 0) {
    const filterPrompt = `Current Date: ${todayStr}
The user provided their End-of-Day journal: "${text}"
Here are the user's pending tasks:
${JSON.stringify(pendingTasks, null, 2)}

Determine which task IDs the user EXPLICITLY mentions they have COMPLETED in their journal.
Output JSON only:
{
  "completed_task_ids": ["uuid1", "uuid2"]
}`;
    const filterContent = await callLLM(userId, [{ role: 'user', content: filterPrompt }], { type: 'json_object' });
    const parsed = JSON.parse(filterContent || '{"completed_task_ids": []}');
    completedIds = parsed.completed_task_ids || [];
    
    if (completedIds.length > 0) {
      await supabase.from('tasks').update({ status: 'completed' }).in('id', completedIds);
    }
  }

  // 3. Generate summary
  const summaryPrompt = `You are an INTJ zero-BS executive assistant.
User's EOD Journal: "${text}"
Tasks auto-completed by AI: ${completedIds.length} tasks.
Provide a brutally direct, data-driven summary acknowledging the journal has been saved for tomorrow's handover. 
If tasks were completed, mention that they have been marked complete.
Do NOT use polite fluff. Keep it under 3 lines. Use Traditional Chinese.`;

  const reply = await callLLM(userId, [{ role: 'system', content: summaryPrompt }], { type: 'text' });
  
  await editTelegramMessage(chatId, thinkingId, `📓 **[下班交接日誌]**\n\n${reply}`);
}

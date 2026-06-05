import { supabase } from '../utils/db';
import { callLLM } from './llm.service';

export async function scanMemoriesAndGenerateTasks(userId: string, simulateDateStr?: string) {
  // 1. Fetch User Memories
  const { data: memories } = await supabase.from('memories')
    .select('content, importance, entity_type')
    .eq('user_id', userId);
    
  if (!memories || memories.length === 0) return 0; // No memories to scan

  // 2. Fetch User Pending Tasks (so we don't duplicate)
  const { data: tasks } = await supabase.from('tasks')
    .select('title, deadline, created_at')
    .eq('user_id', userId)
    .neq('status', 'completed');
  
  // 3. Current Date and Lookahead
  const now = simulateDateStr ? new Date(simulateDateStr) : new Date();
  const dateStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const lookaheadStr = in14Days.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const todayIso = now.toISOString();

  // 4. Prompt
  const prompt = `You are an elite, proactive Executive Assistant. Your job is to analyze the user's Long-term Memories and proactively generate actionable tasks if there are upcoming events (e.g. Birthdays in the next 14 days) or recurring routines (e.g. beginning of the month).

Current Date: ${dateStr} (ISO: ${todayIso})
Lookahead Window: ${dateStr} to ${lookaheadStr}

USER MEMORIES:
${JSON.stringify(memories, null, 2)}

CURRENT PENDING TASKS (Do not duplicate these!):
${JSON.stringify(tasks, null, 2)}

Rules:
1. Evaluate EVERY single memory. If a memory implies a specific date (e.g. a birthday, anniversary, or a specific day of the month like "每月5號") that falls between Current Date and the end of the Lookahead Window, you MUST generate a reminder task for it.
2. Provide lead time! For example, if the event is on 10/15, generate a task today with a title like "[AI推演] 爸爸生日 (10/15) 快到了，請提前準備".
3. For monthly routines (e.g. "月初要結帳"), if today is within 3 days before or after the routine, generate the task with "[AI推演] 月初結帳" prefix.
4. DO NOT generate tasks for events outside the Lookahead Window. Wait until they are 1-14 days away.
5. DO NOT duplicate tasks. Check the titles of CURRENT PENDING TASKS carefully. If a task for this specific occurrence already exists, do not create another one.
6. Set 'due_at' to the actual deadline of the event (ISO-8601).
7. If no new tasks are needed today, output an empty array.
8. ALWAYS prefix the generated task title with "[AI推演] " so the user knows the AI proactively created it.

Output JSON only:
{
  "new_tasks": [
    {
      "title": "...",
      "due_at": "ISO-8601 or null",
      "priority": "medium",
      "category": "其他"
    }
  ]
}`;

  const content = await callLLM(userId, [{ role: 'user', content: prompt }], { type: 'json_object', temperature: 0.2 });
  if (!content) return 0;
  
  try {
    const cleanContent = content.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleanContent);
    const newTasks = parsed.new_tasks || [];

    if (newTasks.length > 0) {
      const tasksToInsert = newTasks.map((t: any) => ({
        user_id: userId,
        title: t.title,
        deadline: t.due_at,
        priority: t.priority || 'medium',
        category: t.category || '其他',
        status: 'pending',
        confidence: 1.0,
        needs_review: false,
        source_batch_id: null // System generated proactive task
      }));
      await supabase.from('tasks').insert(tasksToInsert);
    }
    
    return newTasks.length;
  } catch (err) {
    console.error('Failed to parse proactive AI output:', err, content);
    return 0;
  }
}

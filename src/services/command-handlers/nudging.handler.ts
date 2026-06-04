import { supabase } from '../../utils/db';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleNudgingCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  const { data: tasks } = await supabase.from('tasks')
    .select('id, title, category')
    .eq('user_id', userId)
    .neq('status', 'completed')
    .eq('priority', 'high')
    .gte('deadline', todayStr)
    .lt('deadline', todayStr + 'T23:59:59');

  if (!tasks || tasks.length === 0) {
    await editTelegramMessage(chatId, thinkingId, '🚨 **[進度追蹤]**\n\n您今天沒有尚未完成的高優先級任務，做得好！');
    return;
  }

  const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert serving an INTJ/ENTJ boss.
It's 3:00 PM. The user has HIGH PRIORITY tasks due today that are NOT YET COMPLETED:
${JSON.stringify(tasks)}

Write a hyper-efficient, data-driven status check. No polite fluff. Demand an immediate execution status update (Complete / Postpone / In Progress) based on logical necessity.
Use Traditional Chinese and minimal emojis.`;

  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    await editTelegramMessage(chatId, thinkingId, `🚨 **[進度追蹤]**\n\n${reply}`);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成進度追蹤失敗。');
  }
}

import { supabase } from '../../utils/db';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleEveningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const tomorrowStr = new Date(Date.now() + 86400000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  const [tasksResult, eventsResult] = await Promise.all([
    supabase.from('tasks').select('title, category, status, priority').eq('user_id', userId).gte('deadline', todayStr).lt('deadline', todayStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', tomorrowStr).lt('start_time', tomorrowStr + 'T23:59:59')
  ]);

  const tasks = tasksResult.data || [];
  const eventsTomorrow = eventsResult.data || [];

  const completed = tasks.filter(t => t.status === 'completed');
  const pending = tasks.filter(t => t.status !== 'completed');

  if (tasks.length === 0 && eventsTomorrow.length === 0) {
    await editTelegramMessage(chatId, thinkingId, '🌙 **[晚間會報]**\n\n今天沒有紀錄任務，明天也沒有特別的行程。好好休息吧！');
    return;
  }

  const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert.
It's 8:00 PM. Summarize the day and prep for tomorrow.
Completed Tasks Today: ${JSON.stringify(completed)}
Uncompleted Tasks Today: ${JSON.stringify(pending)}
Events Tomorrow: ${JSON.stringify(eventsTomorrow)}

Rules:
1. Tone: Brutally direct, zero-BS. Use Traditional Chinese.
2. Structure: 
   - 🎯 今日戰果 (Briefly acknowledge completed vs pending)
   - ⚠️ 待辦殘留 (If any pending, bluntly ask to reschedule or drop)
   - 📅 明日作戰 (Brief summary of tomorrow's events)
3. Do NOT use polite fluff like "辛苦了" or "早點休息". Just data.`;

  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    await editTelegramMessage(chatId, thinkingId, `🌙 **[晚間會報]**\n\n${reply}`);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成晚間會報失敗。');
  }
}

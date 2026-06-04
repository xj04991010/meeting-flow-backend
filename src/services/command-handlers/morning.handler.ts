import { supabase } from '../../utils/db';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleMorningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  const [tasksResult, eventsResult, memoriesResult, rawFact] = await Promise.all([
    supabase.from('tasks').select('title, category, priority').eq('user_id', userId).neq('status', 'completed'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('memories').select('content').eq('user_id', userId),
    fetch('https://uselessfacts.jsph.pl/api/v2/facts/random').then(r => r.json()).then((d: any) => d.text).catch(() => '')
  ]);
  
  const tasks = tasksResult.data;
  const events = eventsResult.data;
  const memories = memoriesResult.data;

  if ((!tasks || tasks.length === 0) && (!events || events.length === 0) && (!memories || memories.length === 0)) {
    await editTelegramMessage(chatId, thinkingId, '🌅 **[晨間簡報]**\n\n今天目前沒有任何行程或待辦事項喔！');
    return;
  }

  const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert serving an INTJ/ENTJ boss.
It's 9:00 AM on ${todayStr}. Summarize today's agenda for the user.
Events today: ${JSON.stringify(events || [])}
Pending tasks: ${JSON.stringify(tasks || [])}
User's Long-Term Memories & Goals: ${JSON.stringify(memories || [])}
Raw Internet Fun Fact: "${rawFact}"

Rules:
1. Tone: Brutally direct, zero-BS, objective, and data-driven. Do NOT use polite fluff, caring platitudes, or meaningless intros/outros. Use Traditional Chinese. Use emojis ONLY for strict data categorization.
2. Contextual Reminders: CRITICAL! Read the User's Long-Term Memories. If there are birthdays, anniversaries, or recurring events relevant to today or this month, output a stark, objective reminder.
3. Micro-Tasking (碎片化安插): Analyze today's Events. If there is a noticeable gap of free time (e.g., no events for 2 hours in the afternoon), AND the user has a long-term goal in their Memories (e.g., "讀書", "寫作"), you MUST recommend allocating time to the goal with absolute objectivity. ("分析：下午 14:00-16:00 具備 2 小時神經低負載空檔，建議立即執行 [長期目標] 推進。")
4. Fun Fact (冷知識): At the VERY END of the briefing, translate the "Raw Internet Fun Fact" (if provided) into Traditional Chinese, and present it as a pure data point to start the day. Format it as: "💡 [Data Point] 您知道嗎？[fun fact]"`;

  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    await editTelegramMessage(chatId, thinkingId, `🌅 **[晨間簡報]**\n\n${reply}`);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成晨間簡報失敗。');
  }
}

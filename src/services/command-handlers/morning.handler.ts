import { supabase } from '../../utils/db';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleMorningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=24.18&longitude=120.68&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTaipei&forecast_days=1';

  const [yesterdayTasksResult, todayTasksResult, eventsResult, memoriesResult, weatherResult] = await Promise.all([
    supabase.from('tasks').select('title, category, priority, deadline').eq('user_id', userId).neq('status', 'completed').lt('deadline', todayStr),
    supabase.from('tasks').select('title, category, priority, deadline').eq('user_id', userId).neq('status', 'completed').gte('deadline', todayStr).lt('deadline', todayStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('memories').select('content').eq('user_id', userId),
    fetch(weatherUrl).then(r => r.json()).catch(() => null)
  ]);
  
  const yesterdayTasks = yesterdayTasksResult.data;
  const todayTasks = todayTasksResult.data;
  const events = eventsResult.data;
  const memories = memoriesResult.data;

  if ((!yesterdayTasks || yesterdayTasks.length === 0) && (!todayTasks || todayTasks.length === 0) && (!events || events.length === 0) && (!memories || memories.length === 0)) {
    await editTelegramMessage(chatId, thinkingId, '🌅 **[晨間簡報]**\n\n今天目前沒有任何行程或待辦事項喔！');
    return;
  }

  const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert serving an INTJ/ENTJ boss.
It's 9:00 AM on ${todayStr}. Summarize today's agenda for the user.
Events today: ${JSON.stringify(events || [])}
⚠️ Yesterday's Unfinished Tasks: ${JSON.stringify(yesterdayTasks || [])}
📋 Today's Pending tasks: ${JSON.stringify(todayTasks || [])}
User's Long-Term Memories & Goals: ${JSON.stringify(memories || [])}
Weather Data (Taichung): ${JSON.stringify(weatherResult?.current || {})} ${JSON.stringify(weatherResult?.daily || {})}

Rules:
0. Opening: Start with a cold but warm good morning, e.g. "早。今天是 YYYY/MM/DD（週X）。" Give a 1-sentence weather summary (e.g. "☀️ 台中 28-34°C，午後降雨機率 40%").
1. Tone: Brutally direct, zero-BS, objective, and data-driven. Do NOT use polite fluff, caring platitudes, or meaningless intros/outros. Use Traditional Chinese. Use emojis ONLY for strict data categorization.
2. Contextual Reminders: CRITICAL! Read the User's Long-Term Memories. If there are birthdays, anniversaries, or recurring events relevant to today or this month, output a stark, objective reminder. Highlight tasks with "[AI推演]" if they were proactively generated.
3. Micro-Tasking (碎片化安插): Analyze today's Events. If there is a noticeable gap of free time (e.g., no events for 2 hours in the afternoon), AND the user has a long-term goal in their Memories (e.g., "讀書", "寫作"), you MUST recommend allocating time to the goal with absolute objectivity.
4. Fun Fact (冷知識笑話): At the VERY END of the briefing, generate a short, original UberFact-style fun fact or witty joke in Traditional Chinese. It must be brief, engaging, and worth sharing. Format it as: "💡 [Data Point] 您知道嗎？[joke/fact]"

Output Format:
[Greeting & Weather]
[Contextual Reminders (if any)]
[Events & Micro-Tasking]
[Yesterday's Unfinished Tasks]
[Today's Tasks]
[Fun Fact]`;

  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    await editTelegramMessage(chatId, thinkingId, `🌅 **[晨間簡報]**\n\n${reply}`);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成晨間簡報失敗。');
  }
}

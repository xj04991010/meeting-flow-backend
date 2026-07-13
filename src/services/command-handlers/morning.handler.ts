import { supabase } from '../../utils/db';
import { getLatestNotesForAllClients } from '../../repositories/client-weekly-notes.repo';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

type ClientFollowup = {
  client: string;
  light: string;
  item: string;
  date?: string;
  days?: number;
};

export function collectClientFollowups(
  notes: Array<Record<string, any>>,
  todayStr: string,
): ClientFollowup[] {
  const today = new Date(`${todayStr}T00:00:00+08:00`).getTime();
  const followups: ClientFollowup[] = [];

  for (const note of notes) {
    const client = String(note.client_name || '未分類客戶');
    const light = String(note.traffic_light || 'green');
    const links = Array.isArray(note.date_links) ? note.date_links : [];
    for (const link of links) {
      if (!link?.date || !link?.label) continue;
      const target = new Date(`${link.date}T00:00:00+08:00`).getTime();
      const days = Math.round((target - today) / 86_400_000);
      if (days < 0 || days > 3) continue;
      followups.push({
        client,
        light,
        item: String(link.label),
        date: String(link.date),
        days,
      });
    }

    if (light === 'red' || light === 'yellow') {
      const urgent = String(note.urgent_note || note.next_week_note || '').trim();
      if (urgent && !followups.some((item) => item.client === client && item.item === urgent)) {
        followups.push({ client, light, item: urgent });
      }
    }
  }

  return followups.sort((a, b) => (a.days ?? 99) - (b.days ?? 99));
}

export async function handleMorningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=24.18&longitude=120.68&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTaipei&forecast_days=1';

  const [yesterdayTasksResult, todayTasksResult, eventsResult, memoriesResult, weatherResult, clientNotes] = await Promise.all([
    supabase.from('tasks').select('title, category, priority, deadline').eq('user_id', userId).neq('status', 'completed').lt('deadline', todayStr),
    supabase.from('tasks').select('title, category, priority, deadline').eq('user_id', userId).neq('status', 'completed').gte('deadline', todayStr).lt('deadline', todayStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('memories').select('content').eq('user_id', userId),
    fetch(weatherUrl).then(r => r.json()).catch(() => null),
    getLatestNotesForAllClients(userId).catch(() => []),
  ]);
  
  const yesterdayTasks = yesterdayTasksResult.data;
  const todayTasks = todayTasksResult.data;
  const events = eventsResult.data;
  const memories = memoriesResult.data;
  const clientFollowups = collectClientFollowups(clientNotes || [], todayStr);

  if ((!yesterdayTasks || yesterdayTasks.length === 0) && (!todayTasks || todayTasks.length === 0) && (!events || events.length === 0) && (!memories || memories.length === 0) && clientFollowups.length === 0) {
    await editTelegramMessage(chatId, thinkingId, '🌅 **[晨間簡報]**\n\n今天目前沒有任何行程或待辦事項喔！');
    return;
  }

  const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert serving an INTJ/ENTJ boss.
It's 9:00 AM on ${todayStr}. Summarize today's agenda for the user.
Events today: ${JSON.stringify(events || [])}
⚠️ Yesterday's Unfinished Tasks: ${JSON.stringify(yesterdayTasks || [])}
📋 Today's Pending tasks: ${JSON.stringify(todayTasks || [])}
User's Long-Term Memories & Goals: ${JSON.stringify(memories || [])}
Client Follow-ups from MeetingFlow (linked dates within 3 days plus red/yellow lights): ${JSON.stringify(clientFollowups)}
Weather Data (Taichung): ${JSON.stringify(weatherResult?.current || {})} ${JSON.stringify(weatherResult?.daily || {})}

Rules:
0. Opening: Start with a cold but warm good morning, e.g. "早。今天是 YYYY/MM/DD（週X）。" Give a 1-sentence weather summary (e.g. "☀️ 台中 28-34°C，午後降雨機率 40%").
1. Tone: Brutally direct, zero-BS, objective, and data-driven. Do NOT use polite fluff, caring platitudes, or meaningless intros/outros. Use Traditional Chinese. Use emojis ONLY for strict data categorization.
2. Contextual Reminders: CRITICAL! Read the User's Long-Term Memories. If there are birthdays, anniversaries, or recurring events relevant to today or this month, output a stark, objective reminder. Highlight tasks with "[AI推演]" if they were proactively generated.
2.1 Client Follow-ups: Include every linked-date item due in 0-3 days. Put red lights before yellow lights. Keep the client name and exact date. Do not invent progress.
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
    const fallback = clientFollowups.length
      ? clientFollowups.map((item) => `【${item.client}】${item.date ? `${item.date} ` : ''}${item.item}`).join('\n')
      : '目前沒有需要追蹤的客戶日期。';
    await editTelegramMessage(chatId, thinkingId, `🌅 **[晨間簡報]**\n\n${fallback}`);
  }
}

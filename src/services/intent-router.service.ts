import { callLLM } from './llm.service';

export type IntentOutput = {
  intent: 'extract_meeting' | 'supplement' | 'delete_item' | 'query_schedule' | 'update_tasks' | 'query_weather' | 'chit_chat' | 'eod_journal';
  delete_keyword?: string | null;
  query_timeframe?: string | null;
  query_category?: string | null;
  update_action?: 'reschedule' | 'complete' | null;
  update_target_timeframe?: string | null;
  update_target_category?: string | null;
  update_new_deadline_iso?: string | null;
  reply_message?: string | null;
  query_location?: string | null;
};

export async function routeIntent(userId: string, text: string): Promise<IntentOutput> {
  if (text.length > 300) return { intent: 'extract_meeting' };
  
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const prompt = `You are an intent router for a Telegram assistant managing tasks and calendars.
Current Date: ${todayStr}
Analyze the user's message and determine the intent.
Output JSON only:
{
  "intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat" | "eod_journal" | "eod_journal" | "query_weather",
  "delete_keyword": "string or null (Extract ONLY the core noun)",
  "query_timeframe": "string or null (e.g., '今天', '下週')",
  "query_category": "string or null (e.g., '開會', '行政')",
  "update_action": "'reschedule' | 'complete' or null",
  "update_target_timeframe": "string or null (the original time of the tasks to update)",
  "update_target_category": "string or null (e.g., '行政')",
  "update_new_deadline_iso": "ISO-8601 string or null (if action is reschedule, parse the new timeframe into an exact ISO string in Asia/Taipei timezone, e.g., '2026-06-03T00:00:00+08:00')",
  "reply_message": "string or null",
  "query_location": "string or null"
}

Rules:
- "extract_meeting": User provides NEW meeting notes or creates NEW standalone tasks. (Do NOT select this if the user is clearly writing a daily diary/journal, even if they mention tasks they did).
- "supplement": User wants to ADD or MODIFY something based on the PREVIOUS context.
- "delete_item": User wants to delete, cancel, or remove an existing item.
- "query_schedule": User asks what their schedule/tasks are. Set query_timeframe and query_category.
- "update_tasks": User wants to bulk update tasks. Set update_action, update_target_timeframe, update_new_deadline_iso.
- "query_weather": User asks for weather information. Set "query_location" (string, default to "Taichung" if not explicitly mentioned).
- "eod_journal": User is providing an End-of-Day summary, daily reflection, diary, or handover (e.g., "今天早上蠻廢的...", "以上是今日日記", "/eod 今天寫了C"). If the message feels like a journal entry recounting the day's events, ALWAYS classify as eod_journal, NOT extract_meeting.
- "chit_chat": General questions or greetings. Set "reply_message". You are a minimalist, precise, zero-bullshit, data-driven expert assistant serving an INTJ/ENTJ. Reply with aggressive straightforwardness, absolute honesty, and zero polite fluff. Do NOT use emojis unless strictly for data categorization.`;

  try {
    const content = await callLLM(userId, [
      { role: 'system', content: prompt },
      { role: 'user', content: text }
    ], { type: 'json_object', temperature: 0.7 });
    const parsed = JSON.parse(content || '{}');
    return {
      intent: parsed.intent || 'extract_meeting',
      delete_keyword: parsed.delete_keyword,
      query_timeframe: parsed.query_timeframe,
      query_category: parsed.query_category,
      update_action: parsed.update_action,
      update_target_timeframe: parsed.update_target_timeframe,
      update_target_category: parsed.update_target_category,
      update_new_deadline_iso: parsed.update_new_deadline_iso,
      reply_message: parsed.reply_message,
      query_location: parsed.query_location
    };
  } catch (e) {
    return { intent: 'extract_meeting' };
  }
}

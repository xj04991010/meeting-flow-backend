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
  const prompt = `你是 MeetingFlow 的大腦核心，正在服務一位極度講求效率的 INTJ/ENTJ 老闆 (何宇捷)。
你的核心人設：極簡、冷酷、直言不諱、完全不講廢話。你『極度厭惡』任何客服式的客套話（例如：「您好」、「很高興為您服務」、「我是一個 AI」、「請問有什麼需要幫忙的嗎」）、虛偽的讚美，以及任何無意義的冗言贅字。請直接說重點，用語必須完全符合台灣繁體中文的自然語境。

當前時間：${todayStr}
請分析使用者的訊息並判斷意圖。
只能輸出 JSON 格式：
{
  "intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat" | "eod_journal" | "query_weather",
  "delete_keyword": "字串 或 null (只提取核心名詞)",
  "query_timeframe": "字串 或 null (例如：'今天', '下週')",
  "query_category": "字串 或 null (例如：'開會', '行政')",
  "update_action": "'reschedule' | 'complete' 或 null",
  "update_target_timeframe": "字串 或 null (要更新的任務原本的時間)",
  "update_target_category": "字串 或 null (例如：'行政')",
  "update_new_deadline_iso": "ISO-8601 字串 或 null (如果是 reschedule，請將新時間轉換為 Asia/Taipei 時區的精確 ISO 字串，例如：'2026-06-03T00:00:00+08:00')",
  "reply_message": "字串 或 null",
  "query_location": "字串 或 null"
}

規則：
- "extract_meeting": 使用者提供【新的】會議紀錄或建立新任務。（如果使用者明顯在寫日記、心得或交接，就算裡面有提到做了什麼任務，也絕對不要選這個）。
- "supplement": 使用者想要根據【之前的對話上下文】補充或修改資料。
- "delete_item": 使用者想要刪除、取消或移除某個現有項目。
- "query_schedule": 使用者詢問行程或任務是什麼。必須設定 query_timeframe 和 query_category。
- "update_tasks": 使用者想要批次更新任務（例如改期、完成）。必須設定 update_action, update_target_timeframe, update_new_deadline_iso。
- "query_weather": 使用者詢問天氣。設定 "query_location"（字串，如果未提及預設為 "Taichung"）。
- "eod_journal": 使用者提供每日總結、反思、日記或交接紀錄（例如：「今天早上蠻廢的...」、「以上是今日日記」、「/eod 今天寫了C」）。只要感覺像在敘述今天發生的事或心得，一律歸類為 eod_journal。
- "chit_chat": 閒聊、一般問題或打招呼。設定 "reply_message"。警告："reply_message" 必須完全符合你的冷酷人設。講話要極度精簡、一針見血、冷靜客觀。絕對不要道歉，絕對不要說自己是助理或 AI，絕對不准加表情符號。用道地的台灣繁體中文直接回答事實或表達態度。`;

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

import { supabase } from '../utils/db';
import { sendTelegram, sendThinkingMessage, editTelegramMessage, getTelegramFileBuffer, answerCallbackQuery } from './telegram.service';
import { callLLM, transcribeAudio } from './llm.service';
import { getOrCreateUser } from '../repositories/users.repo';
import { getDashboardUrl, PARSER_VERSION } from '../utils/env';
import { ExtractedTaskSchema, ExtractedTask, ExtractedEventSchema, ExtractedEvent, ParserOutputSchema, ParserOutput, BatchSummary } from '../schemas/extraction.schema';
import { generateResearchReport } from '../research';
import { insertTasks } from '../repositories/tasks.repo';
import { insertEvents } from '../repositories/calendar-intents.repo';
import { insertMemories } from '../repositories/memories.repo';
import { createSourceBatchV1, updateSourceBatchSummary } from '../repositories/source-batches.repo';
import { loadRelevantMemories } from './memory.service';
import { createDecisionLog } from './decision-logger.service';
import { loadPlaybookRules, buildPlaybookPrompt } from './playbook.service';
import { calculateRiskScore, detectPrepGap } from './strategy.service';
export type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
};

export function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  if (parsed > 1) return Math.min(parsed / 100, 1);
  return Math.max(0, Math.min(parsed, 1));
}

export function hasMeaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function looksLikeDashboardCommand(text: string) {
  const normalized = text.trim().toLowerCase();
  return [
    '/dashboard',
    'dashboard',
    'open dashboard',
    'show dashboard',
    '看 dashboard',
    '打開 dashboard',
    '開 dashboard',
    '看儀表板',
    '打開儀表板',
    '開儀表板'
  ].includes(normalized);
}

function startProgressUpdates(chatId: number, messageId: number, isShort: boolean) {
  let stopped = false;
  if (isShort) return () => { stopped = true; };

  const updates = [
    {
      delay: 15_000,
      text: '還在解析中。短會議通常 10-30 秒，長篇會議紀錄可能需要 1 分鐘左右。'
    },
    {
      delay: 35_000,
      text: '資料比較長，我還在拆待辦與行程。預計再等 20-40 秒。'
    },
    {
      delay: 70_000,
      text: '這次解析已超過 1 分鐘，可能是 LLM 回應較慢。我會再等一下，超過 90 秒會自動停止並回報錯誤。'
    }
  ];

  const timers = updates.map((update) => setTimeout(() => {
    if (!stopped) {
      editTelegramMessage(chatId, messageId, update.text).catch((error) => {
        console.error('progress update error', error);
      });
    }
  }, update.delay));

  return () => {
    stopped = true;
    timers.forEach((timer) => clearTimeout(timer));
  };
}

export function makeReviewFlag(confidence: number, explicitNeedsReview: unknown, hasRequiredTime = true) {
  return Boolean(explicitNeedsReview) || confidence < 0.85 || !hasRequiredTime;
}



// chat_history 已停用 — 不再寫入，避免浪費 DB 資源
// 如果未來需要 audit log，可重新啟用此函式
// async function appendChatHistory(userId: string, role: 'user' | 'assistant', content: string) { ... }



async function getLatestSourceBatch(userId: string) {
  const { data } = await supabase
    .from('source_batches')
    .select('id, summary, raw_text, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}





function buildExtractionPrompt(todayStr: string, customCategories: string[]) {
  const catsStr = customCategories.length > 0 ? customCategories.join('", "') : '操盤", "教育", "行政", "其他';
  const catsSchema = customCategories.length > 0 ? customCategories.join(' | ') : '操盤 | 教育 | 行政 | 其他';
  
  return `You are a world-class AI Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert. The user (Ho Yu-Chieh) is an INTJ/ENTJ who hates politeness, flattery, and meaningless fluff. Your job is to extract structured tasks and calendar events from raw conversations with absolute objectivity and efficiency.
Current Datetime (Asia/Taipei): ${todayStr}

Mission:
- Extract every actionable task and calendar event from the user's text.
- NOISE REDUCTION: The text may contain venting, cursing, jokes, or emotional outbursts. Ignore all non-actionable chatter. Focus strictly on execution and deliverables.
- DELEGATION & OWNERSHIP: If the text assigns work (e.g., "@Jack", "交給Tom"), assign them as the 'owner'. If someone says "我來處理" (I'll handle it), assign the sender as the owner.
- SPEAKER DIARIZATION & FIREFLIES.AI STYLE: If there are multiple speakers, identify them (Speaker A, Speaker B). Extract action items assigned to specific people.
- MEETING KEY POINTS (會議要點): Summarize the meeting thoroughly in the 'reply_message'. This must read like a minimalist, data-driven, objective summary (no polite intros/outros), including:
  1. 📝 Executive Summary (會議總結)
  2. 🗣️ Speaker Notes (發言要點)
  3. ✅ Action Items by Owner (各負責人待辦)
- CONFIRMATION & REVIEW: If the user provides a direct, clear command with a specific date, time, and action item (e.g., "新增明天下午三點的會議"), set "needs_review": false. If the text is messy, ambiguous, or lacks specific time details, set "needs_review": true so the user can verify it.
- CONVERSATIONAL FALLBACK: If the user is simply chatting, asking a question, or providing non-actionable input (e.g. "你有幾種功能", "你好"), DO NOT hallucinate tasks or events. Output an empty list for tasks and events. In 'reply_message', provide a brutally direct, logical, and highly objective response. Never use polite padding, marketing rhetoric, or moral persuasion. Only use the summary format when there are actual meeting points or tasks to extract.
- STRICT CATEGORIZATION:
  * Events (events): Meetings, physical appointments. Must have a time constraint.
  * Tasks (tasks): Deliverables, script writing, video editing, etc.
- ROLE-BASED CATEGORIZATION (情境標籤): Every task must be assigned to ONE of the following core categories in the "category" field: "${catsStr}".
- SMART TIME INFERENCE:
  * "明天" (tomorrow) -> infer exact date.
  * "下週" (next week) -> infer next Monday or specific day if mentioned.
- LONG-TERM MEMORY (長期記憶): If the user mentions personal rules, habits, important relationships, birthdays, or fuzzy recurring needs (e.g. "以後每個月初要結帳", "我爸生日是10月15日", "遇到A客戶要注意合約"), extract them into the "memories" array. 
- LINK & ASSET RETENTION: Always preserve URLs in the 'source_quote' or 'title'.

Output JSON only:
{
  "reply_message": "If conversation, reply with zero-BS, objective, precise data-driven logic. If meeting, output minimalist Markdown summary. NO polite fluff. Use Traditional Chinese.",
  "tasks": [
    {
      "title": "specific action item (include context prefix)",
      "client": "client/project name or null",
      "owner": "person responsible or null",
      "deadline": "ISO-8601 datetime with timezone if clear, otherwise null",
      "priority": "high or medium or low",
      "category": "${catsSchema}",
      "confidence": 0.0,
      "needs_review": true,
      "source_quote": "short quote from the source text"
    }
  ],
  "events": [
    {
      "title": "specific calendar event",
      "client": "client/project name or null",
      "start_time": "ISO-8601 datetime with timezone",
      "end_time": "ISO-8601 datetime with timezone or null",
      "location": "location or null",
      "confidence": 0.0,
      "needs_review": true,
      "source_quote": "short quote from the source text"
    }
  ],
  "memories": ["爸媽生日是10月15日", "每個月初要提醒我結帳"],
  "unresolved_notes": ["important ambiguous notes that need dashboard review"]
}

Rules:
- Prefer Traditional Chinese (zh-TW).
- ALL tasks and events MUST have "needs_review": true.
- Never output markdown outside the JSON structure.
- Never use a single mutually-exclusive type field.`;
}

interface IntentOutput {
  intent: 'extract_meeting' | 'supplement' | 'delete_item' | 'query_schedule' | 'update_tasks' | 'chit_chat' | 'query_weather';
  delete_keyword?: string | null;
  query_timeframe?: string | null;
  query_category?: string | null;
  query_location?: string | null;
  update_action?: 'reschedule' | 'complete' | null;
  update_target_timeframe?: string | null;
  update_target_category?: string | null;
  update_new_deadline_iso?: string | null;
  reply_message?: string | null;
}

export async function routeIntent(userId: string, text: string): Promise<IntentOutput> {
  if (text.length > 300) return { intent: 'extract_meeting' };
  
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const prompt = `You are an intent router for a Telegram assistant managing tasks and calendars.
Current Date: ${todayStr}
Analyze the user's message and determine the intent.
Output JSON only:
{
  "intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat",
  "delete_keyword": "string or null (Extract ONLY the core noun)",
  "query_timeframe": "string or null (e.g., '今天', '下週')",
  "query_category": "string or null (e.g., '操盤', '行政')",
  "update_action": "'reschedule' | 'complete' or null",
  "update_target_timeframe": "string or null (the original time of the tasks to update)",
  "update_target_category": "string or null (e.g., '行政')",
  "update_new_deadline_iso": "ISO-8601 string or null (if action is reschedule, parse the new timeframe into an exact ISO string in Asia/Taipei timezone, e.g., '2026-06-03T00:00:00+08:00')",
  "reply_message": "string or null"
}

Rules:
- "extract_meeting": User provides NEW meeting notes or creates NEW standalone tasks.
- "supplement": User wants to ADD or MODIFY something based on the PREVIOUS context.
- "delete_item": User wants to delete, cancel, or remove an existing item.
- "query_schedule": User asks what their schedule/tasks are (e.g. "我今天有什麼事", "這週操盤有什麼"). Set query_timeframe and query_category.
- "update_tasks": User wants to bulk update tasks (e.g. "把今天下午的行政都移到明天", "把今天的任務標記完成"). Set update_action, update_target_timeframe, update_new_deadline_iso.
- "query_weather": User asks for weather information (e.g. "未來的天氣", "台中天氣如何"). Set "query_location" (string, default to "Taichung" if not explicitly mentioned).
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
      reply_message: parsed.reply_message
    };
  } catch (e) {
    return { intent: 'extract_meeting' };
  }
}

export async function extractMeetingData(userId: string, text: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let content: string | null = '';
  try {
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const customCategories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];

    content = await callLLM(userId, [
      { role: 'system', content: buildExtractionPrompt(todayStr, customCategories) },
      { role: 'user', content: text }
    ], { type: 'json_object' });
    
    const rawJSON = JSON.parse(content || '{}');
    const result = ParserOutputSchema.safeParse(rawJSON);
    
    if (result.success) {
      return {
        reply_message: result.data.reply_message || '',
        tasks: result.data.tasks || [],
        events: result.data.events || [],
        memories: result.data.memories || [],
        unresolved_notes: result.data.unresolved_notes || []
      };
    } else {
      console.error('Zod schema validation failed for extractMeetingData:', result.error);
      const errMsgs = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
      return { reply_message: `AI 輸出格式異常，已啟用安全回退機制。(Debug: ${errMsgs})`, tasks: [], events: [], unresolved_notes: [] };
    }
  } catch (err) {
    console.error('Failed to parse LLM output:', err, 'Content:', content);
    return { reply_message: '解析失敗，請稍後再試。', tasks: [], events: [], unresolved_notes: [] };
  }
}

function buildSupplementPrompt(todayStr: string, batchContext: string, customCategories: string[]) {
  const catsSchema = customCategories.length > 0 ? customCategories.join(' | ') : '操盤 | 教育 | 行政 | 其他';
  
  return `You are MeetingFlow's meeting extraction engine. This is a SUPPLEMENT command.

Current time in Asia/Taipei: ${todayStr}

Recent Meeting Context:
"""
${batchContext}
"""

Mission:
- The user is providing a short supplement or modification command to the Recent Meeting Context above.
- Extract any NEW tasks and events based on the user's command.
- If the user says "add a task for X", return it in "tasks".
- Output JSON exactly like the main extraction format, with reply_message, tasks, events, and unresolved_notes.
- IMPORTANT: Respect the user's exact terminology. If the user writes "發片", DO NOT convert it to "發貨". Maintain the original context.

Output JSON only:
{
  "reply_message": "short Traditional Chinese confirmation",
  "tasks": [
    {
      "title": "specific action item (include context prefix)",
      "client": "client/project name or null",
      "owner": "person responsible or null",
      "deadline": "ISO-8601 datetime with timezone if clear, otherwise null",
      "priority": "high or medium or low",
      "category": "${catsSchema}",
      "confidence": 0.0,
      "needs_review": true,
      "source_quote": "short quote from the source text"
    }
  ],
  "events": [...],
  "unresolved_notes": []
}

Rules:
- Prefer Traditional Chinese.
- Keep titles concise but operational.
- Do not behave like a coach.
- CONFIRMATION & REVIEW: If the user provides a direct, clear command with a specific date, time, and action item, set "needs_review": false. If ambiguous, set "needs_review": true so the user can verify it.`;
}

export async function extractSupplementData(userId: string, text: string, batchContext: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let content: string | null = '';
  try {
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const customCategories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];

    content = await callLLM(userId, [
      { role: 'system', content: buildSupplementPrompt(todayStr, batchContext, customCategories) },
      { role: 'user', content: text }
    ], { type: 'json_object' });
    
    const rawJSON = JSON.parse(content || '{}');
    const result = ParserOutputSchema.safeParse(rawJSON);
    
    if (result.success) {
      return {
        reply_message: result.data.reply_message || '',
        tasks: result.data.tasks || [],
        events: result.data.events || [],
        memories: result.data.memories || [],
        unresolved_notes: result.data.unresolved_notes || []
      };
    } else {
      console.error('Zod schema validation failed for extractSupplementData:', result.error);
      const errMsgs = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
      return { reply_message: `AI 輸出格式異常，已啟用安全回退機制。(Debug: ${errMsgs})`, tasks: [], events: [], unresolved_notes: [] };
    }
  } catch (err) {
    console.error('Failed to parse LLM output in supplement:', err, 'Content:', content);
    return { reply_message: '解析失敗，請稍後再試。', tasks: [], events: [], unresolved_notes: [] };
  }
}





export async function persistExtraction(userId: string, rawText: string, result: ParserOutput): Promise<BatchSummary & { taskIds?: string[], memoryCount?: number }> {
  const batchId = await createSourceBatchV1(userId, rawText, result);
  const tasksResult = await insertTasks(userId, batchId, result.tasks || []);
  const taskIds = Array.isArray(tasksResult) ? tasksResult : [];
  const taskCount = Array.isArray(tasksResult) ? tasksResult.length : (tasksResult as number);
  const eventCount = await insertEvents(userId, batchId, result.events || []);
  const memoryCount = await insertMemories(userId, result.memories || []);
  
  const reviewCount = [
    ...(result.tasks || []).map((task) => makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)),
    ...(result.events || []).map((event) => makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
  ].filter(Boolean).length + (result.unresolved_notes?.length || 0);
  const autoReadyEventCount = (result.events || [])
    .filter((event) => !makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
    .length;

  return { batchId, taskCount, eventCount, reviewCount, autoReadyEventCount, taskIds, memoryCount };
}



export function buildTelegramSummary(userId: string, result: ParserOutput, summary: BatchSummary & { memoryCount?: number }) {
  // Fireflies.ai style detailed summary is now in reply_message
  const reply = result.reply_message?.trim() || `已成功萃取內容！`;

  if (summary.taskCount === 0 && summary.eventCount === 0 && (!summary.memoryCount || summary.memoryCount === 0)) {
    return reply; // Pure conversational response, no footer needed
  }

  const lines = [reply, ''];
  lines.push('---');
  
  let stats = `💡 **系統已自動擷取 ${summary.taskCount} 件待辦與 ${summary.eventCount} 個行程**`;
  if (summary.memoryCount && summary.memoryCount > 0) {
    stats += `\n🧠 **助理已自動記住 ${summary.memoryCount} 筆長期記憶/習慣**`;
  }
  lines.push(stats);
  lines.push('⚠️ **狀態：等待人工二次確認**');
  lines.push('所有擷取的項目目前皆設為「待審閱」，請點擊下方按鈕前往 Dashboard 進行確認，確認後才會同步至您的 Google 日曆。');
  lines.push('');
  lines.push(`🔗 [點此開啟 Dashboard 進行二次確認](${getDashboardUrl(userId)})`);
  return lines.join('\n');
}

export function nullableText(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function nullableDate(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
}

export function booleanOrUndefined(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}



const userCommandCache = new Map<string, number>();

export async function processTelegramUpdate(message: any) {
  const chatId = message.chat?.id;
  let text = message.text?.trim();
  
  if (!chatId) return;

  if (text) {
    const cacheKey = `${chatId}_${text}`;
    const lastTime = userCommandCache.get(cacheKey) || 0;
    if (Date.now() - lastTime < 3000) {
      console.log(`[RateLimit] Dropping repeated command from ${chatId}: ${text}`);
      return;
    }
    userCommandCache.set(cacheKey, Date.now());
  }

  let existingThinkingMessageId: number | null = null;

  // Handle Voice Messages (Magic Feature 1)
  if (message.voice) {
    const userId = await getOrCreateUser(chatId);
    existingThinkingMessageId = await sendThinkingMessage(chatId, false);
    try {
      const audioBuffer = await getTelegramFileBuffer(message.voice.file_id);
      text = await transcribeAudio(audioBuffer, 'voice.ogg');
      
      if (!text || text.trim() === '') {
        await editTelegramMessage(chatId, existingThinkingMessageId as number, '聽不清楚您的語音，請再說一次。');
        return;
      }
      
      await editTelegramMessage(chatId, existingThinkingMessageId as number, `🗣️ **語音辨識成功：**\n「${text}」\n\n正在為您處理...`);
      message.text = text; // fake it for downstream
      delete message.voice;
    } catch (e: any) {
      console.error('Voice extraction error', e);
      await editTelegramMessage(chatId, existingThinkingMessageId as number, `語音處理失敗：${e.message}`);
      return;
    }
  }

  if (!text) return;

  console.log(`[DEBUG] processTelegramUpdate called. chatId: ${chatId}, text: ${text}`);

  const lowerText = text.toLowerCase();

  if (lowerText === '/start') {
    const userId = await getOrCreateUser(chatId);
    const reply = 'MeetingFlow 已切回會議萃取模式。直接貼上會議紀錄，我會批次抽出待辦、行程與待確認項目。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: getDashboardUrl(userId) }]]);
    return;
  }

  if (lowerText === '/morning') {
    const userId = await getOrCreateUser(chatId);
    await handleMorningCommand(chatId, userId);
    return;
  }

  if (lowerText === '/week') {
    const userId = await getOrCreateUser(chatId);
    await handleWeekCommand(chatId, userId);
    return;
  }

  if (lowerText === '/memory') {
    const userId = await getOrCreateUser(chatId);
    const { data: memories } = await supabase.from('memories').select('content, created_at').eq('user_id', userId).order('created_at', { ascending: false });
    
    if (!memories || memories.length === 0) {
      await sendTelegram(chatId, '🧠 助理目前還沒有記下任何您的長期記憶喔！只要在聊天中跟我說您的習慣或重要日期，我就會記下來！');
      return;
    }
    
    const memList = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    await sendTelegram(chatId, `🧠 **我的記憶庫 (長期記憶)**\n\n${memList}\n\n💡 _這些記憶會在每天早安簡報中自動生效，幫您把關重要時程！_`);
    return;
  }

  if (lowerText.startsWith('/addboard ')) {
    const boardName = text.substring(10).trim();
    if (!boardName) {
      await sendTelegram(chatId, '請提供要新增的看板名稱。例如：/addboard 行銷');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    let categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    if (!categories.includes(boardName)) {
      categories.push(boardName);
      await supabase.from('users').update({ custom_categories: categories }).eq('id', userId);
      await sendTelegram(chatId, `✅ 已成功新增看板：[${boardName}]\n\n網頁重新整理後即可看到新看板。未來指派任務時可以直接說「放到${boardName}看板」。`);
    } else {
      await sendTelegram(chatId, `⚠️ 看板 [${boardName}] 已經存在囉！`);
    }
    return;
  }

  if (lowerText.startsWith('/rmboard ')) {
    const boardName = text.substring(9).trim();
    if (!boardName) {
      await sendTelegram(chatId, '請提供要移除的看板名稱。例如：/rmboard 行銷');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    let categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    if (categories.includes(boardName)) {
      categories = categories.filter((c: string) => c !== boardName);
      await supabase.from('users').update({ custom_categories: categories }).eq('id', userId);
      await sendTelegram(chatId, `✅ 已成功移除看板：[${boardName}]`);
    } else {
      await sendTelegram(chatId, `⚠️ 找不到名為 [${boardName}] 的看板。`);
    }
    return;
  }

  if (lowerText === '/boards') {
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    await sendTelegram(chatId, `📋 **目前的情境看板清單**：\n\n${categories.map((c: string) => `- [${c}]`).join('\n')}\n\n您可以使用 \`/addboard 名稱\` 來新增，或 \`/rmboard 名稱\` 來移除。`);
    return;
  }

  if (lowerText.startsWith('/research ') || lowerText.startsWith('/read ')) {
    const isUrl = lowerText.startsWith('/read ');
    const query = text.substring(isUrl ? 6 : 10).trim();
    if (!query) {
      await sendTelegram(chatId, '請提供要研究的主題或網址。例如：/research 什麼是 Agentic AI?');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    await handleResearchCommand(chatId, userId, query, isUrl);
    return;
  }

  if (looksLikeDashboardCommand(text)) {
    const userId = await getOrCreateUser(chatId);
    const reply = '打開 Dashboard 查看所有批次、待辦與行程。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: getDashboardUrl(userId) }]]);
    return;
  }

  const greetings = ['你好', '嗨', '哈囉', 'hello', 'hi', 'test', '測試', '安安', '早安', '午安', '晚安', '在嗎'];
  if (text.length <= 10 && greetings.some(g => text.toLowerCase().includes(g))) {
    const reply = '你好！我是你的 MeetingFlow 智能助理 👋\n\n你可以直接傳送「會議紀錄」或是「待辦事項」給我，我會幫你自動抽出任務與行程。\n\n輸入 /week 即可查看未來一週的行程與待辦總覽！';
    await sendTelegram(chatId, reply);
    return;
  }

  const isShort = text.length <= 50;
  const thinkingMessageId = existingThinkingMessageId || await sendThinkingMessage(chatId, isShort);

  const userId = await getOrCreateUser(chatId);

  // chat_history 已停用

  const startedAt = Date.now();
  const stopProgressUpdates = startProgressUpdates(chatId as number, thinkingMessageId as number, isShort);

  try {
    const route = await routeIntent(userId, text);
    console.log(`[Router] intent=${route.intent} keyword=${route.delete_keyword} timeframe=${route.query_timeframe}`);

    if (route.intent === 'delete_item' && route.delete_keyword) {
      // Find matching tasks with ilike
      const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', userId).ilike('title', `%${route.delete_keyword}%`).limit(5);
      
      if (tasks && tasks.length > 0) {
        // Construct interactive buttons for each found task
        let replyText = `🔍 為您找到 ${tasks.length} 筆包含「${route.delete_keyword}」的任務，請問要刪除哪一項？`;
        const buttons: TelegramButton[][] = tasks.map(t => [
          { text: `🗑️ 刪除: ${t.title}`, callback_data: `delete_task_${t.id}` }
        ]);
        
        if (tasks.length > 1) {
          const shortKw = route.delete_keyword.substring(0, 15);
          buttons.push([{ text: `⚠️ 一次刪除全部 (${tasks.length} 筆)`, callback_data: `del_all_kw_${shortKw}` }]);
        }
        
        buttons.push([{ text: '❌ 取消', callback_data: `cancel_delete` }]);
        
        await editTelegramMessage(chatId as number, thinkingMessageId as number, replyText, buttons);
      } else {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `找不到包含「${route.delete_keyword}」的相關任務，請確認名稱是否正確。`);
      }
      return;
    }

    if (route.intent === 'query_schedule') {
      const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
      const nextWeekStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];

      const [{ data: tasks }, { data: events }] = await Promise.all([
        supabase.from('tasks').select('title, status').eq('user_id', userId).not('status', 'in', '("completed","cancelled")').limit(10),
        supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).not('status', 'in', '("rejected","cancelled")').not('start_time', 'is', null).gte('start_time', todayStr).lte('start_time', nextWeekStr).order('start_time', { ascending: true }).limit(10)
      ]);

      if ((!tasks || tasks.length === 0) && (!events || events.length === 0)) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '您近期沒有任何待辦事項或行程喔！很輕鬆！');
      } else {
        const lines = ['📅 **為您整理的近期行程與待辦：**\n'];
        if (events && events.length > 0) {
          lines.push('【即將到來的行程】');
          events.forEach(e => {
            const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            lines.push(`• [${timeStr}] ${e.title}`);
          });
          lines.push('');
        }
        if (tasks && tasks.length > 0) {
          lines.push('【未完成的待辦】');
          tasks.forEach(t => lines.push(`• ${t.title}`));
        }
        if (route.query_timeframe) {
          lines.push(`\n*(您詢問的時間範圍：${route.query_timeframe}，以上為近期總覽)*`);
        }
        await editTelegramMessage(chatId as number, thinkingMessageId as number, lines.join('\n'));
      }
      return;
    }

    if (route.intent === 'chit_chat' && route.reply_message) {
      await editTelegramMessage(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }

    if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      let weatherData = '';
      try {
        const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
        if (res.ok) {
          const json: any = await res.json();
          const current = json.current_condition?.[0] || {};
          const weatherDesc = current.weatherDesc?.[0]?.value || '';
          weatherData = `目前的溫度: ${current.temp_C}°C, 體感溫度: ${current.FeelsLikeC}°C, 天氣: ${weatherDesc}, 濕度: ${current.humidity}%.`;
          const tomorrow = json.weather?.[1];
          if (tomorrow) {
            weatherData += `\n明天的預報：最高溫 ${tomorrow.maxtempC}°C, 最低溫 ${tomorrow.mintempC}°C, 降雨機率: ${tomorrow.hourly?.[0]?.chanceofrain || 0}%.`;
          }
        } else {
          weatherData = '無法取得氣象數據。';
        }
      } catch (err) {
        weatherData = '氣象 API 連線失敗。';
      }

      // Fetch user memories to personalize the weather report
      const { data: userMemories } = await supabase.from('memories').select('content').eq('user_id', userId);
      const memoryStr = userMemories ? userMemories.map(m => m.content).join('; ') : '';

      const weatherPrompt = `You are an INTJ zero-BS executive assistant.
The user asked about the weather for: ${location}.
Raw Weather Data: ${weatherData}
User's Long-Term Memories & Habits: ${memoryStr}

Instructions:
1. Provide a brutally direct, logical weather report.
2. Cross-reference the weather data with the user's memories (e.g. if it will rain, suggest moving A-Fu's dog training indoors, or advise on their gym/diet routine).
3. Do NOT use polite fluff. Output ONLY the data-driven report and actionable suggestions.`;

      const aiReply = await callLLM(userId, [{ role: 'system', content: weatherPrompt }], { type: 'text' });
      await editTelegramMessage(chatId as number, thinkingMessageId as number, aiReply || '氣象分析失敗。');
      return;
    }

    if (route.intent === 'update_tasks') {
      const { data: tasks } = await supabase.from('tasks')
        .select('id, title, deadline, category')
        .eq('user_id', userId)
        .neq('status', 'completed')
        .limit(50);
        
      if (!tasks || tasks.length === 0) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `您目前沒有任何未完成的任務可供更新。`);
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
      const { task_ids_to_update } = JSON.parse(filterContent || '{"task_ids_to_update": []}');
      
      if (!task_ids_to_update || task_ids_to_update.length === 0) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `找不到符合條件的任務來進行更新。`);
        return;
      }

      if (route.update_action === 'complete') {
        await supabase.from('tasks').update({ status: 'completed' }).in('id', task_ids_to_update);
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `✅ 已為您將 ${task_ids_to_update.length} 筆任務標記為完成！`);
      } else if (route.update_action === 'reschedule' && route.update_new_deadline_iso) {
        await supabase.from('tasks').update({ deadline: route.update_new_deadline_iso }).in('id', task_ids_to_update);
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `✅ 已為您將 ${task_ids_to_update.length} 筆任務延期處理！`);
      } else {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `⚠️ 抱歉，我不太確定確切的新時間，請再說一次。`);
      }
      return;
    }

    if (route.intent === 'supplement') {
      const latestBatch = await getLatestSourceBatch(userId);
      if (!latestBatch || !latestBatch.raw_text) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '找不到您最近的紀錄可以補充。請直接輸入新的任務或行程。');
        return;
      }
      console.log(`Starting supplement extraction for user=${userId}`);
      const result = await extractSupplementData(userId, text, latestBatch.raw_text);
      
      const newRawText = latestBatch.raw_text + '\n\n[補充指令]: ' + text;
      const batchSummary = await persistExtraction(userId, newRawText, result);
      
      const reply = `✅ **補充成功！**\n\n${buildTelegramSummary(userId, result, batchSummary)}`;
      
      let buttons: TelegramButton[][] | undefined = undefined;
      if (batchSummary.taskCount > 0 || batchSummary.eventCount > 0) {
        buttons = [
          [{ text: '✅ 全部確認並同步', callback_data: `sync_batch_${batchSummary.batchId}` }],
          [{ text: '打開 Dashboard 修改細節', url: getDashboardUrl(userId) }]
        ];
      }
      await editTelegramMessage(chatId as number, thinkingMessageId as number, reply, buttons);
      return;
    }

    // Default: extract_meeting
    console.log(`Starting full extraction for user=${userId} chars=${text.length}`);
    const result = await extractMeetingData(userId, text);
    const batchSummary = await persistExtraction(userId, text, result);

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const reply = isShort 
      ? buildTelegramSummary(userId, result, batchSummary) 
      : `${buildTelegramSummary(userId, result, batchSummary)}\n\n⏱️ 耗時：約 ${seconds} 秒`;

    let buttons: TelegramButton[][] | undefined = undefined;
    const taskIds = batchSummary.taskIds as string[];
    if (isShort && batchSummary.taskCount === 1 && taskIds && taskIds.length === 1) {
      const tid = taskIds[0];
      buttons = [
        [{ text: '半小時', callback_data: `remind_${tid}_30m` }, { text: '明天 (1天)', callback_data: `remind_${tid}_1d` }],
        [{ text: '下週 (7天)', callback_data: `remind_${tid}_1w` }, { text: '下個月', callback_data: `remind_${tid}_1m` }]
      ];
    } else if (batchSummary.taskCount > 0 || batchSummary.eventCount > 0 || (batchSummary.memoryCount && batchSummary.memoryCount > 0)) {
      buttons = [
        [{ text: '✅ 全部確認並同步', callback_data: `sync_batch_${batchSummary.batchId}` }]
      ];
      if (batchSummary.memoryCount && batchSummary.memoryCount > 0) {
        buttons.push([{ text: '🧠 查看已存入的長期記憶', callback_data: 'view_memory' }]);
      }
      buttons.push([{ text: '打開 Dashboard 修改細節', url: getDashboardUrl(userId) }]);
    }

    await editTelegramMessage(chatId as number, thinkingMessageId as number, reply, buttons);
  } finally {
    stopProgressUpdates();
  }
}
async function handleResearchCommand(chatId: number, userId: string, query: string, isUrl: boolean) {
  const thinkingMessageId = await sendThinkingMessage(chatId, false);
  
  // Update thinking message
  await editTelegramMessage(chatId, thinkingMessageId as number, `🔍 開始為您深度研究：「${query}」\n(這可能需要幾十秒鐘，請稍候...)`);

  // Insert into database as 'processing'
  const { data: doc, error } = await supabase.from('research_documents').insert({
    user_id: userId,
    title: isUrl ? '網頁深度總結' : query,
    content: '正在處理中...',
    status: 'processing'
  }).select('id').single();

  if (error || !doc) {
    console.error('Failed to create research document', error);
    await editTelegramMessage(chatId, thinkingMessageId as number, '❌ 建立研究報告失敗，請稍後再試。');
    return;
  }

  // Run in background so we don't block
  setTimeout(async () => {
    try {
      const report = await generateResearchReport(userId, query, isUrl);
      
      // Extract title from report if possible, or keep the query
      let title = isUrl ? query : query;
      const titleMatch = report.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1].substring(0, 100);
      }

      await supabase.from('research_documents').update({
        title,
        content: report,
        status: 'completed'
      }).eq('id', doc.id);

      await editTelegramMessage(chatId, thinkingMessageId as number, `✅ 深度研究完成！已將報告加入您的 Dashboard：\n\n📌 **${title}**\n\n[打開 Dashboard 閱讀](${getDashboardUrl(userId)})`);
    } catch (e: any) {
      console.error('Deep research failed:', e);
      await supabase.from('research_documents').update({
        content: `研究過程中發生錯誤：${e.message}`,
        status: 'failed'
      }).eq('id', doc.id);
      await editTelegramMessage(chatId, thinkingMessageId as number, `❌ 研究失敗：${e.message}`);
    }
  }, 0);
}

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

async function handleWeekCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const nextWeekStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];

  const { data: events } = await supabase.from('calendar_intents')
    .select('title, start_time')
    .eq('user_id', userId)
    .not('status', 'eq', 'rejected')
    .not('start_time', 'is', null)
    .gte('start_time', todayStr)
    .lte('start_time', nextWeekStr)
    .order('start_time', { ascending: true });

  const { data: tasks } = await supabase.from('tasks')
    .select('title, deadline, status, priority')
    .eq('user_id', userId)
    .not('status', 'eq', 'rejected');

  const pendingTasks = tasks?.filter(t => t.status !== 'completed') || [];

  const lines = ['🗓️ **未來一週排程與待辦總覽**\n'];

  if (events && events.length > 0) {
    lines.push('📅 **行事曆排程**：');
    
    let currentDay = '';
    let eventCount = 0;
    for (const e of events) {
      if (eventCount >= 7) {
        lines.push(`\n*(還有 ${events.length - 7} 個行程未顯示)*`);
        break;
      }
      const d = new Date(e.start_time);
      const dayStr = d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short' });
      const timeStr = d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
      
      if (currentDay !== dayStr) {
        lines.push(`\n🔹 **${dayStr}**`);
        currentDay = dayStr;
      }
      lines.push(`  • \`${timeStr}\` ${e.title}`);
      eventCount++;
    }
    lines.push('');
  } else {
    lines.push('📅 **未來一週沒有安排行程**\n');
  }

  if (pendingTasks.length > 0) {
    lines.push('✅ **重點待辦任務**：');
    // Sort tasks by priority
    const prioMap: any = { 'urgent': 4, 'high': 3, 'medium': 2, 'low': 1 };
    pendingTasks.sort((a, b) => prioMap[b.priority || 'medium'] - prioMap[a.priority || 'medium']);
    
    pendingTasks.slice(0, 6).forEach(t => {
      let icon = '⬜';
      if (t.priority === 'urgent') icon = '🚨';
      else if (t.priority === 'high') icon = '🔴';
      else if (t.priority === 'medium') icon = '🟡';
      else if (t.priority === 'low') icon = '🟢';
      
      lines.push(`${icon} ${t.title}`);
    });
    if (pendingTasks.length > 6) lines.push(`\n*(還有 ${pendingTasks.length - 6} 項待辦未顯示)*`);
  } else {
    lines.push('✅ **目前沒有未完成的待辦！**');
  }

  const buttons = [[
    { text: '✨ 打開 Dashboard 排程總覽', url: getDashboardUrl(userId) }
  ]];

  await editTelegramMessage(chatId, thinkingId, lines.join('\n'), buttons);
}

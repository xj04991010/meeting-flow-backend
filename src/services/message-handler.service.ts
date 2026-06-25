import { routeIntent, IntentOutput } from './intent-router.service';
import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';
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
      text: '⚡ 深度解析中...'
    },
    {
      delay: 35_000,
      text: '⚡ 正在萃取任務與行程，請稍候...'
    },
    {
      delay: 70_000,
      text: '⏳ 模型運算時間較長，仍在處理中...'
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
- CONFIRMATION & REVIEW: ALL extracted tasks and events must be created as review drafts first. Always set "needs_review": true, even when the command is clear. The user confirms drafts from Dashboard before they become active.
- CONVERSATIONAL FALLBACK: If the user is simply chatting, asking a question, or providing non-actionable input (e.g. "你有幾種功能", "你好"), DO NOT hallucinate tasks or events. Output an empty list for tasks and events. In 'reply_message', provide a brutally direct, logical, and highly objective response. Never use polite padding, marketing rhetoric, or moral persuasion. Only use the summary format when there are actual meeting points or tasks to extract.
- ANTI-HALLUCINATION: NEVER invent tasks or actions (e.g., "腳本撰寫", "剪輯") for a client if the text does not explicitly mention them for that specific client. If the text says "開會" (meeting), it MUST be an event, not a task, even if the exact time is fuzzy or missing (use a fallback time or leave start_time null). Do not mix context between different clients.
- STRICT CATEGORIZATION:
  * Events (events): Meetings, physical appointments. Must have a time constraint or explicitly be a meeting ("開會").
  * Tasks (tasks): Deliverables, script writing, video editing, etc.
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
      "category": "null (leave empty during extraction)",
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
- The user is providing a natural language correction or supplement to the Recent Meeting Context & Extracted Drafts above.
- If the user points out a mistake (e.g., "X is a meeting, not a task" or "cancel Y"), you MUST:
  1. Find the short ID (e.g., "T1", "E2") of the wrong draft.
  2. Put that short ID in the "delete_targets" array.
  3. If it was a correction (not just a cancellation), output the corrected version in "tasks" or "events".
- If the user is just adding something new, output it in "tasks" or "events".
- Output JSON exactly like the main extraction format, with reply_message, tasks, events, unresolved_notes, and delete_targets.
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
      "category": "null (leave empty during extraction)",
      "confidence": 0.0,
      "needs_review": true,
      "source_quote": "short quote from the source text"
    }
  ],
  "events": [...],
  "delete_targets": ["T1", "E2"],
  "unresolved_notes": []
}

Rules:
- Prefer Traditional Chinese.
- Keep titles concise but operational.
- Do not behave like a coach.
- CONFIRMATION & REVIEW: Always set "needs_review": true. The user confirms drafts from Dashboard before they become active.`;
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
  const memoryCount = await insertMemories(userId, batchId, result.memories || []);
  
  const reviewCount = (result.tasks?.length || 0)
    + (result.events?.length || 0)
    + (result.unresolved_notes?.length || 0);
  const autoReadyEventCount = 0;

  return { batchId, taskCount, eventCount, reviewCount, autoReadyEventCount, taskIds, memoryCount };
}



export function buildTelegramSummary(userId: string, result: ParserOutput, summary: BatchSummary & { memoryCount?: number }) {
  // Fireflies.ai style detailed summary is now in reply_message
  const reply = result.reply_message?.trim() || `已解析完成。`;

  if (summary.taskCount === 0 && summary.eventCount === 0 && (!summary.memoryCount || summary.memoryCount === 0)) {
    return reply; // Pure conversational response, no footer needed
  }

  const lines = [reply, ''];
  
  if (result.tasks && result.tasks.length > 0) {
    lines.push('📋 **擷取的待辦任務：**');
    result.tasks.forEach((t) => {
      const clientStr = t.client ? `[${t.client}] ` : '';
      const dateStr = t.deadline ? ` (期限: ${t.deadline.substring(5,10)})` : '';
      lines.push(`• ${clientStr}${t.title}${dateStr}`);
    });
    lines.push('');
  }

  if (result.events && result.events.length > 0) {
    lines.push('📅 **擷取的日曆行程：**');
    result.events.forEach((e) => {
      const clientStr = e.client ? `[${e.client}] ` : '';
      const dateStr = e.start_time ? ` (${e.start_time.substring(5,10)})` : '';
      lines.push(`• ${clientStr}${e.title}${dateStr}`);
    });
    lines.push('');
  }

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
    } else if (route.intent === 'delete_item') {
      const isClearAll = /(全部|所有|清空|一切)/.test(text);
      if (isClearAll) {
        const buttons = [
          [{ text: '⚠️ 確定清空「所有」內容', callback_data: 'del_all_content_confirm' }],
          [{ text: '❌ 取消', callback_data: 'cancel_delete' }]
        ];
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '您要求清空全部內容。這將會刪除您所有的任務與行程。確定要繼續嗎？', buttons);
      } else {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '刪除失敗：缺少刪除關鍵字。請明確指出要刪除什麼任務。');
      }
      return;
    }

    if (route.intent === 'eod_journal' || text.toLowerCase().startsWith('/eod')) {
      const eodText = text.toLowerCase().startsWith('/eod') ? text.substring(4).trim() : text;
      await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
      return;
    }



    if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    } else if (route.intent === 'chit_chat') {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, '聽不懂您的意思，可以換個方式說嗎？');
      return;
    }

    if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'supplement') {
      const latestBatch = await getLatestSourceBatch(userId);
      if (!latestBatch || !latestBatch.raw_text) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '找不到您最近的紀錄可以補充。請直接輸入新的任務或行程。');
        return;
      }
      
      const { data: recentTasks } = await supabase.from('tasks').select('id, title, client').eq('source_batch_id', latestBatch.id);
      const { data: recentEvents } = await supabase.from('calendar_intents').select('id, title, client').eq('source_batch_id', latestBatch.id);
      
      let batchContext = `Recent Meeting Context:\n"""\n${latestBatch.raw_text}\n"""\n\n`;
      batchContext += `Currently Extracted Drafts (for reference):\n`;
      
      const draftMap: Record<string, string> = {};
      recentTasks?.forEach((t, i) => {
        const shortId = `T${i+1}`;
        draftMap[shortId] = t.id;
        batchContext += `[${shortId}] (Task) Client: ${t.client || 'None'} | Title: ${t.title}\n`;
      });
      recentEvents?.forEach((e, i) => {
        const shortId = `E${i+1}`;
        draftMap[shortId] = e.id;
        batchContext += `[${shortId}] (Event) Client: ${e.client || 'None'} | Title: ${e.title}\n`;
      });

      console.log(`Starting supplement extraction for user=${userId}`);
      const result = await extractSupplementData(userId, text, batchContext);

      // Execute NLP deletions
      let deletedCount = 0;
      if (result.delete_targets && result.delete_targets.length > 0) {
        const idsToDelete: string[] = [];
        for (const target of result.delete_targets) {
          if (draftMap[target]) idsToDelete.push(draftMap[target]);
        }
        if (idsToDelete.length > 0) {
          const { error: tErr } = await supabase.from('tasks').delete().eq('user_id', userId).in('id', idsToDelete);
          const { error: eErr } = await supabase.from('calendar_intents').delete().eq('user_id', userId).in('id', idsToDelete);
          if (!tErr && !eErr) deletedCount = idsToDelete.length;
        }
      }
      
      const newRawText = latestBatch.raw_text + '\n\n[補充指令]: ' + text;
      const batchSummary = await persistExtraction(userId, newRawText, result);
      
      let replyMsg = deletedCount > 0 ? `✅ **修改成功！(已刪除 ${deletedCount} 筆舊草稿)**\n\n` : `✅ **補充成功！**\n\n`;
      replyMsg += buildTelegramSummary(userId, result, batchSummary);
      
      let buttons: TelegramButton[][] | undefined = undefined;
      if (batchSummary.taskCount > 0 || batchSummary.eventCount > 0) {
        buttons = [
          [{ text: '❌ 辨識錯誤，放棄整筆紀錄', callback_data: `reject_batch_${batchSummary.batchId}` }],
          [{ text: '🔗 前往 Dashboard 整理', url: getDashboardUrl(userId) }]
        ];
      }
      await editTelegramMessage(chatId as number, thinkingMessageId as number, replyMsg, buttons);
      return;
    }

    // Default: extract_meeting
    console.log(`Starting full extraction for user=${userId} chars=${text.length}`);
    const result = await extractMeetingData(userId, text);
    const batchSummary = await persistExtraction(userId, text, result);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const reply = `${buildTelegramSummary(userId, result, batchSummary)}\n\n⏱️ 運算耗時：${seconds} 秒`;

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
        [{ text: '❌ 辨識太爛，整筆作廢', callback_data: `reject_batch_${batchSummary.batchId}` }]
      ];
      if (batchSummary.memoryCount && batchSummary.memoryCount > 0) {
        buttons.push([{ text: '🧠 查看已存入的長期記憶', callback_data: 'view_memory' }]);
      }
      buttons.push([{ text: '🔗 前往 Dashboard 整理', url: getDashboardUrl(userId) }]);
    }

    await editTelegramMessage(chatId as number, thinkingMessageId as number, reply, buttons);
  } finally {
    stopProgressUpdates();
  }
}

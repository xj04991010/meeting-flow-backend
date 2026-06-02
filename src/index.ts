import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { z } from 'zod';
import { googleAuthRouter, googleCalendarRouter, syncBatchInternal } from './google';
import { startCronJobs } from './cron';
import { generateResearchReport } from './research';
import { telegramRoute } from './routes/telegram';
import { startJobWorker } from './jobs/workers';

dotenv.config();

// Initialize proactive background reminders
startCronJobs();
// Initialize V2 background processing workers
startJobWorker();

type Variables = { userId: string };
const app = new Hono<{ Variables: Variables }>();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const DASHBOARD_BASE_URL = 'https://mf-dashboard-2026.surge.sh';
function getDashboardUrl(uid?: string) {
  return uid ? `${DASHBOARD_BASE_URL}?uid=${uid}` : DASHBOARD_BASE_URL;
}
const PORT = Number(process.env.PORT || 3000);
const PARSER_VERSION = 'meeting-extract-v2';
const GROQ_TIMEOUT_MS = 90_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use('/api/*', cors({
  origin: ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://mf-dashboard-2026.surge.sh'],
  allowMethods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization']
}));

// Auth Middleware for TMA Validation
app.use('/api/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('tma ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid TMA token' }, 401);
  }
  
  const initData = authHeader.substring(4);
  
  // Dev fallback support
  if (initData.length === 36 && initData.includes('-')) {
    if (process.env.NODE_ENV !== 'development') {
      return c.json({ error: 'Unauthorized: Dev token in prod' }, 401);
    }
    c.set('userId', initData);
    return await next();
  }
  
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    
    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
      
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    if (calculatedHash !== hash) {
      return c.json({ error: 'Unauthorized: Invalid TMA signature' }, 401);
    }
    
    const userJson = urlParams.get('user');
    if (userJson) {
      const userObj = JSON.parse(decodeURIComponent(userJson));
      const tgId = userObj.id;
      // Convert to our internal uuid
      const { data, error } = await supabase.from('users').select('id').eq('telegram_chat_id', tgId).maybeSingle();
      if (error) console.error('TMA db error:', error);
      if (!data) return c.json({ error: 'User not found in system' }, 401);
      c.set('userId', data.id);
      return await next();
    }
    return c.json({ error: 'Unauthorized: Missing user payload' }, 401);
  } catch (err) {
    console.error('TMA validation error:', err);
    return c.json({ error: 'Unauthorized: Validation failed' }, 401);
  }
});

type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
};

const ExtractedTaskSchema = z.object({
  title: z.string().nullable().optional(),
  client: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
  category: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});
type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

const ExtractedEventSchema = z.object({
  title: z.string().nullable().optional(),
  client: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});
type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

const ParserOutputSchema = z.object({
  reply_message: z.string().nullable().optional(),
  tasks: z.array(ExtractedTaskSchema).nullable().optional(),
  events: z.array(ExtractedEventSchema).nullable().optional(),
  memories: z.array(z.string()).nullable().optional(),
  unresolved_notes: z.array(z.string().nullable()).nullable().optional()
});
type ParserOutput = z.infer<typeof ParserOutputSchema>;

type BatchSummary = {
  batchId: string | null;
  taskCount: number;
  eventCount: number;
  reviewCount: number;
  autoReadyEventCount: number;
  taskIds?: string[];
};

type RouteDecision = {
  mode: 'full_extraction' | 'supplement';
  reason: string;
};

function requireEnv() {
  const missing = [
    ['SUPABASE_URL', SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY],
    ['TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN],
    ['GROQ_API_KEY', GROQ_API_KEY]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    console.warn(`Missing environment variables: ${missing.map(([key]) => key).join(', ')}`);
  }
}

function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  if (parsed > 1) return Math.min(parsed / 100, 1);
  return Math.max(0, Math.min(parsed, 1));
}

function hasMeaningfulText(value: unknown): value is string {
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

function makeReviewFlag(confidence: number, explicitNeedsReview: unknown, hasRequiredTime = true) {
  return Boolean(explicitNeedsReview) || confidence < 0.85 || !hasRequiredTime;
}

export async function sendTelegram(chatId: number, text: string, buttons?: TelegramButton[][]) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined
      })
    });
  } catch (error) {
    console.error('sendTelegram error', error);
  }
}

async function sendThinkingMessage(chatId: number, isShort: boolean = false): Promise<number | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: isShort ? '📝 收到，為您安排中...' : '收到，我正在萃取會議中的待辦與行程。長篇紀錄可能需要 10~30 秒，請稍候。'
      })
    });
    const data = await response.json() as any;
    return data.result?.message_id || null;
  } catch (error) {
    console.error('sendThinkingMessage error', error);
    return null;
  }
}

async function editTelegramMessage(chatId: number, messageId: number, text: string, buttons?: TelegramButton[][]) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined
      })
    });
  } catch (error) {
    console.error('editTelegramMessage error', error);
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (error) {
    console.error('answerCallbackQuery error', error);
  }
}

// chat_history 已停用 — 不再寫入，避免浪費 DB 資源
// 如果未來需要 audit log，可重新啟用此函式
// async function appendChatHistory(userId: string, role: 'user' | 'assistant', content: string) { ... }

async function getOrCreateUser(telegramChatId: number): Promise<string> {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_chat_id', telegramChatId)
    .maybeSingle();

  if (user) return user.id;

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ telegram_chat_id: telegramChatId })
    .select('id')
    .single();

  if (error || !newUser) {
    throw new Error(`Failed to create user: ${error?.message || 'unknown error'}`);
  }

  return newUser.id;
}

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

interface UserSettings {
  ai_provider: string;
  ai_model: string;
  api_key: string;
}

async function getUserSettings(userId: string): Promise<UserSettings | null> {
  const { data } = await supabase.from('users').select('ai_provider, ai_model, api_key').eq('id', userId).single();
  if (!data || !data.api_key) return null;
  return data as UserSettings;
}

async function callLLM(userId: string, messages: any[], opts?: { type?: 'text' | 'json_object', temperature?: number }) {
  const settings = await getUserSettings(userId);
  const provider = settings?.ai_provider || 'groq';
  const model = settings?.ai_model || 'llama-3.3-70b-versatile';
  const apiKey = settings?.api_key || GROQ_API_KEY;

  if (!apiKey) {
    throw new Error('API Key is missing. Please configure it in the dashboard settings.');
  }

  const payload = {
    model,
    messages,
    temperature: opts?.temperature ?? 0.1,
    ...(opts?.type ? { response_format: { type: opts.type } } : {})
  };

  let endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  if (provider === 'openai') endpoint = 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS)
  });

  const data = await response.json() as any;
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `LLM request failed with status ${response.status}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!hasMeaningfulText(content)) {
    throw new Error('LLM returned an empty response');
  }

  return content;
}

function looksLikeLongMeetingNote(text: string) {
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const dateMentionCount = (text.match(/\b\d{1,2}[/-]\d{1,2}\b|明天|後天|下週|月底|月初/g) || []).length;
  const separatorCount = (text.match(/---|——|===|___/g) || []).length;
  return text.length >= 220 || lineCount >= 6 || dateMentionCount >= 4 || separatorCount >= 2;
}

function looksLikeExplicitSupplement(text: string) {
  const normalized = text.trim().toLowerCase();
  const patterns = [
    /^(上面|剛剛|剛才|前面|那篇|這篇|同一批|同一份|上一份)/,
    /(幫我)?(補|補上|新增|加上|多加|再加|追加|改成|修改|更新|刪掉|移除)/,
    /(這個|那個).*(任務|待辦|行程|日期|時間|客戶|負責人)/,
    /(上一筆|最近一筆|最新一筆).*(批次|會議|紀錄|資料)/
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

function looksLikeStandaloneShortCommand(text: string) {
  const normalized = text.trim();
  const hasContextReference = /(上面|剛剛|剛才|前面|那篇|這篇|同一批|上一筆|最近一筆)/.test(normalized);
  const hasConcreteAction = /(提醒我|排|建立|新增|記得|明天|後天|今天|下週|\d{1,2}[/-]\d{1,2})/.test(normalized);
  return text.length <= 120 && hasConcreteAction && !hasContextReference;
}

async function classifyAmbiguousShortInput(userId: string, text: string): Promise<boolean> {
  try {
    const content = await callLLM(userId, [
      { role: 'system', content: `判斷使用者的輸入是否是「針對剛才會議紀錄的補充或修改指示」(例如：上面那篇多加一個任務、把日期改成明天、新增一個行程)，還是「完全無關的閒聊或全新的大篇幅獨立事件」。如果是補充修改，輸出 { "is_supplement": true }，否則輸出 { "is_supplement": false }。` },
      { role: 'user', content: text }
    ], { type: 'json_object' });
    const parsed = JSON.parse(content || '{}');
    return !!parsed.is_supplement;
  } catch (e) {
    return false;
  }
}

async function decideInputRoute(userId: string, text: string): Promise<RouteDecision> {
  const latestBatch = await getLatestSourceBatch(userId);
  if (!latestBatch) return { mode: 'full_extraction', reason: 'no_source_batch' };
  if (looksLikeLongMeetingNote(text)) return { mode: 'full_extraction', reason: 'long_meeting_note' };
  if (looksLikeExplicitSupplement(text)) return { mode: 'supplement', reason: 'explicit_supplement_rule' };
  if (looksLikeStandaloneShortCommand(text)) return { mode: 'full_extraction', reason: 'standalone_short_command' };

  if (text.length <= 200) {
    const isSupplement = await classifyAmbiguousShortInput(userId, text);
    return {
      mode: isSupplement ? 'supplement' : 'full_extraction',
      reason: isSupplement ? 'llm_router_supplement' : 'llm_router_full'
    };
  }

  return { mode: 'full_extraction', reason: 'default_full' };
}

function buildBatchContext(batch: { summary?: string | null; raw_text?: string | null }) {
  const summary = batch.summary ? `Summary: ${batch.summary.trim()}\n\n` : '';
  const rawText = batch.raw_text || '';
  const contextLimit = 8000;
  const clippedRawText = rawText.length > contextLimit
    ? `${rawText.slice(0, contextLimit)}\n\n[內容過長，已截斷]`
    : rawText;
  return `${summary}Raw meeting note:\n${clippedRawText}`;
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

async function routeIntent(userId: string, text: string): Promise<IntentOutput> {
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

async function extractMeetingData(userId: string, text: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let content = '';
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

async function extractSupplementData(userId: string, text: string, batchContext: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let content = '';
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

async function createSourceBatch(userId: string, rawText: string, result: ParserOutput): Promise<string | null> {
  const taskCount = result.tasks?.length || 0;
  const eventCount = result.events?.length || 0;
  const reviewCount = [
    ...(result.tasks || []).map((task) => makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)),
    ...(result.events || []).map((event) => makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
  ].filter(Boolean).length + (result.unresolved_notes?.length || 0);

  const { data, error } = await supabase
    .from('source_batches')
    .insert({
      user_id: userId,
      source_type: 'telegram',
      raw_text: rawText,
      parser_version: PARSER_VERSION,
      summary: result.reply_message || null,
      metadata: {
        task_count: taskCount,
        event_count: eventCount,
        review_count: reviewCount,
        unresolved_notes: result.unresolved_notes || []
      }
    })
    .select('id')
    .single();

  if (error) {
    console.error('createSourceBatch error', error);
    return null;
  }

  return data.id;
}

async function insertTasks(userId: string, batchId: string | null, tasks: ExtractedTask[]) {
  const rows = tasks
    .filter((task) => hasMeaningfulText(task.title))
    .map((task) => {
      const confidence = normalizeConfidence(task.confidence);
      return {
        user_id: userId,
        title: (task.title || '').trim(),
        category: task.category || '其他',
        status: makeReviewFlag(confidence, task.needs_review) ? 'needs_review' : 'pending',
        deadline: task.deadline || null,
        priority: task.priority || 'medium',
        source_batch_id: batchId,
        client: task.client || null,
        owner: task.owner || null,
        confidence,
        needs_review: makeReviewFlag(confidence, task.needs_review),
        source_quote: task.source_quote || null
      };
    });

  if (rows.length === 0) return 0;

  const { data, error } = await supabase.from('tasks').insert(rows).select('id');
  if (!error) return data.map(d => d.id);

  console.error('insertTasks rich schema error', error);

  const fallbackRows = rows.map(({ user_id, title, category, status, deadline }) => ({
    user_id,
    title,
    category,
    status,
    deadline
  }));
  const fallback = await supabase.from('tasks').insert(fallbackRows).select('id');
  if (fallback.error) throw new Error(`Failed to insert tasks: ${fallback.error.message}`);
  return fallback.data.map(d => d.id);
}

async function insertEvents(userId: string, batchId: string | null, events: ExtractedEvent[]) {
  const rows = events
    .filter((event) => hasMeaningfulText(event.title) && hasMeaningfulText(event.start_time))
    .map((event) => {
      const confidence = normalizeConfidence(event.confidence);
      const needsReview = makeReviewFlag(confidence, event.needs_review, hasMeaningfulText(event.start_time));
      return {
        user_id: userId,
        title: (event.title || '').trim(),
        start_time: event.start_time,
        end_time: event.end_time || null,
        action_type: 'propose_create',
        status: needsReview ? 'needs_review' : 'ready',
        source_batch_id: batchId,
        client: event.client || null,
        location: event.location || null,
        confidence,
        needs_review: needsReview,
        source_quote: event.source_quote || null,
        sync_status: needsReview ? 'pending_review' : 'ready'
      };
    });

  if (rows.length === 0) return 0;

  const { error } = await supabase.from('calendar_intents').insert(rows);
  if (!error) return rows.length;

  console.error('insertEvents rich schema error', error);

  const fallbackRows = rows.map(({ user_id, title, start_time, end_time, action_type, status }) => ({
    user_id,
    title,
    start_time,
    end_time,
    action_type,
    status
  }));
  const fallback = await supabase.from('calendar_intents').insert(fallbackRows);
  if (fallback.error) throw new Error(`Failed to insert events: ${fallback.error.message}`);
  return rows.length;
}

async function insertMemories(userId: string, memories: string[]) {
  if (!memories || memories.length === 0) return 0;
  const rows = memories.filter(hasMeaningfulText).map(content => ({
    user_id: userId,
    content: content.trim()
  }));
  if (rows.length === 0) return 0;
  
  const { error } = await supabase.from('memories').insert(rows);
  if (error) console.error('insertMemories error', error);
  return rows.length;
}

async function persistExtraction(userId: string, rawText: string, result: ParserOutput): Promise<BatchSummary & { taskIds?: string[], memoryCount?: number }> {
  const batchId = await createSourceBatch(userId, rawText, result);
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

async function persistSupplement(userId: string, existingBatchId: string, result: ParserOutput): Promise<BatchSummary & { memoryCount?: number }> {
  const tasksResult = await insertTasks(userId, existingBatchId, result.tasks || []);
  const taskCount = Array.isArray(tasksResult) ? tasksResult.length : (tasksResult as number);
  const eventCount = await insertEvents(userId, existingBatchId, result.events || []);
  const memoryCount = await insertMemories(userId, result.memories || []);
  const reviewCount = [
    ...(result.tasks || []).map((task) => makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)),
    ...(result.events || []).map((event) => makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
  ].filter(Boolean).length + (result.unresolved_notes?.length || 0);
  const autoReadyEventCount = (result.events || [])
    .filter((event) => !makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
    .length;

  return { batchId: existingBatchId, taskCount, eventCount, reviewCount, autoReadyEventCount, memoryCount };
}

function buildTelegramSummary(userId: string, result: ParserOutput, summary: BatchSummary & { memoryCount?: number }) {
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

function nullableText(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableDate(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
}

function booleanOrUndefined(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

async function getTelegramFileBuffer(fileId: string): Promise<Buffer> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json() as any;
  if (!data.ok) throw new Error('Failed to get file info from Telegram');
  const filePath = data.result.file_path;
  
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function transcribeAudio(audioBuffer: Buffer, filename: string, apiKey: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([audioBuffer as any], { type: 'audio/ogg' });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-large-v3-turbo');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData as any
  });
  
  if (!res.ok) {
    throw new Error(`Groq transcription failed: ${await res.text()}`);
  }
  const data = await res.json() as any;
  return data.text;
}

export async function processTelegramUpdate(message: any) {
  const chatId = message.chat?.id;
  let text = message.text?.trim();
  
  if (!chatId) return;

  let existingThinkingMessageId: number | null = null;

  // Handle Voice Messages (Magic Feature 1)
  if (message.voice) {
    const userId = await getOrCreateUser(chatId);
    existingThinkingMessageId = await sendThinkingMessage(chatId, false);
    try {
      const audioBuffer = await getTelegramFileBuffer(message.voice.file_id);
      text = await transcribeAudio(audioBuffer, 'voice.ogg', GROQ_API_KEY);
      
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
      const report = await generateResearchReport(query, isUrl);
      
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
    .select('title, deadline, status')
    .eq('user_id', userId)
    .not('status', 'eq', 'rejected');

  const pendingTasks = tasks?.filter(t => t.status !== 'completed') || [];

  const lines = ['🗓️ **未來一週排程與待辦總覽**\n'];

  if (events && events.length > 0) {
    lines.push('📅 **未來一週行程**：');
    events.forEach(e => {
      const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      lines.push(`• [${timeStr}] ${e.title}`);
    });
    lines.push('');
  } else {
    lines.push('📅 未來一週沒有安排行程。\n');
  }

  if (pendingTasks.length > 0) {
    lines.push('✅ **未完成待辦清單**：');
    pendingTasks.forEach(t => {
      lines.push(`• ${t.title}`);
    });
  } else {
    lines.push('✅ 目前沒有未完成的待辦！');
  }

  lines.push(`\n🔗 [打開 Dashboard 排程](${getDashboardUrl(userId)})`);
  await editTelegramMessage(chatId, thinkingId, lines.join('\n'));
}

async function handleCallbackQuery(callback: any) {
  const data = callback.data;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const originalText = callback.message?.text || '';

  if (data && data.startsWith('remind_')) {
    const parts = data.split('_');
    const taskId = parts[1];
    const offsetStr = parts.slice(2).join('_');
    
    let targetTime = new Date();
    let displayTime = '';
    
    if (offsetStr === '30m') {
      targetTime.setMinutes(targetTime.getMinutes() + 30);
      displayTime = '30分鐘後';
    } else if (offsetStr === '1d') {
      targetTime.setDate(targetTime.getDate() + 1);
      displayTime = '明天';
    } else if (offsetStr === '1w') {
      targetTime.setDate(targetTime.getDate() + 7);
      displayTime = '下週';
    } else if (offsetStr === '1m') {
      targetTime.setMonth(targetTime.getMonth() + 1);
      displayTime = '一個月後';
    }

    const { error } = await supabase.from('tasks').update({
      deadline: targetTime.toISOString()
    }).eq('id', taskId);

    if (!error) {
      await answerCallbackQuery(callback.id, `已設定提醒：${displayTime}`);
      
      const newText = originalText + `\n\n✅ 已設定推播提醒：${displayTime}`;
      await editTelegramMessage(chatId, messageId, newText, [[{ text: '打開 Dashboard 修改', url: getDashboardUrl() }]]);
    } else {
      await answerCallbackQuery(callback.id, '設定失敗，請稍後再試。');
    }
    return;
  }

  if (data && data.startsWith('postpone_task_')) {
    const taskId = data.replace('postpone_task_', '');
    
    // Set to tomorrow 9 AM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const { error } = await supabase.from('tasks').update({
      deadline: tomorrow.toISOString()
    }).eq('id', taskId);

    if (!error) {
      await answerCallbackQuery(callback.id, '✅ 已為您延後至明天早上 9 點');
      const newText = originalText + `\n\n*(✔️ 已幫您延後至明天早上)*`;
      await editTelegramMessage(chatId, messageId, newText, []); // Remove buttons
    } else {
      await answerCallbackQuery(callback.id, '設定失敗，請稍後再試。');
    }
    return;
  }

  if (data && data.startsWith('sync_batch_')) {
    const batchId = data.replace('sync_batch_', '');
    
    // 1. Set all tasks to pending (removing needs_review flag)
    await supabase.from('tasks').update({ needs_review: false, status: 'pending' }).eq('source_batch_id', batchId).eq('needs_review', true);
    
    // 2. Set all events to ready
    await supabase.from('calendar_intents').update({ needs_review: false, sync_status: 'ready', status: 'ready' }).eq('source_batch_id', batchId).eq('needs_review', true);
    
    // 3. Trigger sync-batch API internally
    const { data: user } = await supabase.from('users').select('id').eq('telegram_chat_id', chatId).maybeSingle();
    if (user) {
       try {
         await syncBatchInternal(user.id);
       } catch (err) {
         console.error('Internal sync failed', err);
       }
    }

    // 4. Update message to remove the button and reflect sync status
    await answerCallbackQuery(callback.id, '✅ 已全部確認並嘗試同步！');
    const newText = originalText
      .replace('⚠️ **狀態：等待人工二次確認**', '✅ **狀態：已全部授權同步**')
      .replace('所有擷取的項目目前皆設為「待審閱」，請點擊下方按鈕前往 Dashboard 進行確認，確認後才會同步至您的 Google 日曆。', '所有行程已排入同步佇列！');
      
    await editTelegramMessage(chatId, messageId, newText, [[{ text: '打開 Dashboard 修改細節', url: getDashboardUrl() }]]);
    return;
  }

  if (data && data.startsWith('del_all_kw_')) {
    const keyword = data.replace('del_all_kw_', '');
    const { data: user } = await supabase.from('users').select('id').eq('telegram_chat_id', chatId).maybeSingle();
    
    if (user) {
      const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', user.id).ilike('title', `%${keyword}%`).limit(5);
      if (tasks && tasks.length > 0) {
        const ids = tasks.map(t => t.id);
        await supabase.from('tasks').delete().in('id', ids);
        await answerCallbackQuery(callback.id, `✅ 已為您刪除 ${tasks.length} 筆任務！`);
        
        const titles = tasks.map(t => `- ${t.title}`).join('\n');
        await editTelegramMessage(chatId, messageId, `✅ **已成功批次刪除以下任務：**\n\n${titles}`);
      } else {
        await answerCallbackQuery(callback.id, `找不到任務。`);
        await editTelegramMessage(chatId, messageId, `❌ 找不到相關任務，可能已被刪除。`);
      }
    }
    return;
  }

  if (data && data.startsWith('delete_task_')) {
    const taskId = data.replace('delete_task_', '');
    const { data: task } = await supabase.from('tasks').select('title').eq('id', taskId).single();
    if (task) {
      await supabase.from('tasks').delete().eq('id', taskId);
      await answerCallbackQuery(callback.id, `✅ 任務已刪除！`);
      await editTelegramMessage(chatId, messageId, `✅ 已成功為您刪除任務：「${task.title}」`);
    } else {
      await answerCallbackQuery(callback.id, `找不到該任務。`);
      await editTelegramMessage(chatId, messageId, `❌ 找不到該任務，可能已被刪除。`);
    }
    return;
  }

  if (data === 'cancel_delete') {
    await answerCallbackQuery(callback.id, `已取消操作。`);
    await editTelegramMessage(chatId, messageId, `操作已取消。`);
    return;
  }

  await answerCallbackQuery(callback.id, '新版流程已改到 Dashboard 處理。');

  if (!chatId || !messageId) return;

  await editTelegramMessage(
    chatId,
    messageId,
    '舊版逐條確認按鈕已停用。請到 Dashboard 檢查與修改批次結果。',
    [[{ text: '打開 Dashboard', web_app: { url: getDashboardUrl() } }]]
  );
}

app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'MeetingFlow Backend API',
    parser_version: PARSER_VERSION
  });
});

// GET /api/documents - Get deep research documents
app.get('/api/documents', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const { data, error } = await supabase
    .from('research_documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch documents:', error);
    return c.json({ error: error.message }, 500);
  }

  return c.json({ documents: data });
});

// GET /api/dashboard/weekly - Structured Weekly View
app.get('/api/dashboard/weekly', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const [
    { data: user },
    { data: tokenData },
    { data: tasks },
    { data: intents },
    { data: batches }
  ] = await Promise.all([
    supabase.from('users').select('*').eq('id', userId).single(),
    supabase.from('google_tokens').select('id').eq('user_id', userId).maybeSingle(),
    supabase.from('tasks').select('*').eq('user_id', userId).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(300),
    supabase.from('calendar_intents').select('*').eq('user_id', userId).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(300),
    supabase.from('source_batches').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
  ]);

  const userWithAuth = user ? { ...user, is_calendar_authorized: !!tokenData } : null;

  // 取得基準時間的 YYYY-MM-DD
  const dateQuery = c.req.query('date');
  const now = dateQuery ? new Date(dateQuery) : new Date();
  const getTaipeiDate = (d: Date) => d.toLocaleString('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = getTaipeiDate(now);
  const todayTime = new Date(todayStr).getTime();

  // 準備周曆 Buckets (-1 昨天, 0 今天, 1 明天, 2 後天, 3 大後天, 99 未來)
  const bucketsMap = new Map();
  const addDays = (d: Date, days: number) => {
    const nd = new Date(d);
    nd.setDate(nd.getDate() + days);
    return nd;
  };
  
  const labels = {
    '-1': '昨天',
    '0': '今天',
    '1': '明天',
    '2': '後天',
    '3': '大後天'
  };

  for (let i = -1; i <= 3; i++) {
    const dStr = getTaipeiDate(addDays(now, i));
    bucketsMap.set(dStr, {
      date: dStr,
      label: labels[i.toString() as keyof typeof labels],
      is_today: i === 0,
      tasks: [],
      events: []
    });
  }
  bucketsMap.set('future', { date: 'future', label: '未來行程', is_today: false, tasks: [], events: [] });
  bucketsMap.set('past', { date: 'past', label: '較早以前', is_today: false, tasks: [], events: [] });

  const unscheduled_tasks: any[] = [];

  // Helper: 將項目放進對應的 Bucket
  const assignToBucket = (item: any, dateField: string, collection: 'tasks' | 'events') => {
    if (!item[dateField]) {
      if (collection === 'tasks') unscheduled_tasks.push(item);
      return;
    }
    const itemDateStr = getTaipeiDate(new Date(item[dateField]));
    
    if (bucketsMap.has(itemDateStr)) {
      bucketsMap.get(itemDateStr)[collection].push(item);
    } else {
      const itemTime = new Date(itemDateStr).getTime();
      if (itemTime > todayTime) {
        bucketsMap.get('future')[collection].push(item);
      } else {
        bucketsMap.get('past')[collection].push(item);
      }
    }
  };

  (tasks || []).forEach(t => assignToBucket(t, 'deadline', 'tasks'));
  (intents || []).forEach(e => assignToBucket(e, 'start_time', 'events'));

  const week_view = Array.from(bucketsMap.values());

  return c.json({
    user: userWithAuth,
    week_view,
    unscheduled_tasks,
    batches: batches || [],
    tasks: tasks || [],
    calendarIntents: intents || []
  });
});

app.patch('/api/tasks/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ status: string }>();
  const { error } = await supabase
    .from('tasks')
    .update({
      status: body.status,
      needs_review: body.status === 'needs_review'
    })
    .eq('id', id)
    .eq('user_id', c.get('userId'));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.patch('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ('title' in body) {
    const title = nullableText(body.title);
    if (!title) return c.json({ error: 'title is required' }, 400);
    update.title = title;
  }

  if ('client' in body) {
    update.client = nullableText(body.client);
    update.category = nullableText(body.client) || 'meeting';
  }

  if ('owner' in body) update.owner = nullableText(body.owner);
  if ('deadline' in body) update.deadline = nullableDate(body.deadline);

  if ('status' in body) {
    const status = nullableText(body.status);
    if (status) update.status = status;
    if (!('needs_review' in body)) update.needs_review = status === 'needs_review';
  }

  if ('needs_review' in body) {
    const needsReview = booleanOrUndefined(body.needs_review);
    if (needsReview !== undefined) update.needs_review = needsReview;
  }

  const { error } = await supabase
    .from('tasks')
    .update(update)
    .eq('id', id)
    .eq('user_id', c.get('userId'));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.patch('/api/calendar-intents/:id/status', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ status: string; sync_status: string }>();
  const { error } = await supabase
    .from('calendar_intents')
    .update({
      status: body.status,
      sync_status: body.sync_status,
      needs_review: body.status === 'needs_review'
    })
    .eq('id', id)
    .eq('user_id', c.get('userId'));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.patch('/api/calendar-intents/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ('title' in body) {
    const title = nullableText(body.title);
    if (!title) return c.json({ error: 'title is required' }, 400);
    update.title = title;
  }

  if ('client' in body) update.client = nullableText(body.client);
  if ('location' in body) update.location = nullableText(body.location);
  if ('start_time' in body) update.start_time = nullableDate(body.start_time);
  if ('end_time' in body) update.end_time = nullableDate(body.end_time);

  if ('status' in body) {
    const status = nullableText(body.status);
    if (status) update.status = status;
    if (!('needs_review' in body)) update.needs_review = status === 'needs_review';
  }

  if ('sync_status' in body) {
    const syncStatus = nullableText(body.sync_status);
    if (syncStatus) update.sync_status = syncStatus;
  }

  if ('needs_review' in body) {
    const needsReview = booleanOrUndefined(body.needs_review);
    if (needsReview !== undefined) update.needs_review = needsReview;
  }

  const { error } = await supabase
    .from('calendar_intents')
    .update(update)
    .eq('id', id)
    .eq('user_id', c.get('userId'));

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// Mount V2 Telegram Webhook (includes Fast ACK & Dedup)
app.route('/', telegramRoute);

app.post('/api/extract', async (c) => {
  try {
    const userId = c.get('userId');
    const { raw_text } = await c.req.json();
    if (!raw_text || !userId) return c.json({ error: 'raw_text and userId are required' }, 400);

    const route = await routeIntent(userId, raw_text);
    if (route.intent === 'delete_item') {
      return c.json({ error: '偵測到刪除指令。請直接點擊網頁上的「垃圾桶」圖示進行刪除，或透過 Telegram 助理操作。' }, 400);
    }
    if (route.intent === 'query_schedule') {
      return c.json({ error: '偵測到查詢指令。您已經在 Dashboard 上了，可以直接觀看畫面喔！' }, 400);
    }
    if (route.intent === 'chit_chat') {
      return c.json({ error: route.reply_message || '請輸入會議紀錄或待辦事項。閒聊請找 Telegram 助理！' }, 400);
    }

    let result;
    let newRawText = raw_text;
    if (route.intent === 'supplement') {
      const latestBatch = await getLatestSourceBatch(userId);
      if (latestBatch && latestBatch.raw_text) {
        result = await extractSupplementData(userId, raw_text, latestBatch.raw_text);
        newRawText = latestBatch.raw_text + '\n\n[補充指令]: ' + raw_text;
      } else {
        result = await extractMeetingData(userId, raw_text);
      }
    } else {
      result = await extractMeetingData(userId, raw_text);
    }
    
    const summary = await persistExtraction(userId, newRawText, result);

    return c.json({ ok: true, result, summary });
  } catch (error: any) {
    console.error('Extraction API error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/user-settings', async (c) => {
  const userId = c.get('userId');
  const { data, error } = await supabase.from('users').select('ai_provider, ai_model, api_key').eq('id', userId).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || {});
});

app.patch('/api/user-settings', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const { error } = await supabase.from('users').update({
    ai_provider: body.ai_provider,
    ai_model: body.ai_model,
    api_key: body.api_key
  }).eq('id', userId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.route('/auth', googleAuthRouter);
app.route('/api', googleCalendarRouter);

requireEnv();

const cron = require('node-cron');

function setupCronJobs() {
  // Daily Briefing at 09:00 AM (Taipei Time)
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running Daily Briefing...');
    try {
      const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
      if (!users) return;

      const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
      
      for (const user of users) {
        const [tasksResult, eventsResult, memoriesResult, rawFact] = await Promise.all([
          supabase.from('tasks').select('title, category, priority').eq('user_id', user.id).neq('status', 'completed'),
          supabase.from('calendar_intents').select('title, start_time').eq('user_id', user.id).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
          supabase.from('memories').select('content').eq('user_id', user.id),
          fetch('https://uselessfacts.jsph.pl/api/v2/facts/random').then(r => r.json()).then((d: any) => d.text).catch(() => '')
        ]);
        
        const tasks = tasksResult.data;
        const events = eventsResult.data;
        const memories = memoriesResult.data;

        if ((!tasks || tasks.length === 0) && (!events || events.length === 0) && (!memories || memories.length === 0)) continue;

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

        const reply = await callLLM(user.id, [{ role: 'user', content: prompt }]);
        if (reply) {
          await sendTelegram(user.telegram_chat_id, `🌅 **[晨間簡報]**\n\n${reply}`);
        }
      }
    } catch (e) {
      console.error('[Cron] Daily Briefing error:', e);
    }
  }, { timezone: 'Asia/Taipei' });

  // Deadline Nudging at 15:00 (Taipei Time)
  cron.schedule('0 15 * * *', async () => {
    console.log('[Cron] Running Deadline Nudging...');
    try {
      const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
      if (!users) return;

      const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
      
      for (const user of users) {
        // Find high priority tasks due today that are still pending
        const { data: tasks } = await supabase.from('tasks')
          .select('id, title, category')
          .eq('user_id', user.id)
          .neq('status', 'completed')
          .eq('priority', 'high')
          .gte('deadline', todayStr)
          .lt('deadline', todayStr + 'T23:59:59');

        if (!tasks || tasks.length === 0) continue;

        const prompt = `You are a top-tier Executive Assistant. Your persona is a minimalist, precise, zero-bullshit, data-driven expert serving an INTJ/ENTJ boss.
It's 3:00 PM. The user has HIGH PRIORITY tasks due today that are NOT YET COMPLETED:
${JSON.stringify(tasks)}

Write a hyper-efficient, data-driven status check. No polite fluff. Demand an immediate execution status update (Complete / Postpone / In Progress) based on logical necessity.
Use Traditional Chinese and minimal emojis.`;

        const reply = await callLLM(user.id, [{ role: 'user', content: prompt }]);
        if (reply) {
          await sendTelegram(user.telegram_chat_id, `🚨 **[進度追蹤]**\n\n${reply}`);
        }
      }
    } catch (e) {
      console.error('[Cron] Deadline Nudging error:', e);
    }
  }, { timezone: 'Asia/Taipei' });
}

console.log(`MeetingFlow backend is running on port ${PORT}`);

setupCronJobs();

serve({
  fetch: app.fetch,
  port: PORT
}, async (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
  
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl && TELEGRAM_BOT_TOKEN) {
    // V2 Route matches POST /webhook on the root
    const webhookUrl = `${externalUrl}/webhook`; 
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const data = await res.json() as any;
      if (data.ok) {
        console.log(`✅ Webhook successfully set to ${webhookUrl}`);
      } else {
        console.error(`❌ Failed to set webhook:`, data);
      }
    } catch (e) {
      console.error(`❌ Error setting webhook:`, e);
    }
  } else {
    console.log('⚠️ No RENDER_EXTERNAL_URL found. Webhook not set automatically. If testing locally, use ngrok.');
  }
});

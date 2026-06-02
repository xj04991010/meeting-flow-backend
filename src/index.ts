import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { googleAuthRouter, googleCalendarRouter } from './google';
import { startCronJobs } from './cron';
import { generateResearchReport } from './research';

dotenv.config();

// Initialize proactive background reminders
startCronJobs();

type Variables = { userId: string };
const app = new Hono<{ Variables: Variables }>();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const DASHBOARD_URL = 'https://mf-dashboard-2026.surge.sh';
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

type ExtractedTask = {
  title: string;
  client?: string | null;
  owner?: string | null;
  deadline?: string | null;
  priority?: 'high' | 'normal' | 'low';
  confidence?: number | null;
  needs_review?: boolean | null;
  source_quote?: string | null;
};

type ExtractedEvent = {
  title: string;
  client?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
  confidence?: number | null;
  needs_review?: boolean | null;
  source_quote?: string | null;
};

type ParserOutput = {
  reply_message?: string;
  tasks?: ExtractedTask[];
  events?: ExtractedEvent[];
  unresolved_notes?: string[];
};

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

async function callLLM(userId: string, messages: any[], responseFormat?: any) {
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
    temperature: 0.1,
    ...(responseFormat ? { response_format: responseFormat } : {})
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

function buildExtractionPrompt(todayStr: string) {
  return `You are a world-class AI Executive Assistant. Your job is to extract structured tasks and calendar events from raw, messy, and chaotic conversations (like LINE, WhatsApp, WeChat, or Slack logs).
Current Datetime (Asia/Taipei): ${todayStr}

Mission:
- Extract every actionable task and calendar event from the user's text.
- NOISE REDUCTION: The text may contain venting, cursing, jokes, or emotional outbursts. Ignore all non-actionable chatter. Focus strictly on execution and deliverables.
- DELEGATION & OWNERSHIP: If the text assigns work (e.g., "@Jack", "交給Tom"), assign them as the 'owner'. If someone says "我來處理" (I'll handle it), assign the sender as the owner.
- SPEAKER DIARIZATION & FIREFLIES.AI STYLE: If there are multiple speakers, identify them (Speaker A, Speaker B). Extract action items assigned to specific people.
- MEETING KEY POINTS (會議要點): Summarize the meeting thoroughly in the 'reply_message'. This must read like a professional Fireflies.ai executive summary, including:
  1. 📝 Executive Summary (會議總結)
  2. 🗣️ Speaker Notes (發言要點)
  3. ✅ Action Items by Owner (各負責人待辦)
- MANUAL SECONDARY CONFIRMATION: The user MUST manually review all events and tasks before they are synced to Google Calendar. Therefore, you MUST set "needs_review": true for EVERY SINGLE task and event extracted. Do not auto-approve anything.
- CONVERSATIONAL FALLBACK: If the user is simply chatting, asking a question, or providing non-actionable input (e.g. "你有幾種功能", "你好"), DO NOT hallucinate tasks or events. Output an empty list for tasks and events. In 'reply_message', just provide a natural, helpful, and conversational response (no Fireflies format needed). Only use the Fireflies format when there are actual meeting points or tasks to extract.
- STRICT CATEGORIZATION:
  * Events (events): Meetings, physical appointments. Must have a time constraint.
  * Tasks (tasks): Deliverables, script writing, video editing, etc.
- SMART TIME INFERENCE:
  * "明天" (tomorrow) -> infer exact date.
  * "下週" (next week) -> infer next Monday or specific day if mentioned.
- LINK & ASSET RETENTION: Always preserve URLs in the 'source_quote' or 'title'.

Output JSON only:
{
  "reply_message": "If conversation, just reply naturally. If a meeting/schedule, output DETAILED Markdown summary formatted like Fireflies.ai. Use Traditional Chinese.",
  "tasks": [
    {
      "title": "specific action item (include context prefix)",
      "client": "client/project name or null",
      "owner": "person responsible or null",
      "deadline": "ISO-8601 datetime with timezone if clear, otherwise null",
      "priority": "high or medium or low",
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
  "unresolved_notes": ["important ambiguous notes that need dashboard review"]
}

Rules:
- Prefer Traditional Chinese (zh-TW).
- ALL tasks and events MUST have "needs_review": true.
- Never output markdown outside the JSON structure.
- Never use a single mutually-exclusive type field.`;
}

async function extractMeetingData(userId: string, text: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const content = await callLLM(userId, [
    { role: 'system', content: buildExtractionPrompt(todayStr) },
    { role: 'user', content: text }
  ], { type: 'json_object' });

  const parsed = JSON.parse(content || '{}') as ParserOutput;
  return {
    reply_message: parsed.reply_message || '',
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    unresolved_notes: Array.isArray(parsed.unresolved_notes) ? parsed.unresolved_notes : []
  };
}

function buildSupplementPrompt(todayStr: string, batchContext: string) {
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
  "tasks": [...],
  "events": [...],
  "unresolved_notes": []
}

Rules:
- Prefer Traditional Chinese.
- Keep titles concise but operational.
- Do not behave like a coach.`;
}

async function extractSupplementData(userId: string, text: string, batchContext: string): Promise<ParserOutput> {
  const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const content = await callLLM(userId, [
    { role: 'system', content: buildSupplementPrompt(todayStr, batchContext) },
    { role: 'user', content: text }
  ], { type: 'json_object' });

  const parsed = JSON.parse(content || '{}') as ParserOutput;
  return {
    reply_message: parsed.reply_message || '',
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    unresolved_notes: Array.isArray(parsed.unresolved_notes) ? parsed.unresolved_notes : []
  };
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
        title: task.title.trim(),
        category: task.client || 'meeting',
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
        title: event.title.trim(),
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

async function persistExtraction(userId: string, rawText: string, result: ParserOutput): Promise<BatchSummary & { taskIds?: string[] }> {
  const batchId = await createSourceBatch(userId, rawText, result);
  const tasksResult = await insertTasks(userId, batchId, result.tasks || []);
  const taskIds = Array.isArray(tasksResult) ? tasksResult : [];
  const taskCount = Array.isArray(tasksResult) ? tasksResult.length : (tasksResult as number);
  const eventCount = await insertEvents(userId, batchId, result.events || []);
  const reviewCount = [
    ...(result.tasks || []).map((task) => makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)),
    ...(result.events || []).map((event) => makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
  ].filter(Boolean).length + (result.unresolved_notes?.length || 0);
  const autoReadyEventCount = (result.events || [])
    .filter((event) => !makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
    .length;

  return { batchId, taskCount, eventCount, reviewCount, autoReadyEventCount, taskIds };
}

async function persistSupplement(userId: string, existingBatchId: string, result: ParserOutput): Promise<BatchSummary> {
  const tasksResult = await insertTasks(userId, existingBatchId, result.tasks || []);
  const taskCount = Array.isArray(tasksResult) ? tasksResult.length : (tasksResult as number);
  const eventCount = await insertEvents(userId, existingBatchId, result.events || []);
  const reviewCount = [
    ...(result.tasks || []).map((task) => makeReviewFlag(normalizeConfidence(task.confidence), task.needs_review)),
    ...(result.events || []).map((event) => makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
  ].filter(Boolean).length + (result.unresolved_notes?.length || 0);
  const autoReadyEventCount = (result.events || [])
    .filter((event) => !makeReviewFlag(normalizeConfidence(event.confidence), event.needs_review, hasMeaningfulText(event.start_time)))
    .length;

  return { batchId: existingBatchId, taskCount, eventCount, reviewCount, autoReadyEventCount };
}

function buildTelegramSummary(result: ParserOutput, summary: BatchSummary) {
  // Fireflies.ai style detailed summary is now in reply_message
  const reply = result.reply_message?.trim() || `已成功萃取內容！`;

  if (summary.taskCount === 0 && summary.eventCount === 0) {
    return reply; // Pure conversational response, no footer needed
  }

  const lines = [reply, ''];
  lines.push('---');
  lines.push(`💡 **系統已自動擷取 ${summary.taskCount} 件待辦與 ${summary.eventCount} 個行程**`);
  lines.push('⚠️ **狀態：等待人工二次確認**');
  lines.push('所有擷取的項目目前皆設為「待審閱」，請點擊下方按鈕前往 Dashboard 進行確認，確認後才會同步至您的 Google 日曆。');
  lines.push('');
  // 使用正式的 Surge 網址
  lines.push('🔗 [點此開啟 Dashboard 進行二次確認](https://mf-dashboard-2026.surge.sh)');
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

async function processTelegramUpdate(message: any) {
  const chatId = message.chat?.id;
  const text = message.text?.trim();
  console.log(`[DEBUG] processTelegramUpdate called. chatId: ${chatId}, text: ${text}`);

  if (!chatId || !text) return;

  const lowerText = text.toLowerCase();

  if (lowerText === '/start') {
    const userId = await getOrCreateUser(chatId);
    const reply = 'MeetingFlow 已切回會議萃取模式。直接貼上會議紀錄，我會批次抽出待辦、行程與待確認項目。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: DASHBOARD_URL }]]);
    return;
  }

  if (lowerText === '/week') {
    const userId = await getOrCreateUser(chatId);
    await handleWeekCommand(chatId, userId);
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
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: DASHBOARD_URL }]]);
    return;
  }

  const greetings = ['你好', '嗨', '哈囉', 'hello', 'hi', 'test', '測試', '安安', '早安', '午安', '晚安', '在嗎'];
  if (text.length <= 10 && greetings.some(g => text.toLowerCase().includes(g))) {
    const reply = '你好！我是你的 MeetingFlow 智能助理 👋\n\n你可以直接傳送「會議紀錄」或是「待辦事項」給我，我會幫你自動抽出任務與行程。\n\n輸入 /week 即可查看未來一週的行程與待辦總覽！';
    await sendTelegram(chatId, reply);
    return;
  }

  const isShort = text.length <= 50;
  const thinkingMessageId = await sendThinkingMessage(chatId, isShort);

  const userId = await getOrCreateUser(chatId);

  if (message.voice) {
    const reply = '目前尚未接上語音轉文字。請先貼文字版會議紀錄，我會批次萃取待辦與行程。';
    await editTelegramMessage(chatId as number, thinkingMessageId as number, reply);
    return;
  }

  // chat_history 已停用

  const startedAt = Date.now();
  const stopProgressUpdates = startProgressUpdates(chatId as number, thinkingMessageId as number, isShort);

  try {
    // 簡化路由：所有輸入統一走 full_extraction
    // Supplement Mode 已移除，避免過度工程化
    console.log(`Starting full extraction for user=${userId} chars=${text.length}`);
    const result = await extractMeetingData(userId, text);
    const batchSummary = await persistExtraction(userId, text, result);

    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const reply = isShort 
      ? buildTelegramSummary(result, batchSummary) 
      : `${buildTelegramSummary(result, batchSummary)}\n\n⏱️ 耗時：約 ${seconds} 秒`;

    console.log(`Finished extraction for user=${userId} seconds=${seconds} tasks=${batchSummary.taskCount} events=${batchSummary.eventCount}`);
    
    let buttons: TelegramButton[][] | undefined = undefined;
    const taskIds = batchSummary.taskIds as string[];
    if (isShort && batchSummary.taskCount === 1 && taskIds && taskIds.length === 1) {
      const tid = taskIds[0];
      buttons = [
        [{ text: '半小時', callback_data: `remind_${tid}_30m` }, { text: '明天 (1天)', callback_data: `remind_${tid}_1d` }],
        [{ text: '下週 (7天)', callback_data: `remind_${tid}_1w` }, { text: '下個月', callback_data: `remind_${tid}_1m` }]
      ];
    } else {
      buttons = [[{ text: '打開 Dashboard', url: DASHBOARD_URL }]];
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

      await editTelegramMessage(chatId, thinkingMessageId as number, `✅ 深度研究完成！已將報告加入您的 Dashboard：\n\n📌 **${title}**\n\n[打開 Dashboard 閱讀](${DASHBOARD_URL})`);
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

  lines.push('\n🔗 [打開 Dashboard 排程](http://localhost:5173)');
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
      await editTelegramMessage(chatId, messageId, newText, [[{ text: '打開 Dashboard 修改', url: DASHBOARD_URL }]]);
    } else {
      await answerCallbackQuery(callback.id, '設定失敗，請稍後再試。');
    }
    return;
  }

  await answerCallbackQuery(callback.id, '新版流程已改到 Dashboard 處理。');

  if (!chatId || !messageId) return;

  await editTelegramMessage(
    chatId,
    messageId,
    '舊版逐條確認按鈕已停用。請到 Dashboard 檢查與修改批次結果。',
    [[{ text: '打開 Dashboard', web_app: { url: DASHBOARD_URL } }]]
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

  const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
  const { data: tokenData } = await supabase.from('google_tokens').select('id').eq('user_id', userId).maybeSingle();
  const userWithAuth = user ? { ...user, is_calendar_authorized: !!tokenData } : null;

  const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', userId).neq('status', 'cancelled').order('created_at', { ascending: false });
  const { data: intents } = await supabase.from('calendar_intents').select('*').eq('user_id', userId).neq('status', 'cancelled').order('created_at', { ascending: false });
  const { data: batches } = await supabase.from('source_batches').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(5);

  // 取得現在台北時間的 YYYY-MM-DD
  const now = new Date();
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
    .eq('id', id);

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
    .eq('id', id);

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
    .eq('id', id);

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
    .eq('id', id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.post('/webhook', async (c) => {
  try {
    const update = await c.req.json();

    if (update.update_id) {
      const { data: existingEvent } = await supabase
        .from('message_events')
        .select('id')
        .eq('update_id', update.update_id)
        .maybeSingle();

      if (existingEvent) return c.text('OK');

      await supabase.from('message_events').insert({
        update_id: update.update_id,
        payload: update,
        status: 'received'
      });
    }

    if (update.message) {
      processTelegramUpdate(update.message).catch((error) => console.error('Async worker failed:', error));
    } else if (update.callback_query) {
      handleCallbackQuery(update.callback_query).catch((error) => console.error('Callback worker failed:', error));
    }

    return c.text('OK');
  } catch (error) {
    console.error('Webhook error', error);
    return c.text('OK');
  }
});

app.post('/api/extract', async (c) => {
  try {
    const userId = c.get('userId');
    const { raw_text } = await c.req.json();
    if (!raw_text || !userId) return c.json({ error: 'raw_text and userId are required' }, 400);

    const result = await extractMeetingData(userId, raw_text);
    const summary = await persistExtraction(userId, raw_text, result);

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

console.log(`MeetingFlow backend is running on port ${PORT}`);

// --- Background Cron Daemon (Push Notifications) ---
const notifiedTasks = new Set<string>();
let lastDigestMarker = '';

setInterval(async () => {
  try {
    const now = new Date();
    const taipeiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const todayStr = taipeiTime.getFullYear() + '-' + String(taipeiTime.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiTime.getDate()).padStart(2, '0');
    const currentHour = taipeiTime.getHours();
    
    // 1. Daily Digest (Morning 09:00, Evening 21:00)
    const digestKey = currentHour === 9 ? 'morning' : currentHour === 21 ? 'evening' : null;
    const marker = `${todayStr}_${digestKey}`;

    if (digestKey && lastDigestMarker !== marker) {
      lastDigestMarker = marker;
      const { data: users } = await supabase.from('users').select('id, telegram_chat_id');
      for (const u of (users || [])) {
        if (!u.telegram_chat_id) continue;
        const { data: pendingTasks } = await supabase.from('tasks')
          .select('title, deadline')
          .eq('user_id', u.id)
          .neq('status', 'completed')
          .neq('status', 'cancelled');
        
        if (pendingTasks && pendingTasks.length > 0) {
          const greeting = digestKey === 'morning' ? '🌅 早安！' : '🌙 晚安！今日總結：';
          let msg = `${greeting} 您的助理來追殺您了！\n\n目前您有 ${pendingTasks.length} 件尚未完成的待辦：\n`;
          pendingTasks.slice(0, 10).forEach(t => {
            msg += `• ${t.title || '任務'}\n`;
          });
          if (pendingTasks.length > 10) msg += `...及其他 ${pendingTasks.length - 10} 件任務。\n`;
          msg += '\n請記得盡快處理喔！趕快打開 Dashboard 把卡片打勾吧！';
          await sendTelegram(Number(u.telegram_chat_id), msg, [[{ text: '打開 Dashboard', url: DASHBOARD_URL }]]);
        }
      }
    }

    // 2. Deadline Reminders (Check every minute)
    // Find tasks where deadline <= now and deadline > now - 1 hour
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const currentIso = now.toISOString();

    const { data: dueTasks } = await supabase.from('tasks')
      .select('id, user_id, title, deadline')
      .lte('deadline', currentIso)
      .gte('deadline', oneHourAgo)
      .neq('status', 'completed')
      .neq('status', 'cancelled');

    for (const t of (dueTasks || [])) {
      if (!notifiedTasks.has(t.id)) {
        notifiedTasks.add(t.id);
        const { data: u } = await supabase.from('users').select('telegram_chat_id').eq('id', t.user_id).single();
        if (u && u.telegram_chat_id) {
          await sendTelegram(Number(u.telegram_chat_id), `🔔 **溫馨提醒**\n\n您的待辦事項【${t.title}】已經到期啦！\n請記得處理喔！`, [[{ text: '去 Dashboard 確認', url: DASHBOARD_URL }]]);
        }
      }
    }

  } catch (error) {
    console.error('Background cron error:', error);
  }
}, 60000);

serve({
  fetch: app.fetch,
  port: PORT
});

// --- Telegram Long Polling (no tunnel needed!) ---
let pollingOffset = 0;

async function telegramPoll() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${pollingOffset}&timeout=30&allowed_updates=["message","callback_query"]`;
  const res = await fetch(url);
  const data = await res.json() as any;
  if (!data.ok || !data.result) return;

  for (const update of data.result) {
    pollingOffset = update.update_id + 1;

    // Dedup via message_events table
    const { data: existingEvent } = await supabase
      .from('message_events')
      .select('id')
      .eq('update_id', update.update_id)
      .maybeSingle();
    if (existingEvent) continue;

    await supabase.from('message_events').insert({
      update_id: update.update_id,
      payload: update,
      status: 'received'
    });

    if (update.message) {
      processTelegramUpdate(update.message).catch((error) => console.error('Polling worker failed:', error));
    } else if (update.callback_query) {
      handleCallbackQuery(update.callback_query).catch((error) => console.error('Polling callback failed:', error));
    }
  }
}

async function startPolling() {
  console.log('🔄 Telegram polling mode started (no tunnel needed)');
  // Clear any leftover webhook
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`);
  
  let errorCount = 0;
  
  while (true) {
    try {
      await telegramPoll();
      errorCount = 0; // reset on success
    } catch (err: any) {
      errorCount++;
      const backoff = Math.min(30000, 2000 * Math.pow(2, errorCount - 1));
      console.error(`Telegram polling error (attempt ${errorCount}). Retrying in ${backoff}ms...`, err.message);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

startPolling();

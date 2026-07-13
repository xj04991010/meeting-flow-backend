import { createClient } from '@supabase/supabase-js';
import { routeIntent } from './services/intent-router.service';

import { handleMorningCommand } from './services/command-handlers/morning.handler';
import { handleNudgingCommand } from './services/command-handlers/nudging.handler';
import { handleEveningCommand } from './services/command-handlers/evening.handler';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { z } from 'zod';
import { googleAuthRouter, googleCalendarRouter, syncBatchInternal } from './google';
import { startCronJobs } from './cron';
import { generateResearchReport } from './research';
import { telegramRoute } from './routes/telegram';
import { startJobWorker } from './jobs/workers';
import { sendTelegram, sendThinkingMessage, editTelegramMessage, answerCallbackQuery, getTelegramFileBuffer } from './services/telegram.service';
import { callLLM, transcribeAudio } from './services/llm.service';
import { getOrCreateUser } from './repositories/users.repo';

dotenv.config();

const backgroundJobsDisabled = process.env.DISABLE_BACKGROUND_JOBS === 'true' || process.env.NODE_ENV === 'test';

if (!backgroundJobsDisabled) {
  // Initialize proactive background reminders and V2 background processing workers.
  startCronJobs();
  startJobWorker();
} else {
  console.log('[BOOT] Background cron jobs and workers disabled.');
}

type Variables = { userId: string };
const app = new Hono<{ Variables: Variables }>();

import { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, GROQ_API_KEY, DASHBOARD_BASE_URL, DASHBOARD_ACCESS_TOKEN, getDashboardUrl, PORT, PARSER_VERSION, GROQ_TIMEOUT_MS, requireEnv, CRON_SECRET } from './utils/env';

// Validate environment variables immediately
requireEnv();

import { supabase } from './utils/db';

const defaultOrigins = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'https://meeting-flow-dashboard.onrender.com',
  DASHBOARD_BASE_URL
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : defaultOrigins;
const privateNetworkOrigin = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d{1,5})?$/;

function isAllowedOrigin(origin: string) {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin) || privateNetworkOrigin.test(origin);
}

function secureTokenEquals(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

app.use('/api/*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    return isAllowedOrigin(origin) ? origin : undefined;
  },
  allowMethods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Dashboard-User-Id']
}));

// Auth Middleware for TMA Validation
app.use('/api/*', async (c, next) => {
  // Skip TMA auth for server-to-server cron endpoints
  if (c.req.path.startsWith('/api/cron/')) {
    return await next();
  }

  const authHeader = c.req.header('Authorization');

  if (authHeader?.startsWith('dashboard ')) {
    const dashboardToken = authHeader.substring('dashboard '.length).trim();
    const dashboardUserId = c.req.header('X-Dashboard-User-Id') || process.env.DASHBOARD_USER_ID || '';

    if (!DASHBOARD_ACCESS_TOKEN || !secureTokenEquals(dashboardToken, DASHBOARD_ACCESS_TOKEN)) {
      return c.json({ error: 'Unauthorized: Invalid dashboard token' }, 401);
    }

    if (!dashboardUserId) {
      return c.json({ error: 'Unauthorized: Missing dashboard user id' }, 401);
    }

    c.set('userId', dashboardUserId);
    return await next();
  }
  
  if (!authHeader || !authHeader.startsWith('tma ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid TMA token' }, 401);
  }
  
  const initData = authHeader.substring(4);
  
  // Dev fallback support — ONLY in non-production
  if (process.env.NODE_ENV !== 'production' && initData.length === 36 && initData.includes('-')) {
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
    
    const authDateStr = urlParams.get('auth_date');
    if (!authDateStr) {
      return c.json({ error: 'Unauthorized: Missing auth_date' }, 401);
    }
    const authDate = parseInt(authDateStr, 10);
    const now = Math.floor(Date.now() / 1000);
    // Token is valid for 24 hours (86400 seconds)
    if (now - authDate > 86400) {
      return c.json({ error: 'Unauthorized: Token expired' }, 401);
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

import { ExtractedTaskSchema, ExtractedTask, ExtractedEventSchema, ExtractedEvent, ParserOutputSchema, ParserOutput, BatchSummary } from './schemas/extraction.schema';





import { getLatestSourceBatch } from './repositories/source-batches.repo';
import { acquireCronLock } from './services/cron-lock.service';
import { checkCronWindow } from './services/cron-window.service';
import { 
  processTelegramUpdate, 
  nullableText, 
  nullableDate, 
  booleanOrUndefined
} from './services/message-handler.service';
import { getClientDateLinksForMonth, getClientWeeklyNoteWeeks, getClientWeeklyNotes, upsertClientWeeklyNote, getLatestNotesForAllClients } from './repositories/client-weekly-notes.repo';
import { getClients, createClient as repoCreateClient, updateClient } from './repositories/clients.repo';
import { answerClientAssistant } from './services/client-assistant.service';


app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'MeetingFlow Backend API',
    parser_version: PARSER_VERSION
  });
});

function cronWindowSkip(jobType: string) {
  const window = checkCronWindow(jobType);
  if (window.allowed) return null;
  return {
    ok: true,
    skipped: true,
    message: `Outside ${jobType} schedule window`,
    current_time: window.currentTime,
    allowed_window: window.windowLabel
  };
}

app.post('/api/cron/morning', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  const skipped = cronWindowSkip('morning');
  if (skipped) return c.json(skipped);
  if (!(await acquireCronLock('morning'))) return c.json({ ok: true, skipped: true, message: 'Already ran today' });
  
  const { handleMorningCommand } = await import('./services/command-handlers/morning.handler');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    for (const user of users) {
      await handleMorningCommand(user.telegram_chat_id, user.id);
    }
  }
  
  return c.json({ ok: true, message: 'Morning push sent' });
});

app.post('/api/cron/nudging', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  const skipped = cronWindowSkip('nudging');
  if (skipped) return c.json(skipped);
  if (!(await acquireCronLock('nudging'))) return c.json({ ok: true, skipped: true, message: 'Already ran today' });
  
  const { handleNudgingCommand } = await import('./services/command-handlers/nudging.handler');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    for (const user of users) {
      await handleNudgingCommand(user.telegram_chat_id, user.id);
    }
  }
  
  return c.json({ ok: true, message: 'Nudging push sent' });
});

app.post('/api/cron/weekly', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await acquireCronLock('weekly'))) return c.json({ ok: true, skipped: true, message: 'Already ran today' });
  
  const { decayUnusedMemories } = await import('./services/memory.service');
  await decayUnusedMemories();
  
  return c.json({ ok: true, message: 'Weekly memory decay processed' });
});

app.post('/api/cron/evening', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  const skipped = cronWindowSkip('evening');
  if (skipped) return c.json(skipped);
  if (!(await acquireCronLock('evening'))) return c.json({ ok: true, skipped: true, message: 'Already ran today' });
  
  const { handleEveningCommand } = await import('./services/command-handlers/evening.handler');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    for (const user of users) {
      await handleEveningCommand(user.telegram_chat_id, user.id);
    }
  }
  
  return c.json({ ok: true, message: 'Evening push sent' });
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

app.get('/api/dashboard/journals', async (c) => {
  const userId = c.get('userId');
  const { data, error } = await supabase.from('daily_journals').select('*').eq('user_id', userId).order('date', { ascending: false }).limit(7);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

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
    supabase.from('source_batches').select('*, ai_candidates(*)').eq('user_id', userId).order('created_at', { ascending: false }).limit(5)
  ]);

  const userWithAuth = user ? { ...user, is_calendar_authorized: !!tokenData } : null;

  // 取得基準時間的 YYYY-MM-DD
  const dateQuery = c.req.query('date');
  const now = dateQuery ? new Date(dateQuery) : new Date();
  const getTaipeiDate = (d: Date) => d.toLocaleString('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = getTaipeiDate(now);
  const todayTime = new Date(todayStr).getTime();

  // 準備周曆 Buckets (前天、昨天、今天 到 未來四天，共七格，或九格)
  // 依據使用者需求，加入前兩天
  const bucketsMap = new Map();
  const WEEKDAYS_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  for (let i = -2; i < 7; i++) {
    const currentDay = new Date(now);
    currentDay.setDate(now.getDate() + i);
    const dStr = getTaipeiDate(currentDay);
    const isToday = i === 0;
    
    let label = isToday ? '今天' : WEEKDAYS_ZH[currentDay.getDay()];
    if (i === 1) label = '明天';
    if (i === -1) label = '昨天';
    if (i === -2) label = '前天';

    bucketsMap.set(dStr, {
      date: dStr,
      label: label,
      is_today: isToday,
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

  if ('category' in body) {
    update.category = nullableText(body.category) || '其他';
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

app.post('/api/manual-entry', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json<Record<string, unknown>>();

    const text = nullableText(body.text);
    if (!text) return c.json({ error: 'text is required' }, 400);

    const client = nullableText(body.client);
    const category = nullableText(body.category) || client || '專案紀錄';
    const linkedDate = nullableDate(body.linked_date);

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title: text,
        client,
        category,
        owner: null,
        deadline: linkedDate,
        priority: 'medium',
        status: 'pending',
        confidence: 1,
        needs_review: false,
        source_quote: text,
      })
      .select('*')
      .single();

    if (error) return c.json({ error: error.message }, 500);
    return c.json({ ok: true, task: data });
  } catch (error: any) {
    console.error('Manual entry API error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// ─── Clients API ───────────────────────────────

app.get('/api/clients', async (c) => {
  const userId = c.get('userId');
  try {
    const clients = await getClients(userId);
    return c.json({ clients });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/clients', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'Client name is required' }, 400);

  try {
    const client = await repoCreateClient(userId, body);
    return c.json(client);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.patch('/api/clients/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json();

  try {
    const client = await updateClient(userId, id, body);
    return c.json(client);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ─── Client Weekly Notes API ──────────────────

app.get('/api/client-notes', async (c) => {
  const userId = c.get('userId');
  const weekKey = c.req.query('week_key');
  const inherit = c.req.query('inherit') !== 'false';
  if (!weekKey) return c.json({ error: 'week_key is required' }, 400);

  try {
    let notes = await getClientWeeklyNotes(userId, weekKey);
    
    // 如果當週完全沒有資料，則撈取各客戶「最新」的歷史紀錄來繼承
    if (inherit && (!notes || notes.length === 0)) {
      const latestNotes = await getLatestNotesForAllClients(userId);
      if (latestNotes.length > 0) {
        // 將舊紀錄替換 week_key 後回傳（前端可以決定要不要直接存檔，或是等使用者修改後才存）
        notes = latestNotes.map((n: any) => ({
          ...n,
          id: undefined, // 不帶 id，避免前端以為是既有資料
          week_key: weekKey,
        }));
      }
    }
    
    return c.json({ notes });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/client-note-weeks', async (c) => {
  const userId = c.get('userId');
  try {
    const weeks = await getClientWeeklyNoteWeeks(userId);
    return c.json({ weeks });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/client-date-links', async (c) => {
  const userId = c.get('userId');
  const month = c.req.query('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return c.json({ error: 'month must use YYYY-MM format' }, 400);
  }
  try {
    const links = await getClientDateLinksForMonth(userId, month);
    return c.json({ links });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.put('/api/client-notes', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  
  if (!body.client_name || !body.week_key) {
    return c.json({ error: 'client_name and week_key are required' }, 400);
  }

  try {
    await upsertClientWeeklyNote(userId, body);
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.put('/api/client-notes/batch', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  
  if (!body.week_key || !Array.isArray(body.notes)) {
    return c.json({ error: 'week_key and notes array are required' }, 400);
  }

  try {
    for (const note of body.notes) {
      if (note.client_name) {
        await upsertClientWeeklyNote(userId, { ...note, week_key: body.week_key });
      }
    }
    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

const ClientAssistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  week_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

app.post('/api/client-assistant', async (c) => {
  const userId = c.get('userId');
  const parsed = ClientAssistantRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'message is required and must be under 2000 characters' }, 400);
  }

  try {
    const answer = await answerClientAssistant(userId, parsed.data.message, parsed.data.week_key);
    if (!answer) return c.json({ error: 'AI assistant is temporarily unavailable' }, 503);
    return c.json({ answer });
  } catch (error: any) {
    console.error('Client assistant error:', error);
    return c.json({ error: 'AI assistant failed' }, 500);
  }
});

// Mount V2 Telegram Webhook (includes Fast ACK & Dedup)
app.route('/', telegramRoute);



app.get('/api/user-settings', async (c) => {
  const userId = c.get('userId');
  const { data, error } = await supabase.from('users').select('ai_provider, ai_model, api_key').eq('id', userId).single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    ai_provider: data?.ai_provider,
    ai_model: data?.ai_model,
    has_api_key: !!data?.api_key
  });
});

app.patch('/api/user-settings', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  const updateData: any = {
    ai_provider: body.ai_provider,
    ai_model: body.ai_model,
  };
  if (body.api_key) {
    updateData.api_key = body.api_key;
  }
  
  const { error } = await supabase.from('users').update(updateData).eq('id', userId);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

app.post('/api/cron/proactive', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return c.text('Unauthorized', 401);
  }
  const skipped = cronWindowSkip('proactive');
  if (skipped) return c.json(skipped);
  if (!(await acquireCronLock('proactive'))) return c.json({ ok: true, skipped: true, message: 'Already ran today' });
  try {
    const { scanMemoriesAndGenerateTasks } = await import('./services/proactive.service');
    const { data: users } = await supabase.from('users').select('id');
    if (users) {
      for (const u of users) {
        await scanMemoriesAndGenerateTasks(u.id);
      }
    }
    return c.json({ ok: true, message: 'Proactive scan completed' });
  } catch (error: any) {
    console.error('Proactive API error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.route('/auth', googleAuthRouter);
app.route('/api', googleCalendarRouter);

requireEnv();

console.log(`MeetingFlow backend is running on port ${PORT}`);

if (process.env.NODE_ENV !== 'test') {
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
        const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET ? `&secret_token=${process.env.TELEGRAM_WEBHOOK_SECRET}` : '';
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}${secretToken}`);
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
}

export default app;

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
import { sendTelegram, sendThinkingMessage, editTelegramMessage, answerCallbackQuery, getTelegramFileBuffer } from './services/telegram.service';
import { callLLM, transcribeAudio } from './services/llm.service';
import { getOrCreateUser } from './repositories/users.repo';

dotenv.config();

// Initialize proactive background reminders
startCronJobs();
// Initialize V2 background processing workers
startJobWorker();

type Variables = { userId: string };
const app = new Hono<{ Variables: Variables }>();

import { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, GROQ_API_KEY, DASHBOARD_BASE_URL, getDashboardUrl, PORT, PARSER_VERSION, GROQ_TIMEOUT_MS, requireEnv, CRON_SECRET } from './utils/env';

// Validate environment variables immediately
requireEnv();

import { supabase } from './utils/db';

const defaultOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://meeting-flow-backend-1.onrender.com'];
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : defaultOrigins;

app.use('/api/*', cors({
  origin: allowedOrigins,
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
import { 
  processTelegramUpdate, 
  nullableText, 
  nullableDate, 
  booleanOrUndefined, 
  routeIntent, 
  extractMeetingData, 
  extractSupplementData, 
  persistExtraction 
} from './services/message-handler.service';
import { handleCallbackQuery } from './services/callback-handler.service';


app.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'MeetingFlow Backend API',
    parser_version: PARSER_VERSION
  });
});

// POST /api/cron/morning - Triggered by GitHub Actions
app.post('/api/cron/morning', async (c) => {
  const token = c.req.header('x-cron-token');
  if (token !== 'meeting-flow-morning-2026') return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleMorningCommand } = await import('./services/message-handler.service');
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
  if (token !== 'meeting-flow-morning-2026') return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleNudgingCommand } = await import('./services/message-handler.service');
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
  if (token !== 'meeting-flow-morning-2026') return c.json({ error: 'Unauthorized' }, 401);
  
  const { decayUnusedMemories } = await import('./services/memory.service');
  await decayUnusedMemories();
  
  return c.json({ ok: true, message: 'Weekly memory decay processed' });
});

app.post('/api/cron/evening', async (c) => {
  const token = c.req.header('x-cron-token');
  if (token !== 'meeting-flow-morning-2026') return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleEveningCommand } = await import('./services/message-handler.service');
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

      const { handleMorningCommand } = await import('./services/message-handler.service');
      for (const user of users) {
        await handleMorningCommand(user.telegram_chat_id, user.id);
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

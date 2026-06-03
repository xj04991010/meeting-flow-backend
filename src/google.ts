import { Hono } from 'hono';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

import { supabase } from './utils/db';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

export const googleAuthRouter = new Hono();

// GET /auth/google?user_id=xxx
googleAuthRouter.get('/google', (c) => {
  const userId = c.req.query('user_id');
  if (!userId) return c.json({ error: 'user_id is required' }, 400);

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Force to get refresh token
    scope: SCOPES,
    state: userId // pass user_id so we know who to save the token for
  });
  
  return c.redirect(url);
});

// GET /auth/google/callback
googleAuthRouter.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  const userId = c.req.query('state');
  
  if (!code || !userId) {
    return c.json({ error: 'Missing code or user_id (state)' }, 400);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    // Save to supabase
    const { error } = await supabase.from('google_tokens').upsert({
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scope: tokens.scope,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }); // Note: you might need to make user_id UNIQUE in the DB for upsert to work properly, or just insert/delete.
    
    if (error) {
      console.error('Save token error:', error);
      return c.json({ error: 'Failed to save token' }, 500);
    }
    
    return c.html(`
      <h2>Google Calendar 授權成功！</h2>
      <p>您的帳號已成功綁定。您可以關閉此視窗並回到 Dashboard。</p>
      <script>setTimeout(() => window.close(), 3000);</script>
    `);
  } catch (err: any) {
    console.error('OAuth callback error:', err);
    return c.json({ error: 'Authentication failed', details: err.message }, 500);
  }
});

// ---------------------------------------------
// Calendar Sync APIs
// ---------------------------------------------
export const googleCalendarRouter = new Hono<{ Variables: { userId: string } }>();

// GET /api/auth/google/status
googleCalendarRouter.get('/auth/google/status', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);
  const { data } = await supabase.from('google_tokens').select('id').eq('user_id', userId).maybeSingle();
  return c.json({ hasAuth: !!data });
});

async function getGoogleAuthClient(userId: string) {
  const { data, error } = await supabase
    .from('google_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();
    
  if (error || !data) return null;
  
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date ? new Date(data.expiry_date).getTime() : null
  });
  
  return client;
}

// POST /api/calendar-intents/:id/sync
googleCalendarRouter.post('/calendar-intents/:id/sync', async (c) => {
  const intentId = c.req.param('id');
  
  const userId = c.get('userId');
  
  // Get intent details
  const { data: intent, error: intentError } = await supabase
    .from('calendar_intents')
    .select('*')
    .eq('id', intentId)
    .eq('user_id', userId)
    .single();
    
  if (intentError || !intent) return c.json({ error: 'Intent not found' }, 404);
  if (!intent.start_time) return c.json({ error: 'start_time is required' }, 400);
  if (intent.sync_status === 'synced') return c.json({ error: 'Already synced' }, 400);

  const authClient = await getGoogleAuthClient(intent.user_id);
  if (!authClient) return c.json({ error: 'Google Calendar not authorized. Please visit /auth/google first.', code: 'NOT_AUTHORIZED' }, 401);
  
  const calendar = google.calendar({ version: 'v3', auth: authClient });
  
  try {
    const eventParams: any = {
      summary: intent.title,
      description: intent.source_quote ? `來源備註: ${intent.source_quote}` : '',
      start: { dateTime: new Date(intent.start_time).toISOString() },
      end: { dateTime: new Date(intent.end_time || new Date(new Date(intent.start_time).getTime() + 60*60*1000)).toISOString() }
    };
    if (intent.location) eventParams.location = intent.location;
    
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventParams
    });
    
    // Update DB
    await supabase.from('calendar_intents').update({
      sync_status: 'synced',
      external_calendar_id: res.data.id,
      synced_at: new Date().toISOString()
    }).eq('id', intentId);
    
    return c.json({ success: true, eventId: res.data.id });
  } catch (err: any) {
    console.error('Calendar sync error:', err);
    
    await supabase.from('calendar_intents').update({
      sync_status: 'failed'
    }).eq('id', intentId);
    
    return c.json({ error: 'Failed to sync event', details: err.message }, 500);
  }
});

// POST /api/calendar-intents/sync-batch
googleCalendarRouter.post('/calendar-intents/sync-batch', async (c) => {
  const userId = c.get('userId');

  const result = await syncBatchInternal(userId);
  if ('error' in result) {
    return c.json(result, result.code === 'NOT_AUTHORIZED' ? 401 : 500);
  }
  return c.json(result);
});

export async function syncBatchInternal(userId: string) {
  if (!userId) return { error: 'user_id is required', code: 'BAD_REQUEST' };
  
  const { data: intents } = await supabase
    .from('calendar_intents')
    .select('id')
    .eq('user_id', userId)
    .eq('sync_status', 'ready')
    .not('start_time', 'is', null);
    
    
  if (!intents || intents.length === 0) return { success: true, synced_count: 0 };
  
  // Phase 2: Idempotency (Optimistic Locking)
  const intentIds = intents.map(i => i.id);
  const { data: lockedIntents, error: lockError } = await supabase
    .from('calendar_intents')
    .update({ sync_status: 'processing' })
    .in('id', intentIds)
    .eq('sync_status', 'ready')
    .select('*');
    
  if (lockError || !lockedIntents || lockedIntents.length === 0) {
    return { success: true, synced_count: 0, message: 'Already processing' };
  }

  // Helper for Phase 3: Proactive Notification
  const notifyAuthFailure = async () => {
    try {
      const { data: user } = await supabase.from('users').select('telegram_chat_id').eq('id', userId).single();
      if (user && user.telegram_chat_id) {
        const url = `https://meeting-flow-backend-1.onrender.com?uid=${userId}`;
        const replyMarkup = { inline_keyboard: [[{ text: '重新綁定 Google', url: url }]] };
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: user.telegram_chat_id, text: '⚠️ 您的 Google 日曆授權已失效或過期，請點擊下方按鈕前往 Dashboard 重新綁定！', reply_markup: replyMarkup })
        });
      }
    } catch (e) {
      console.error('Failed to notify', e);
    }
  };
  
  const authClient = await getGoogleAuthClient(userId);
  if (!authClient) {
    await supabase.from('calendar_intents').update({ sync_status: 'auth_failed' }).in('id', intentIds);
    await notifyAuthFailure();
    return { error: 'Google Calendar not authorized', code: 'NOT_AUTHORIZED' };
  }
  
  const calendar = google.calendar({ version: 'v3', auth: authClient });
  
  let syncedCount = 0;
  const errors = [];
  
  for (const intent of lockedIntents) {
    if (intent.needs_review) {
      await supabase.from('calendar_intents').update({ sync_status: 'pending_review' }).eq('id', intent.id);
      continue;
    }
    
    try {
      const eventParams: any = {
        summary: intent.title,
        description: intent.source_quote ? `來源備註: ${intent.source_quote}` : '',
        start: { dateTime: new Date(intent.start_time).toISOString() },
        end: { dateTime: new Date(intent.end_time || new Date(new Date(intent.start_time).getTime() + 60*60*1000)).toISOString() }
      };
      if (intent.location) eventParams.location = intent.location;
      
      const res = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: eventParams
      });
      
      await supabase.from('calendar_intents').update({
        sync_status: 'synced',
        external_calendar_id: res.data.id,
        synced_at: new Date().toISOString()
      }).eq('id', intent.id);
      
      syncedCount++;
    } catch (e: any) {
      console.error('Batch sync error for intent', intent.id, e);
      errors.push({ id: intent.id, error: e.message });
      
      const errStr = e.message || '';
      if (errStr.includes('invalid_grant') || errStr.includes('Unauthorized') || e.code === 401) {
        await supabase.from('calendar_intents').update({ sync_status: 'auth_failed' }).eq('id', intent.id);
        await notifyAuthFailure();
        // Break out of loop since auth is totally dead
        break;
      } else {
        await supabase.from('calendar_intents').update({ sync_status: 'failed' }).eq('id', intent.id);
      }
    }
  }
  
  
  return { success: true, synced_count: syncedCount, errors };
}

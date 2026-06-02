import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { sendTelegram } from './index';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// Keep track of notified events to prevent duplicate notifications
const notifiedEventIds = new Set<string>();

/**
 * Start all proactive background reminders
 */
export function startCronJobs() {
  console.log('[CRON] Starting background cron jobs...');

  // 1. Daily Morning Briefing (every day at 08:00 Asia/Taipei)
  cron.schedule('0 8 * * *', async () => {
    console.log('[CRON] Running daily morning briefing...');
    try {
      const { data: users } = await supabase.from('users').select('id, telegram_chat_id');
      if (!users) return;

      // Get today's start and end in ISO for querying
      const now = new Date();
      const taipeiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const todayStr = taipeiTime.getFullYear() + '-' + String(taipeiTime.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiTime.getDate()).padStart(2, '0');
      
      const startOfDay = new Date(`${todayStr}T00:00:00+08:00`);
      const endOfDay = new Date(`${todayStr}T23:59:59+08:00`);

      for (const u of users) {
        if (!u.telegram_chat_id) continue;

        // Fetch today's events
        const { data: events } = await supabase
          .from('calendar_intents')
          .select('*')
          .eq('user_id', u.id)
          .gte('start_time', startOfDay.toISOString())
          .lte('start_time', endOfDay.toISOString())
          .neq('status', 'cancelled')
          .order('start_time', { ascending: true });

        // Fetch pending tasks
        const { data: tasks } = await supabase
          .from('tasks')
          .select('*')
          .eq('user_id', u.id)
          .neq('status', 'completed')
          .neq('status', 'cancelled');

        // Only send if there is something to report
        if ((!events || events.length === 0) && (!tasks || tasks.length === 0)) continue;

        let message = `☀️ 早安！今天是 ${todayStr}，這是您一天的行程與待辦總覽：\n\n`;

        if (events && events.length > 0) {
          message += `🗓️ **今日行程**：\n`;
          events.forEach(e => {
            const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
            message += `- ${timeStr} ${e.title}\n`;
          });
          message += `\n`;
        }

        if (tasks && tasks.length > 0) {
          const highPriority = tasks.slice(0, 5); // Just show top 5
          message += `📝 **重點待辦清單**：\n`;
          highPriority.forEach(t => {
            message += `- [ ] ${t.title}\n`;
          });
          if (tasks.length > 5) {
            message += `- (還有 ${tasks.length - 5} 項待辦在您的 Dashboard...)\n`;
          }
        }

        await sendTelegram(Number(u.telegram_chat_id), message);
      }
    } catch (e) {
      console.error('[CRON] Daily briefing error:', e);
    }
  }, {
    timezone: "Asia/Taipei"
  });

  // 2. Pre-Meeting Alerts (every minute)
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Look for events starting between now and now + 15 minutes
      const nowPlus15 = new Date(now.getTime() + 15 * 60000);

      const { data: events } = await supabase
        .from('calendar_intents')
        .select('*, users(telegram_chat_id)')
        .gte('start_time', now.toISOString())
        .lte('start_time', nowPlus15.toISOString())
        .neq('status', 'cancelled');

      if (!events || events.length === 0) return;

      for (const e of events) {
        if (!e.users || !e.users.telegram_chat_id) continue;
        
        // Check memory to avoid duplicate alerts
        if (notifiedEventIds.has(e.id)) continue;
        notifiedEventIds.add(e.id);

        const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' });
        const message = `⏰ **行程提醒**\n\n您的會議/行程「${e.title}」將於 ${timeStr} 開始 (15分鐘內)！`;
        
        await sendTelegram(Number(e.users.telegram_chat_id), message);
      }
      
      // Cleanup old memory to prevent memory leak
      // If we have thousands of events, this could grow. 
      // But for a personal bot, it's fine. We could optionally delete old IDs.
    } catch (e) {
      console.error('[CRON] Pre-meeting alert error:', e);
    }
  });
}

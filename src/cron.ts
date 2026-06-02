import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { sendTelegram } from './services/telegram.service';

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

  // 3. Deadline Reminders (Check every minute)
  const notifiedTasks = new Set<string>();
  const reminderTemplates = [
    (title: string) => `🔔 **溫馨提醒**\n\n您的待辦事項【${title}】已經到期啦！\n請記得處理喔！ 🏃‍♂️`,
    (title: string) => `✨ **貼心提醒**\n\n您的任務【${title}】時間到了！\n趕快去完成它吧，你可以的！ 💪`,
    (title: string) => `⏰ **任務到期**\n\n【${title}】的死線就在眼前了！\n現在就動手把它消滅吧！ 🔥`
  ];

  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
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
            const template = reminderTemplates[Math.floor(Math.random() * reminderTemplates.length)];
            const message = template(t.title);
            
            const dashboardUrl = `https://mf-dashboard-2026.surge.sh?uid=${t.user_id}`;
            const buttons = [
              [{ text: '📅 幫我延到明天', callback_data: `postpone_task_${t.id}` }],
              [{ text: '✅ 我去 Dashboard 看', url: dashboardUrl }]
            ];
            await sendTelegram(Number(u.telegram_chat_id), message, buttons);
          }
        }
      }
    } catch (error) {
      console.error('Background task cron error:', error);
    }
  });
}

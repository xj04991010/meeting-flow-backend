const fs = require('fs');
let code = fs.readFileSync('src/index.ts', 'utf8');

code = code.replace(
  /import \{ SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, GROQ_API_KEY, DASHBOARD_BASE_URL, getDashboardUrl, PORT, PARSER_VERSION, GROQ_TIMEOUT_MS, requireEnv \} from '\.\/utils\/env';/g,
  "import { SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, GROQ_API_KEY, DASHBOARD_BASE_URL, getDashboardUrl, PORT, PARSER_VERSION, GROQ_TIMEOUT_MS, requireEnv, CRON_SECRET } from './utils/env';"
);

// Replace the morning cron endpoint
const oldMorning = `app.post('/api/cron/morning', async (c) => {
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
});`;

const newMorning = `app.post('/api/cron/morning', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!CRON_SECRET || token !== CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleMorningCommand } = await import('./services/message-handler.service');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    await Promise.allSettled(users.map(user => handleMorningCommand(user.telegram_chat_id, user.id)));
  }
  
  return c.json({ ok: true, message: 'Morning push sent' });
});`;
code = code.replace(oldMorning, newMorning);

// Replace nudging cron endpoint
const oldNudging = `app.post('/api/cron/nudging', async (c) => {
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
});`;

const newNudging = `app.post('/api/cron/nudging', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!CRON_SECRET || token !== CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleNudgingCommand } = await import('./services/message-handler.service');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    await Promise.allSettled(users.map(user => handleNudgingCommand(user.telegram_chat_id, user.id)));
  }
  
  return c.json({ ok: true, message: 'Nudging push sent' });
});`;
code = code.replace(oldNudging, newNudging);

// Replace weekly cron endpoint
const oldWeekly = `app.post('/api/cron/weekly', async (c) => {
  const token = c.req.header('x-cron-token');
  if (token !== 'meeting-flow-morning-2026') return c.json({ error: 'Unauthorized' }, 401);
  
  const { decayUnusedMemories } = await import('./services/memory.service');
  await decayUnusedMemories();
  
  return c.json({ ok: true, message: 'Weekly memory decay processed' });
});`;

const newWeekly = `app.post('/api/cron/weekly', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!CRON_SECRET || token !== CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  
  const { decayUnusedMemories } = await import('./services/memory.service');
  await decayUnusedMemories();
  
  return c.json({ ok: true, message: 'Weekly memory decay processed' });
});`;
code = code.replace(oldWeekly, newWeekly);

// Replace evening cron endpoint
const oldEvening = `app.post('/api/cron/evening', async (c) => {
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
});`;

const newEvening = `app.post('/api/cron/evening', async (c) => {
  const token = c.req.header('x-cron-token');
  if (!CRON_SECRET || token !== CRON_SECRET) return c.json({ error: 'Unauthorized' }, 401);
  
  const { handleEveningCommand } = await import('./services/message-handler.service');
  const { data: users } = await supabase.from('users').select('id, telegram_chat_id').not('telegram_chat_id', 'is', null);
  
  if (users) {
    await Promise.allSettled(users.map(user => handleEveningCommand(user.telegram_chat_id, user.id)));
  }
  
  return c.json({ ok: true, message: 'Evening push sent' });
});`;
code = code.replace(oldEvening, newEvening);

fs.writeFileSync('src/index.ts', code);
console.log('Successfully updated cron endpoints');

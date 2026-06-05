const fs = require('fs');
const path = './src/services/message-handler.service.ts';
let content = fs.readFileSync(path, 'utf8');

// 1. Strip out the local 'routeIntent' and 'IntentOutput'
content = content.replace(/interface IntentOutput \{[\s\S]*?\}\n\nexport async function routeIntent[\s\S]*?\}\n\n/, '');

// 2. Strip out 'getLatestSourceBatch'
content = content.replace(/async function getLatestSourceBatch[\s\S]*?\}\n\n\n\n\n/, '');
content = content.replace(/async function getLatestSourceBatch[\s\S]*?\}\n/, ''); // Fallback

// 3. Strip out 'TelegramButton'
content = content.replace(/export type TelegramButton = \{[\s\S]*?\};\n\n/, '');

// 4. Inject 'routeIntent' and 'IntentOutput' import at the top
if (!content.includes("import { routeIntent } from './intent-router.service';")) {
  content = "import { routeIntent } from './intent-router.service';\n" + content;
}

// 5. Replace inline 'query_schedule'
const scheduleInline = `if (route.intent === 'query_schedule') {
      const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
      const nextWeekStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];

      const [{ data: tasks }, { data: events }] = await Promise.all([
        supabase.from('tasks').select('title, status').eq('user_id', userId).not('status', 'in', '("completed","cancelled")').limit(10),
        supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).not('status', 'in', '("rejected","cancelled")').not('start_time', 'is', null).gte('start_time', todayStr).lte('start_time', nextWeekStr).order('start_time', { ascending: true }).limit(10)
      ]);

      if ((!tasks || tasks.length === 0) && (!events || events.length === 0)) {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '您近期沒有任何待辦事項或行程喔！很輕鬆！');
      } else {
        const lines = ['📅 **為您整理的近期行程與待辦：**\\n'];
        if (events && events.length > 0) {
          lines.push('【即將到來的行程】');
          events.forEach(e => {
            const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            lines.push(\`• [\${timeStr}] \${e.title}\`);
          });
          lines.push('');
        }
        if (tasks && tasks.length > 0) {
          lines.push('【未完成的待辦】');
          tasks.forEach(t => lines.push(\`• \${t.title}\`));
        }
        if (route.query_timeframe) {
          lines.push(\`\\n*(您詢問的時間範圍：\${route.query_timeframe}，以上為近期總覽)*\`);
        }
        await editTelegramMessage(chatId as number, thinkingMessageId as number, lines.join('\\n'));
      }
      return;
    }`;
const scheduleReplacement = `if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }`;
content = content.replace(scheduleInline, scheduleReplacement);

// 6. Replace inline 'chit_chat'
const chitChatInline = `if (route.intent === 'chit_chat' && route.reply_message) {
      await editTelegramMessage(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }`;
const chitChatReplacement = `if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }`;
content = content.replace(chitChatInline, chitChatReplacement);

// 7. Replace inline 'query_weather'
const weatherInlineRegex = /if \(route\.intent === 'query_weather'\) \{[\s\S]*?return;\n    \}/;
const weatherReplacement = `if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }`;
content = content.replace(weatherInlineRegex, weatherReplacement);

// 8. Replace inline 'update_tasks'
const updateInlineRegex = /if \(route\.intent === 'update_tasks'\) \{[\s\S]*?return;\n    \}/;
const updateReplacement = `if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }`;
content = content.replace(updateInlineRegex, updateReplacement);

// 9. Add eod_journal right before query_schedule
if (!content.includes("if (route.intent === 'eod_journal')")) {
  const eodJournalLogic = `if (route.intent === 'eod_journal') {
      await handleEodJournalCommand(chatId as number, userId, text, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'query_schedule')`;
  content = content.replace("if (route.intent === 'query_schedule')", eodJournalLogic);
}

// 10. Remove all functions from handleResearchCommand downwards
content = content.replace(/async function handleResearchCommand[\s\S]*$/, '');

// 11. Remove any duplicated imports at top, add clean block
const handlerImports = `import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';
`;
if (!content.includes('./command-handlers/morning.handler')) {
  content = content.replace("import { supabase } from '../utils/db';", handlerImports + "import { supabase } from '../utils/db';");
}

fs.writeFileSync(path, content, 'utf8');
console.log('Final perfect refactor completed.');

const fs = require('fs');
const path = './src/services/message-handler.service.ts';

let content = fs.readFileSync(path, 'utf8');

// 1. Delete interface IntentOutput
content = content.replace(/export interface IntentOutput \{[\s\S]*?\}\n/, '');

// 2. Delete routeIntent
content = content.replace(/export async function routeIntent[\s\S]*?\}\n\n/, '');

// 3. Add necessary imports
const handlerImports = `import { routeIntent, IntentOutput } from './intent-router.service';
import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';
`;
content = handlerImports + content;

// 4. Replace inline query_schedule
const scheduleRegex = /if \(route\.intent === 'query_schedule'\) \{[\s\S]*?return;\n    \}/;
content = content.replace(scheduleRegex, `if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }`);

// 5. Replace inline chit_chat
const chitChatRegex = /if \(route\.intent === 'chit_chat' && route\.reply_message\) \{[\s\S]*?return;\n    \}/;
content = content.replace(chitChatRegex, `if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }`);

// 6. Replace inline query_weather
const weatherRegex = /if \(route\.intent === 'query_weather'\) \{[\s\S]*?return;\n    \}/;
content = content.replace(weatherRegex, `if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }`);

// 7. Replace inline update_tasks
const updateRegex = /if \(route\.intent === 'update_tasks'\) \{[\s\S]*?return;\n    \}/;
content = content.replace(updateRegex, `if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }`);

// 8. Add eod_journal right before query_schedule
const eodJournalLogic = `if (route.intent === 'eod_journal') {
      await handleEodJournalCommand(chatId as number, userId, text, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'query_schedule')`;
content = content.replace("if (route.intent === 'query_schedule')", eodJournalLogic);

// 9. Remove all functions from handleResearchCommand downwards
content = content.replace(/async function handleResearchCommand[\s\S]*$/, '');

fs.writeFileSync(path, content, 'utf8');
console.log('Precision refactor completed.');

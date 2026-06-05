const fs = require('fs');
const path = './src/services/message-handler.service.ts';
let lines = fs.readFileSync(path, 'utf8').split('\n');

// Backward replacement to preserve line indices above the changes

// Delete 797 to end (handleResearchCommand and beyond)
lines.splice(796, lines.length - 796);

// Replace 696 to 737 (update_tasks)
lines.splice(695, 42, `    if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }`);

// Replace 656 to 694 (query_weather)
lines.splice(655, 39, `    if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }`);

// Replace 651 to 654 (chit_chat)
lines.splice(650, 4, `    if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }`);

// Replace 618 to 649 (query_schedule)
lines.splice(617, 32, `    if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }`);

// Add eod_journal logic at 617 (insert at index 616)
lines.splice(616, 0, `    if (route.intent === 'eod_journal') {
      await handleEodJournalCommand(chatId as number, userId, text, thinkingMessageId as number);
      return;
    }`);

// Delete 190 to 235 (routeIntent)
lines.splice(189, 46);

// Delete 177 to 188 (IntentOutput)
lines.splice(176, 12);

// Delete 106 to 115 (getLatestSourceBatch)
lines.splice(105, 10);

// Delete 17 to 22 (TelegramButton)
lines.splice(16, 6);

// Prepend Imports
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
lines.unshift(handlerImports);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('Line-based precision refactor completed.');

const fs = require('fs');
const path = './src/services/message-handler.service.ts';
let content = fs.readFileSync(path, 'utf8');

// Add imports at the top
const importsToAdd = `
import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleNudgingCommand } from './command-handlers/nudging.handler';
import { handleEveningCommand } from './command-handlers/evening.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { routeIntent } from './intent-router.service';
`;

// Insert after the last import
content = content.replace(/(import .*;\n)+/, match => match + importsToAdd);

// Remove routeIntent definition
content = content.replace(/export async function routeIntent[\s\S]*?catch \(e\) {\s*return { intent: 'extract_meeting' };\s*}\s*}\n/, '');

// Replace inline handlers inside processTelegramUpdate
content = content.replace(/if \(route\.intent === 'delete_item'[\s\S]*?return;\n    }/, `if (route.intent === 'delete_item' && route.delete_keyword) {
      await handleDeleteCommand(chatId as number, userId, route.delete_keyword, thinkingMessageId as number);
      return;
    }`);

content = content.replace(/if \(route\.intent === 'eod_journal'[\s\S]*?return;\n    }/, `if (route.intent === 'eod_journal' || text.toLowerCase().startsWith('/eod')) {
      const eodText = text.toLowerCase().startsWith('/eod') ? text.substring(4).trim() : text;
      await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
      return;
    }`);

content = content.replace(/if \(route\.intent === 'query_schedule'[\s\S]*?return;\n    }/, `if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }`);

content = content.replace(/if \(route\.intent === 'chit_chat'[\s\S]*?return;\n    }/, `if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }`);

content = content.replace(/if \(route\.intent === 'query_weather'[\s\S]*?return;\n    }/, `if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }`);

content = content.replace(/if \(route\.intent === 'update_tasks'[\s\S]*?return;\n    }/, `if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }`);

// Remove the definitions of handleMorningCommand, etc at the bottom
// from export async function handleResearchCommand to the end of the file
const handlersRegex = /async function handleResearchCommand[\s\S]*$/;
content = content.replace(handlersRegex, '');

fs.writeFileSync(path, content, 'utf8');
console.log('Refactoring complete');

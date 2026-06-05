const fs = require('fs');
const path = './src/services/message-handler.service.ts';
let content = fs.readFileSync(path, 'utf8');

function replaceBlock(startMarker, endMarker, replacement) {
  const startIdx = content.indexOf(startMarker);
  if (startIdx === -1) {
    console.warn("Could not find start marker: ", startMarker.substring(0, 50));
    return;
  }
  
  const endIdx = content.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    console.warn("Could not find end marker after start for: ", startMarker.substring(0, 50));
    return;
  }
  
  content = content.substring(0, startIdx) + replacement + content.substring(endIdx + endMarker.length);
}

// 1. Remove duplicate interface IntentOutput
const intentOutputStart = "interface IntentOutput {\r\n";
const intentOutputEnd = "}\r\n\r\n";
replaceBlock(intentOutputStart, intentOutputEnd, "");

// 2. Remove duplicate routeIntent function
const routeIntentStart = "export async function routeIntent(userId: string, text: string): Promise<IntentOutput> {\r\n";
const routeIntentEnd = "  }\r\n}\r\n\r\n";
replaceBlock(routeIntentStart, routeIntentEnd, "");

// 3. Insert handlers at the top
const handlerImports = `import { routeIntent, IntentOutput } from './intent-router.service';
import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';\n`;

if (!content.includes('./command-handlers/morning.handler')) {
  content = handlerImports + content;
}

// 4. EOD Journal and Schedule Block
const scheduleBlockStart = "    if (route.intent === 'query_schedule') {\r\n";
const scheduleBlockEnd = "      return;\r\n    }\r\n";
const scheduleBlockReplacement = `    if (route.intent === 'eod_journal' || text.toLowerCase().startsWith('/eod')) {
      const eodText = text.toLowerCase().startsWith('/eod') ? text.substring(4).trim() : text;
      await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }\r\n`;
replaceBlock(scheduleBlockStart, scheduleBlockEnd, scheduleBlockReplacement);

// 5. Chit Chat
const chitChatStart = "    if (route.intent === 'chit_chat' && route.reply_message) {\r\n";
const chitChatEnd = "      return;\r\n    }\r\n";
const chitChatReplacement = `    if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }\r\n`;
replaceBlock(chitChatStart, chitChatEnd, chitChatReplacement);

// 6. Query Weather
const weatherStart = "    if (route.intent === 'query_weather') {\r\n";
const weatherEnd = "      return;\r\n    }\r\n";
const weatherReplacement = `    if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }\r\n`;
replaceBlock(weatherStart, weatherEnd, weatherReplacement);

// 7. Update Tasks
const updateStart = "    if (route.intent === 'update_tasks') {\r\n";
const updateEnd = "      return;\r\n    }\r\n";
const updateReplacement = `    if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }\r\n`;
replaceBlock(updateStart, updateEnd, updateReplacement);

// 8. Delete bottom handlers
const bottomHandlersStart = "async function handleResearchCommand(chatId: number, userId: string, query: string, isUrl: boolean) {\r\n";
if (content.indexOf(bottomHandlersStart) !== -1) {
    content = content.substring(0, content.indexOf(bottomHandlersStart));
}

// Write back
fs.writeFileSync(path, content, 'utf8');
console.log('Safe refactoring completed!');

const fs = require('fs');
const path = './src/services/message-handler.service.ts';

let content = fs.readFileSync(path, 'utf8');

// First, check if our imports are already at the top to avoid duplicating
if (!content.includes('./command-handlers/morning.handler')) {
  const handlerImports = `
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
  
  // Find the last import line in the top block
  let lines = content.split('\\n');
  let lastImportIdx = -1;
  for (let i = 0; i < 30; i++) {
    if (lines[i] && lines[i].startsWith('import ')) {
      lastImportIdx = i;
    }
  }

  if (lastImportIdx !== -1) {
    lines.splice(lastImportIdx + 1, 0, handlerImports);
    content = lines.join('\\n');
  } else {
    content = handlerImports + content;
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('Imports successfully added.');

const fs = require('fs');
const path = './src/services/message-handler.service.ts';

let content = fs.readFileSync(path, 'utf8');

// Ensure routeIntent is imported
if (!content.includes('import { routeIntent }')) {
  content = "import { routeIntent } from './intent-router.service';\n" + content;
}

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

// Prepend handler imports if not already there
if (!content.includes('handleMorningCommand')) {
  content = handlerImports + content;
}

// Check for supplement intent and add it if missing
if (!content.includes("if (route.intent === 'supplement')")) {
  const supplementLogic = `
    if (route.intent === 'supplement') {
      console.log(\`Starting supplement extraction for user=\${userId}\`);
      
      const { createProcessingJob } = await import('../repositories/processing-jobs.repo');
      const { createSourceBatch } = await import('../repositories/source-batches.repo');
      const batchId = await createSourceBatch(userId, text || 'voice_or_file_placeholder');
      
      await createProcessingJob(userId, 'EXTRACT_MEETING', {
        chatId,
        text,
        voice: null, 
        batchId,
        thinkingMessageId
      });
      return;
    }
`;
  // We'll insert it right before the fallback log
  content = content.replace("    // Default fallthrough:", supplementLogic + "\n    // Default fallthrough:");
}

fs.writeFileSync(path, content, 'utf8');
console.log('Imports and supplement logic fixed.');

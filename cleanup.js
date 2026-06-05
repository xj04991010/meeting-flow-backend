const fs = require('fs');
const path = './src/services/message-handler.service.ts';

let content = fs.readFileSync(path, 'utf8');

// 1. Remove the stray imports block starting with "\nimport { handleMorningCommand }"
const strayImportsRegex = /\nimport \{ handleMorningCommand \} from '\.\/command-handlers\/morning\.handler';\nimport \{ handleWeekCommand \} from '\.\/command-handlers\/week\.handler';\nimport \{ handleResearchCommand \} from '\.\/command-handlers\/research\.handler';\nimport \{ handleEodJournalCommand \} from '\.\/command-handlers\/eod-journal\.handler';\nimport \{ handleDeleteCommand \} from '\.\/command-handlers\/delete\.handler';\nimport \{ handleQueryScheduleCommand \} from '\.\/command-handlers\/schedule-query\.handler';\nimport \{ handleChitChatCommand \} from '\.\/command-handlers\/chit-chat\.handler';\nimport \{ handleWeatherCommand \} from '\.\/command-handlers\/weather\.handler';\nimport \{ handleUpdateTasksCommand \} from '\.\/command-handlers\/update\.handler';\n/g;

content = content.replace(strayImportsRegex, '');

// 2. Remove the duplicated routeIntent import if it's there twice
const firstRouteIntent = "import { routeIntent } from './intent-router.service';\n";
if (content.startsWith(firstRouteIntent + firstRouteIntent)) {
    content = content.substring(firstRouteIntent.length);
}

// 3. Ensure the proper imports are at the very top
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

if (!content.includes("import { handleMorningCommand }")) {
    content = handlerImports + "\n" + content;
}

fs.writeFileSync(path, content, 'utf8');
console.log('Cleaned up message-handler.service.ts');

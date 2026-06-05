const fs = require('fs');
const path = './src/services/intent-router.service.ts';
let content = fs.readFileSync(path, 'utf8');

// Add eod_journal to IntentOutput intent type
content = content.replace(
  /intent: 'extract_meeting' \| 'supplement' \| 'delete_item' \| 'query_schedule' \| 'update_tasks' \| 'chit_chat' \| 'query_weather';/g,
  "intent: 'extract_meeting' | 'supplement' | 'delete_item' | 'query_schedule' | 'update_tasks' | 'chit_chat' | 'query_weather' | 'eod_journal';"
);

content = content.replace(
  /"intent": "extract_meeting" \| "supplement" \| "delete_item" \| "query_schedule" \| "update_tasks" \| "chit_chat"/g,
  '"intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat" | "eod_journal"'
);

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed intent-router.service.ts');

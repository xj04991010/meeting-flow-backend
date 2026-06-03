const fs = require('fs');
let content = fs.readFileSync('src/services/message-handler.service.ts', 'utf8');

// 1. Update IntentOutput
content = content.replace(
  "intent: 'extract_meeting' | 'supplement' | 'delete_item' | 'query_schedule' | 'update_tasks' | 'chit_chat' | 'query_weather';",
  "intent: 'extract_meeting' | 'supplement' | 'delete_item' | 'query_schedule' | 'update_tasks' | 'chit_chat' | 'query_weather' | 'eod_journal';"
);

// 2. Update Intent Router prompt json block
content = content.replace(
  '"intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat",',
  '"intent": "extract_meeting" | "supplement" | "delete_item" | "query_schedule" | "update_tasks" | "chit_chat" | "eod_journal",'
);

// 3. Update Rules inside prompt
content = content.replace(
  '- "chit_chat": General questions or greetings.',
  '- "eod_journal": User is providing an End-of-Day summary or handover (e.g. "今天完成了A，明天要接手B", "/eod 今天把報表寫完了"). This serves as a daily journal to persist to tomorrow.\n- "chit_chat": General questions or greetings.'
);

// 4. Update the switch block
const switchInject = `
    if (route.intent === 'eod_journal' || text.toLowerCase().startsWith('/eod')) {
      const eodText = text.toLowerCase().startsWith('/eod') ? text.substring(4).trim() : text;
      await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
      return;
    }
`;
if (!content.includes('route.intent === \'eod_journal\'')) {
  content = content.replace(
    "if (route.intent === 'query_schedule') {",
    switchInject.trim() + "\n\n    if (route.intent === 'query_schedule') {"
  );
}

fs.writeFileSync('src/services/message-handler.service.ts', content);
console.log('Router updated.');

const fs = require('fs');

const extPath = './src/services/extraction.service.ts';
let extContent = fs.readFileSync(extPath, 'utf8');

extContent = extContent.replace(
  /output type "CONVERSATIONAL_RESPONSE" and provide a helpful, natural, and friendly reply in reasoning_summary./,
  'output type "CONVERSATIONAL_RESPONSE" and provide a helpful, natural, and friendly reply in reasoning_summary. (NOTE: You fully support Voice messages via Telegram! If the user asks about voice support, excitedly tell them you support it!)'
);

extContent = extContent.replace(/await reply\(\`\$\{output.reasoning_summary\}\`\);/, "await reply((voiceFileId && inputText ? `🎙️ [語音辨識] ${inputText}\\n\\n` : '') + `${output.reasoning_summary}`);");
extContent = extContent.replace(/await reply\(\`🤔 系統無法辨識.*?/, "await reply((voiceFileId && inputText ? `🎙️ [語音辨識] ${inputText}\\n\\n` : '') + `🤔 系統無法辨識出明確的任務或行程，請嘗試補充更多具體細節！`);");

fs.writeFileSync(extPath, extContent, 'utf8');

const telPath = './src/routes/telegram.ts';
let telContent = fs.readFileSync(telPath, 'utf8');

const replacement = `        // Unified Routing
        const { processTelegramUpdate } = await import('../services/message-handler.service');
        processTelegramUpdate(message).catch((e: any) => console.error('Unified routing error:', e));
`;

telContent = telContent.replace(/\/\/ Command Routing \(A-8\)[\s\S]*?thinkingMessageId\n        \}\);/m, replacement);

fs.writeFileSync(telPath, telContent, 'utf8');

console.log('Fixed extraction and telegram routes');

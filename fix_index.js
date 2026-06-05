const fs = require('fs');

const indexPath = './src/index.ts';
let indexContent = fs.readFileSync(indexPath, 'utf8');

indexContent = indexContent.replace(/const \{ handleMorningCommand \} = await import\('\.\/services\/message-handler\.service'\);/g, "const { handleMorningCommand } = await import('./services/command-handlers/morning.handler');");
indexContent = indexContent.replace(/const \{ handleNudgingCommand \} = await import\('\.\/services\/message-handler\.service'\);/g, "const { handleNudgingCommand } = await import('./services/command-handlers/nudging.handler');");
indexContent = indexContent.replace(/const \{ handleEveningCommand \} = await import\('\.\/services\/message-handler\.service'\);/g, "const { handleEveningCommand } = await import('./services/command-handlers/evening.handler');");

fs.writeFileSync(indexPath, indexContent, 'utf8');

const handlerPath = './src/services/message-handler.service.ts';
let handlerContent = fs.readFileSync(handlerPath, 'utf8');
handlerContent = handlerContent.replace(/export async function routeIntent[\s\S]*?catch \(e\) \{\s*return \{ intent: 'extract_meeting' \};\s*\}\s*\}/, '');
fs.writeFileSync(handlerPath, handlerContent, 'utf8');

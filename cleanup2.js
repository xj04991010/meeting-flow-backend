const fs = require('fs');
const path = './src/services/message-handler.service.ts';

let content = fs.readFileSync(path, 'utf8');

// 1. Remove local IntentOutput interface and routeIntent function
// We know IntentOutput starts with `interface IntentOutput`
// and routeIntent starts with `export async function routeIntent(userId: string, text: string): Promise<IntentOutput> {`
content = content.replace(/export interface IntentOutput \{[\s\S]*?\}\n/, '');
content = content.replace(/export async function routeIntent[\s\S]*?\}\n\n/, ''); // Removes until the end of the function block

// 2. Remove duplicate TelegramButton (keep the one imported from telegram.service if we need to, wait, we don't need it if it's imported)
content = content.replace(/export type TelegramButton = \{[\s\S]*?\};\n/, '');

// 3. Remove getLatestSourceBatch
content = content.replace(/async function getLatestSourceBatch[\s\S]*?\}\n/, '');

// 4. Remove buildExtractionPrompt and buildSupplementPrompt and extractMeetingData and extractSupplementData etc
// Actually, they might still be used by index.ts as per the audit report. 
// "extractMeetingData / extractSupplementData / persistExtraction Are V1 Functions Only Used by Dashboard API" - they are used by index.ts, so we shouldn't delete them unless we migrate index.ts too. Let's keep them for now, the audit just said they are V1.

// 5. Ensure routeIntent is imported correctly from intent-router.service
if (!content.includes("import { routeIntent } from './intent-router.service';")) {
  // Add it to the top
  const importLines = `import { routeIntent, IntentOutput } from './intent-router.service';\n`;
  content = content.replace(/^/, importLines);
}

fs.writeFileSync(path, content, 'utf8');
console.log('Final cleanup done.');

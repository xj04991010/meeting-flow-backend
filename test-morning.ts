import { handleMorningCommand } from './src/services/command-handlers/morning.handler';
import { processExtractionJob } from './src/services/extraction.service';
import { createSourceBatch } from './src/repositories/source-batches.repo';
require('dotenv').config({ path: '.env' });

async function run() {
  const userId = '6578915a-d33e-4eed-8d22-a3e334480f56';
  const chatId = 5101942233;

  console.log('Sending morning briefing...');
  await handleMorningCommand(chatId, userId);

  console.log('Simulating a morning brain dump...');
  const text = '早安，幫我記一下，今天上午十點要跟設計部過圖，下午一點半我跟陳老闆吃飯。然後順便提醒我，明天中午之前要把雅典木桶的報價單生出來。';
  const batchId = await createSourceBatch(userId, text);
  await processExtractionJob(userId, chatId, text, batchId as string);

  console.log('Finished simulation.');
}
run();

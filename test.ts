import { processExtractionJob } from './src/services/extraction.service';
import { createSourceBatch } from './src/repositories/source-batches.repo';
require('dotenv').config({ path: '.env' });

async function run() {
  const userId = '6578915a-d33e-4eed-8d22-a3e334480f56';
  const chatId = 5101942233;
  const text = '下週二下午三點要跟Jack開會，記得帶合約。這是我用語音說的測試。';
  console.log('Creating batch...');
  const batchId = await createSourceBatch(userId, text);
  console.log('Running processExtractionJob...');
  await processExtractionJob(userId, chatId, text, batchId as string);
  console.log('Finished.');
}
run();

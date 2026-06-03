import { supabase } from '../utils/db';
import { markJobStatus } from '../repositories/processing-jobs.repo';
import { processExtractionJob } from '../services/extraction.service';
import { processConfirmationJob } from '../services/confirmation.service';

let isPolling = false;

// Track running job IDs to prevent duplicate pickups
const runningJobIds = new Set<string>();

async function processJob(job: any) {
  if (runningJobIds.has(job.id)) return;
  runningJobIds.add(job.id);

  await markJobStatus(job.id, 'processing');

  try {
    if (job.job_type === 'EXTRACT_MEETING') {
      await processExtractionJob(
        job.user_id,
        job.payload.chatId,
        job.payload.text,
        job.payload.batchId,
        job.payload.voice,
        job.payload.thinkingMessageId
      );
    } else if (job.job_type === 'HANDLE_CALLBACK') {
      await processConfirmationJob(
        job.user_id,
        job.payload.chatId,
        job.payload.callbackId,
        job.payload.data,
        job.payload.messageId
      );
    }

    await markJobStatus(job.id, 'completed');
    console.log(`[Worker] ✅ Completed ${job.job_type} for ${job.user_id}`);
  } catch (jobErr: any) {
    console.error(`[Worker] ❌ Job ${job.id} failed:`, jobErr);

    const attempts = (job.payload.attempts || 0) + 1;

    if (attempts >= 3) {
      await markJobStatus(job.id, 'failed', jobErr.message);
      console.error(`[Worker] Job ${job.id} permanently failed after 3 attempts`);
    } else {
      const delayMs = 3000 * Math.pow(2, attempts - 1); // 3s, 6s
      const retryAfter = Date.now() + delayMs;

      await supabase
        .from('processing_jobs')
        .update({
          status: 'pending',
          last_error: jobErr.message,
          payload: { ...job.payload, attempts, retryAfter }
        })
        .eq('id', job.id);

      console.log(`[Worker] Job ${job.id} re-queued (attempt ${attempts}/3, retry after ${delayMs}ms)`);
    }
  } finally {
    runningJobIds.delete(job.id);
  }
}

export function startJobWorker() {
  if (isPolling) return;
  isPolling = true;
  console.log('[Worker] Started polling processing_jobs...');

  setInterval(async () => {
    try {
      const now = Date.now();

      const { data: jobs, error } = await supabase
        .from('processing_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(5);

      if (error) { 
        console.error('[Worker] fetch jobs error:', error); 
        return; 
      }
      
      if (!jobs || jobs.length === 0) return;

      for (const job of jobs) {
        // Skip jobs that are still cooling down
        if (job.payload?.retryAfter && job.payload.retryAfter > now) continue;
        
        // Skip jobs that are already running
        if (runningJobIds.has(job.id)) continue;

        // Non-blocking processing
        processJob(job).catch(err => console.error('[Worker] Unhandled processJob error:', err));
      }
    } catch (err) {
      console.error('[Worker] Unhandled polling error:', err);
    }
  }, 3000);
}

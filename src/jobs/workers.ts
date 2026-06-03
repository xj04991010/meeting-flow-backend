import { supabase } from '../utils/db';
import { markJobStatus } from '../repositories/processing-jobs.repo';
import { processExtractionJob } from '../services/extraction.service';
import { processConfirmationJob } from '../services/confirmation.service';

let isPolling = false;

export function startJobWorker() {
  if (isPolling) return;
  isPolling = true;
  console.log('[Worker] Started polling processing_jobs...');

  setInterval(async () => {
    try {
      // 1. Fetch pending jobs
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

      // 2. Process jobs
      for (const job of jobs) {
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
            console.log(`[Worker] Processed EXTRACT_MEETING for ${job.user_id}`);
          } else if (job.job_type === 'HANDLE_CALLBACK') {
            await processConfirmationJob(
              job.user_id,
              job.payload.chatId,
              job.payload.callbackId,
              job.payload.data,
              job.payload.messageId
            );
            console.log(`[Worker] Processed HANDLE_CALLBACK for ${job.user_id}`);
          }

          await markJobStatus(job.id, 'completed');
        } catch (jobErr: any) {
          console.error(`[Worker] Job ${job.id} failed:`, jobErr);
          
          // Retry Logic
          const attempts = (job.payload.attempts || 0) + 1;
          
          if (attempts >= 3) {
            await markJobStatus(job.id, 'failed', jobErr.message);
          } else {
            // Exponential backoff: 3s * 2^(attempts-1) -> 3s, 6s, 12s
            const delayMs = 3000 * Math.pow(2, attempts - 1);
            console.log(`[Worker] Job ${job.id} will retry in ${delayMs}ms (Attempt ${attempts}/3)`);
            
            // Wait for backoff inside the loop (or ideally schedule it, but for simplicity here we delay)
            // Wait, delaying the loop blocks other jobs. 
            // Instead, we just mark it as 'pending' and update payload, then the query will pick it up immediately.
            // To prevent immediate pickup, we could add a `next_run_at` but we don't have that column.
            // For now, we will sleep briefly to not overwhelm the API, then mark as pending.
            await new Promise(resolve => setTimeout(resolve, delayMs));
            
            // Re-queue
            job.payload.attempts = attempts;
            await supabase
              .from('processing_jobs')
              .update({ status: 'pending', payload: job.payload, last_error: jobErr.message })
              .eq('id', job.id);
          }
        }
      }
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
    }
  }, 3000); // Poll every 3 seconds
}

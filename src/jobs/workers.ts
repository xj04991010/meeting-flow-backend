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
              job.payload.voice
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
        } catch (jobError: any) {
          console.error(`[Worker] Job ${job.id} failed:`, jobError);
          await markJobStatus(job.id, 'failed', jobError.message);
        }
      }
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
    }
  }, 3000); // Poll every 3 seconds
}

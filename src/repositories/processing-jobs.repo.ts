import { supabase } from '../utils/db';

export async function createProcessingJob(userId: string | null, jobType: string, payload: any): Promise<string | null> {
  const { data, error } = await supabase
    .from('processing_jobs')
    .insert({
      user_id: userId,
      job_type: jobType,
      payload: payload,
      status: 'pending'
    })
    .select('id')
    .single();

  if (error) {
    console.error('createProcessingJob error:', error);
    return null;
  }
  return data.id;
}

export async function markJobStatus(jobId: string, status: 'processing' | 'completed' | 'failed', errorMsg?: string) {
  const updateData: any = { status, updated_at: new Date().toISOString() };
  if (errorMsg) {
    updateData.last_error = errorMsg;
  }
  
  await supabase
    .from('processing_jobs')
    .update(updateData)
    .eq('id', jobId);
}

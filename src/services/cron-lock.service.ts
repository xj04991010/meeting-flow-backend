import { supabase } from '../utils/db';

export function getTaipeiDateKey(date = new Date()) {
  return date.toLocaleString('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

export async function acquireCronLock(jobType: string, date = new Date()): Promise<boolean> {
  const runDate = getTaipeiDateKey(date);
  const { error } = await supabase
    .from('cron_runs')
    .insert([{ job_type: jobType, run_date: runDate }]);

  if (error) {
    if (error.code === '23505') return false;
    console.error(`[CronLock] Failed to acquire lock for ${jobType}:`, error);
    return false;
  }

  return true;
}

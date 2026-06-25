import * as dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function clearData() {
  console.log('Starting data cleanup...');
  
  // We don't delete users or google_tokens so auth remains intact.
  const tables = [
    'user_feedback',
    'decision_logs',
    'ai_candidates',
    'tasks',
    'calendar_intents',
    'source_batches',
    'daily_journals',
    'processing_jobs'
  ];

  for (const table of tables) {
    // Delete all rows where id is not null (which is all rows)
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      console.error(`Failed to clear ${table}:`, error);
    } else {
      console.log(`Cleared table: ${table}`);
    }
  }

  console.log('Data cleanup completed. You can now test with a clean slate!');
}

clearData();

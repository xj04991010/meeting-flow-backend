import { supabase } from './src/utils/db';

async function checkRules() {
  const { data, error } = await supabase.from('playbook_rules').select('*');
  if (error) {
    console.error('Error fetching rules:', error);
  } else {
    console.log('Playbook Rules:', JSON.stringify(data, null, 2));
  }
  process.exit(0);
}

checkRules();

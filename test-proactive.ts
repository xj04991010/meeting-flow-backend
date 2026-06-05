import { supabase } from './src/utils/db';
import { scanMemoriesAndGenerateTasks } from './src/services/proactive.service';
require('dotenv').config({ path: '.env' });

async function run() {
  const userId = '6578915a-d33e-4eed-8d22-a3e334480f56';
  
  console.log('Inserting test memories...');
  await supabase.from('memories').insert([
    {
      user_id: userId,
      content: '每個月5號要繳卡費',
      importance: 5,
      memory_type: 'habit',
      entity_type: 'rule'
    },
    {
      user_id: userId,
      content: '10月15日是測試紀念日',
      importance: 5,
      memory_type: 'event',
      entity_type: 'rule'
    }
  ]);

  console.log('Running scanMemoriesAndGenerateTasks with simulated date 2026-10-04...');
  const count = await scanMemoriesAndGenerateTasks(userId, '2026-10-04T10:00:00+08:00');
  console.log(`Generated ${count} tasks.`);

  const { data: newTasks } = await supabase.from('tasks').select('title, deadline').eq('user_id', userId).order('created_at', { ascending: false }).limit(count);
  console.log('New Tasks:', newTasks);

  console.log('Cleaning up test memories...');
  await supabase.from('memories').delete().eq('user_id', userId).in('content', ['每個月5號要繳卡費', '10月15日是測試紀念日']);
  
  if (count > 0 && newTasks) {
    const taskTitles = newTasks.map(t => t.title);
    await supabase.from('tasks').delete().eq('user_id', userId).in('title', taskTitles);
    console.log('Cleaned up generated tasks.');
  }
}
run();

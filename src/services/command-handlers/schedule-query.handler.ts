import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';

export async function handleQueryScheduleCommand(chatId: number, userId: string, timeframe: string | null, thinkingId: number) {
  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const nextWeekStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];

  const [{ data: tasks }, { data: events }] = await Promise.all([
    supabase.from('tasks').select('title, status').eq('user_id', userId).not('status', 'in', '("completed","cancelled")').limit(10),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).not('status', 'in', '("rejected","cancelled")').not('start_time', 'is', null).gte('start_time', todayStr).lte('start_time', nextWeekStr).order('start_time', { ascending: true }).limit(10)
  ]);

  if ((!tasks || tasks.length === 0) && (!events || events.length === 0)) {
    await editTelegramMessage(chatId, thinkingId, '您近期沒有任何待辦事項或行程喔！很輕鬆！');
  } else {
    const lines = ['📅 **為您整理的近期行程與待辦：**\n'];
    if (events && events.length > 0) {
      lines.push('【即將到來的行程】');
      events.forEach(e => {
        const timeStr = new Date(e.start_time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        lines.push(`• [${timeStr}] ${e.title}`);
      });
      lines.push('');
    }
    if (tasks && tasks.length > 0) {
      lines.push('【未完成的待辦】');
      tasks.forEach(t => lines.push(`• ${t.title}`));
    }
    if (timeframe) {
      lines.push(`\n*(您詢問的時間範圍：${timeframe}，以上為近期總覽)*`);
    }
    await editTelegramMessage(chatId, thinkingId, lines.join('\n'));
  }
}

const fs = require('fs');
let content = fs.readFileSync('src/services/message-handler.service.ts', 'utf8');

const eveningOriginal = `  const [tasksResult, eventsResult] = await Promise.all([
    supabase.from('tasks').select('title, category, status, priority').eq('user_id', userId).gte('deadline', todayStr).lt('deadline', todayStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', tomorrowStr).lt('start_time', tomorrowStr + 'T23:59:59')
  ]);

  const tasks = tasksResult.data || [];
  const eventsTomorrow = eventsResult.data || [];

  const completed = tasks.filter(t => t.status === 'completed');
  const pending = tasks.filter(t => t.status !== 'completed');

  if (tasks.length === 0 && eventsTomorrow.length === 0) {
    await editTelegramMessage(chatId, thinkingId, '🌙 **[晚間會報]**\\n\\n今天沒有紀錄任務，明天也沒有特別的行程。好好休息吧！');
    return;
  }`;

const eveningNew = `  const [tasksResult, eventsResult, eventsTodayResult, journalResult] = await Promise.all([
    supabase.from('tasks').select('title, category, status, priority').eq('user_id', userId).gte('deadline', todayStr).lt('deadline', todayStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', tomorrowStr).lt('start_time', tomorrowStr + 'T23:59:59'),
    supabase.from('calendar_intents').select('id').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('daily_journals').select('id').eq('user_id', userId).eq('date', todayStr).maybeSingle()
  ]);

  const tasks = tasksResult.data || [];
  const eventsTomorrow = eventsResult.data || [];
  const eventsToday = eventsTodayResult.data || [];
  const hasJournalToday = !!journalResult.data;

  const completed = tasks.filter(t => t.status === 'completed');
  const pending = tasks.filter(t => t.status !== 'completed');

  // Workday Heuristic
  const dayOfWeek = new Date().getDay(); // 0 is Sunday, 6 is Saturday
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isWorkday = !isWeekend || tasks.length > 0 || eventsToday.length > 0;

  if (tasks.length === 0 && eventsTomorrow.length === 0) {
    let msg = '🌙 **[晚間會報]**\\n\\n今天沒有紀錄任務，明天也沒有特別的行程。好好休息吧！';
    if (isWorkday && !hasJournalToday) {
      msg += '\\n\\n🔥 助理溫馨提醒：今天戰鬥結束了，但您的交接日誌還沒寫！連續紀錄可以保持好習慣喔，用語音跟我說一句今天做了什麼吧！';
    }
    await editTelegramMessage(chatId, thinkingId, msg);
    return;
  }`;

content = content.replace(eveningOriginal, eveningNew);

const eveningPromptOriginal = `  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    await editTelegramMessage(chatId, thinkingId, \`🌙 **[晚間會報]**\\n\\n\${reply}\`);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成晚間會報失敗。');
  }`;

const eveningPromptNew = `  const reply = await callLLM(userId, [{ role: 'user', content: prompt }]);
  if (reply) {
    let finalMsg = \`🌙 **[晚間會報]**\\n\\n\${reply}\`;
    if (isWorkday && !hasJournalToday) {
      finalMsg += '\\n\\n---\\n🔥 **助理溫馨提醒**：今天戰鬥結束了，但您的交接日誌還沒寫！用語音跟我說一句今天做了什麼，解鎖連續登入紀錄吧！';
    }
    await editTelegramMessage(chatId, thinkingId, finalMsg);
  } else {
    await editTelegramMessage(chatId, thinkingId, '❌ 生成晚間會報失敗。');
  }`;

content = content.replace(eveningPromptOriginal, eveningPromptNew);

fs.writeFileSync('src/services/message-handler.service.ts', content);
console.log('Evening command updated with gamification.');

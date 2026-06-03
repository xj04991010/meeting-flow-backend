const fs = require('fs');
let code = fs.readFileSync('src/services/message-handler.service.ts', 'utf8');

const oldFuncStart = code.indexOf('async function handleWeekCommand');
if (oldFuncStart === -1) {
  console.log('Function not found!');
  process.exit(1);
}

// Find the end of the function. The function is at the end of the file.
const newFunc = `async function handleWeekCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const nextWeekStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];

  const { data: events } = await supabase.from('calendar_intents')
    .select('title, start_time')
    .eq('user_id', userId)
    .not('status', 'eq', 'rejected')
    .not('start_time', 'is', null)
    .gte('start_time', todayStr)
    .lte('start_time', nextWeekStr)
    .order('start_time', { ascending: true });

  const { data: tasks } = await supabase.from('tasks')
    .select('title, deadline, status, priority')
    .eq('user_id', userId)
    .not('status', 'eq', 'rejected');

  const pendingTasks = tasks?.filter(t => t.status !== 'completed') || [];

  const lines = ['🗓️ **未來一週排程與待辦總覽**\\n'];

  if (events && events.length > 0) {
    lines.push('📅 **行事曆排程**：');
    
    let currentDay = '';
    let eventCount = 0;
    for (const e of events) {
      if (eventCount >= 7) {
        lines.push(\`\\n*(還有 \${events.length - 7} 個行程未顯示)*\`);
        break;
      }
      const d = new Date(e.start_time);
      const dayStr = d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short' });
      const timeStr = d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
      
      if (currentDay !== dayStr) {
        lines.push(\`\\n🔹 **\${dayStr}**\`);
        currentDay = dayStr;
      }
      lines.push(\`  • \\\`\${timeStr}\\\` \${e.title}\`);
      eventCount++;
    }
    lines.push('');
  } else {
    lines.push('📅 **未來一週沒有安排行程**\\n');
  }

  if (pendingTasks.length > 0) {
    lines.push('✅ **重點待辦任務**：');
    // Sort tasks by priority
    const prioMap: any = { 'urgent': 4, 'high': 3, 'medium': 2, 'low': 1 };
    pendingTasks.sort((a, b) => prioMap[b.priority || 'medium'] - prioMap[a.priority || 'medium']);
    
    pendingTasks.slice(0, 6).forEach(t => {
      let icon = '⬜';
      if (t.priority === 'urgent') icon = '🚨';
      else if (t.priority === 'high') icon = '🔴';
      else if (t.priority === 'medium') icon = '🟡';
      else if (t.priority === 'low') icon = '🟢';
      
      lines.push(\`\${icon} \${t.title}\`);
    });
    if (pendingTasks.length > 6) lines.push(\`\\n*(還有 \${pendingTasks.length - 6} 項待辦未顯示)*\`);
  } else {
    lines.push('✅ **目前沒有未完成的待辦！**');
  }

  const buttons = [[
    { text: '✨ 打開 Dashboard 排程總覽', url: getDashboardUrl(userId) }
  ]];

  await editTelegramMessage(chatId, thinkingId, lines.join('\\n'), buttons);
}`;

const finalCode = code.substring(0, oldFuncStart) + newFunc + '\n';
fs.writeFileSync('src/services/message-handler.service.ts', finalCode);
console.log('Success!');

const fs = require('fs');
let content = fs.readFileSync('src/services/message-handler.service.ts', 'utf8');

// 1. Update handleMorningCommand signature and dependencies
const morningCommandOriginal = `export async function handleMorningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  const [tasksResult, eventsResult, memoriesResult, rawFact] = await Promise.all([
    supabase.from('tasks').select('title, category, priority').eq('user_id', userId).neq('status', 'completed'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('memories').select('content').eq('user_id', userId),
    fetch('https://uselessfacts.jsph.pl/api/v2/facts/random').then(r => r.json()).then((d: any) => d.text).catch(() => '')
  ]);
  
  const tasks = tasksResult.data;
  const events = eventsResult.data;
  const memories = memoriesResult.data;`;

const morningCommandNew = `export async function handleMorningCommand(chatId: number, userId: string) {
  if (!chatId) return;
  const thinkingId = await sendThinkingMessage(chatId);
  if (!thinkingId) return;

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  const yesterdayStr = new Date(Date.now() - 86400000).toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  const [tasksResult, eventsResult, memoriesResult, journalsResult, rawFact] = await Promise.all([
    supabase.from('tasks').select('title, category, priority').eq('user_id', userId).neq('status', 'completed'),
    supabase.from('calendar_intents').select('title, start_time').eq('user_id', userId).neq('status', 'cancelled').not('start_time', 'is', null).gte('start_time', todayStr).lt('start_time', todayStr + 'T23:59:59'),
    supabase.from('memories').select('content').eq('user_id', userId),
    supabase.from('daily_journals').select('content, date').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    fetch('https://uselessfacts.jsph.pl/api/v2/facts/random').then(r => r.json()).then((d: any) => d.text).catch(() => '')
  ]);
  
  const tasks = tasksResult.data;
  const events = eventsResult.data;
  const memories = memoriesResult.data;
  const lastJournal = journalsResult.data;`;

content = content.replace(morningCommandOriginal, morningCommandNew);

const morningPromptOriginal = `Raw Internet Fun Fact: "\${rawFact}"

Rules:
1. Tone: Brutally direct, zero-BS, objective, and data-driven. Do NOT use polite fluff, caring platitudes, or meaningless intros/outros. Use Traditional Chinese. Use emojis ONLY for strict data categorization.
2. Contextual Reminders: CRITICAL! Read the User's Long-Term Memories. If there are birthdays, anniversaries, or recurring events relevant to today or this month, output a stark, objective reminder.
3. Micro-Tasking (碎片化安插): Analyze today's Events. If there is a noticeable gap of free time (e.g., no events for 2 hours in the afternoon), AND the user has a long-term goal in their Memories (e.g., "讀書", "寫作"), you MUST recommend allocating time to the goal with absolute objectivity. ("分析：下午 14:00-16:00 具備 2 小時神經低負載空檔，建議立即執行 [長期目標] 推進。")
4. Fun Fact (冷知識): At the VERY END of the briefing, translate the "Raw Internet Fun Fact" (if provided) into Traditional Chinese, and present it as a pure data point to start the day. Format it as: "💡 [Data Point] 您知道嗎？[fun fact]"`;

const morningPromptNew = `Raw Internet Fun Fact: "\${rawFact}"
Recent EOD Journal (Handover from \${lastJournal ? lastJournal.date : 'N/A'}): "\${lastJournal ? lastJournal.content : 'No handover note.'}"

Rules:
1. Tone: Brutally direct, zero-BS, objective, and data-driven. Do NOT use polite fluff. Use Traditional Chinese. Use emojis ONLY for strict data categorization.
2. Handover Context (交接延續): CRITICAL! Read the Recent EOD Journal. Acknowledge what the user said yesterday and explicitly connect it to today's priority tasks.
3. Contextual Reminders: CRITICAL! Read the User's Long-Term Memories.
4. Micro-Tasking (碎片化安插): Analyze today's Events. Recommend allocating free time to long-term goals.
5. Fun Fact (冷知識): At the VERY END of the briefing, translate the "Raw Internet Fun Fact" into Traditional Chinese. Format it as: "💡 [Data Point] 您知道嗎？[fun fact]"`;

content = content.replace(morningPromptOriginal, morningPromptNew);

// 2. Append handleEodJournalCommand at the bottom
const handleEodJournalCommandCode = `

export async function handleEodJournalCommand(chatId: number, userId: string, text: string, thinkingId: number) {
  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Taipei' }).split(',')[0];
  
  // 1. Save journal
  await supabase.from('daily_journals').insert({
    user_id: userId,
    date: todayStr,
    content: text
  });

  // 2. Fetch pending tasks to see if any can be auto-completed
  const { data: pendingTasks } = await supabase.from('tasks')
    .select('id, title')
    .eq('user_id', userId)
    .neq('status', 'completed')
    .limit(50);

  let completedIds = [];
  if (pendingTasks && pendingTasks.length > 0) {
    const filterPrompt = \`Current Date: \${todayStr}
The user provided their End-of-Day journal: "\${text}"
Here are the user's pending tasks:
\${JSON.stringify(pendingTasks, null, 2)}

Determine which task IDs the user EXPLICITLY mentions they have COMPLETED in their journal.
Output JSON only:
{
  "completed_task_ids": ["uuid1", "uuid2"]
}\`;
    const filterContent = await callLLM(userId, [{ role: 'user', content: filterPrompt }], { type: 'json_object' });
    const parsed = JSON.parse(filterContent || '{"completed_task_ids": []}');
    completedIds = parsed.completed_task_ids || [];
    
    if (completedIds.length > 0) {
      await supabase.from('tasks').update({ status: 'completed' }).in('id', completedIds);
    }
  }

  // 3. Generate summary
  const summaryPrompt = \`You are an INTJ zero-BS executive assistant.
User's EOD Journal: "\${text}"
Tasks auto-completed by AI: \${completedIds.length} tasks.
Provide a brutally direct, data-driven summary acknowledging the journal has been saved for tomorrow's handover. 
If tasks were completed, mention that they have been marked complete.
Do NOT use polite fluff. Keep it under 3 lines. Use Traditional Chinese.\`;

  const reply = await callLLM(userId, [{ role: 'system', content: summaryPrompt }], { type: 'text' });
  
  await editTelegramMessage(chatId, thinkingId, \`📓 **[下班交接日誌]**\\n\\n\${reply}\`);
}
`;

if (!content.includes('export async function handleEodJournalCommand')) {
  content += handleEodJournalCommandCode;
}

fs.writeFileSync('src/services/message-handler.service.ts', content);
console.log('Morning command updated and handleEodJournalCommand appended.');

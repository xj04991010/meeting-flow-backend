const fs = require('fs');

const path = './src/services/message-handler.service.ts';
let content = fs.readFileSync(path, 'utf8');

// 1. Remove the dead functions at the bottom
// From `async function handleResearchCommand` all the way to the end
content = content.replace(/async function handleResearchCommand[\s\S]*$/, '');

// 2. Replace processTelegramUpdate completely
// We will locate `export async function processTelegramUpdate(message: any) {` 
// and replace up to the end of it (which is right before handleResearchCommand that we just deleted).
const startMarker = 'export async function processTelegramUpdate(message: any) {';

const newProcessTelegramUpdate = `export async function processTelegramUpdate(message: any) {
  const chatId = message.chat?.id;
  let text = message.text?.trim();
  
  if (!chatId) return;

  if (text) {
    const cacheKey = \`\${chatId}_\${text}\`;
    const lastTime = userCommandCache.get(cacheKey) || 0;
    if (Date.now() - lastTime < 3000) {
      console.log(\`[RateLimit] Dropping repeated command from \${chatId}: \${text}\`);
      return;
    }
    userCommandCache.set(cacheKey, Date.now());
  }

  let existingThinkingMessageId: number | null = null;

  // Handle Voice Messages (Magic Feature 1)
  if (message.voice) {
    const userId = await getOrCreateUser(chatId);
    existingThinkingMessageId = await sendThinkingMessage(chatId, false);
    try {
      const audioBuffer = await getTelegramFileBuffer(message.voice.file_id);
      text = await transcribeAudio(audioBuffer, 'voice.ogg');
      
      if (!text || text.trim() === '') {
        await editTelegramMessage(chatId, existingThinkingMessageId as number, '聽不清楚您的語音，請再說一次。');
        return;
      }
      
      await editTelegramMessage(chatId, existingThinkingMessageId as number, \`🗣️ **語音辨識成功：**\\n「\${text}」\\n\\n正在為您處理...\`);
      message.text = text; // fake it for downstream
      delete message.voice;
    } catch (e: any) {
      console.error('Voice extraction error', e);
      await editTelegramMessage(chatId, existingThinkingMessageId as number, \`語音處理失敗：\${e.message}\`);
      return;
    }
  }

  if (!text) return;

  console.log(\`[DEBUG] processTelegramUpdate called. chatId: \${chatId}, text: \${text}\`);

  const lowerText = text.toLowerCase();

  // Basic Commands
  if (lowerText === '/start') {
    const userId = await getOrCreateUser(chatId);
    const reply = 'MeetingFlow 已切回會議萃取模式。直接貼上會議紀錄，我會批次抽出待辦、行程與待確認項目。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: getDashboardUrl(userId) }]]);
    return;
  }

  if (lowerText === '/morning') {
    const userId = await getOrCreateUser(chatId);
    await handleMorningCommand(chatId, userId);
    return;
  }

  if (lowerText === '/week') {
    const userId = await getOrCreateUser(chatId);
    await handleWeekCommand(chatId, userId);
    return;
  }

  if (lowerText === '/memory') {
    const userId = await getOrCreateUser(chatId);
    const { data: memories } = await supabase.from('memories').select('content, created_at').eq('user_id', userId).order('created_at', { ascending: false });
    
    if (!memories || memories.length === 0) {
      await sendTelegram(chatId, '🧠 助理目前還沒有記下任何您的長期記憶喔！只要在聊天中跟我說您的習慣或重要日期，我就會記下來！');
      return;
    }
    
    const memList = memories.map((m, i) => \`\${i + 1}. \${m.content}\`).join('\\n');
    await sendTelegram(chatId, \`🧠 **我的記憶庫 (長期記憶)**\\n\\n\${memList}\\n\\n💡 _這些記憶會在每天早安簡報中自動生效，幫您把關重要時程！_\`);
    return;
  }

  // Board Management
  if (lowerText.startsWith('/addboard ')) {
    const boardName = text.substring(10).trim();
    if (!boardName) {
      await sendTelegram(chatId, '請提供要新增的看板名稱。例如：/addboard 行銷');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    let categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    if (!categories.includes(boardName)) {
      categories.push(boardName);
      await supabase.from('users').update({ custom_categories: categories }).eq('id', userId);
      await sendTelegram(chatId, \`✅ 已成功新增看板：[\${boardName}]\\n\\n網頁重新整理後即可看到新看板。未來指派任務時可以直接說「放到\${boardName}看板」。\`);
    } else {
      await sendTelegram(chatId, \`⚠️ 看板 [\${boardName}] 已經存在囉！\`);
    }
    return;
  }

  if (lowerText.startsWith('/rmboard ')) {
    const boardName = text.substring(9).trim();
    if (!boardName) {
      await sendTelegram(chatId, '請提供要移除的看板名稱。例如：/rmboard 行銷');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    let categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    if (categories.includes(boardName)) {
      categories = categories.filter((c: string) => c !== boardName);
      await supabase.from('users').update({ custom_categories: categories }).eq('id', userId);
      await sendTelegram(chatId, \`✅ 已成功移除看板：[\${boardName}]\`);
    } else {
      await sendTelegram(chatId, \`⚠️ 找不到名為 [\${boardName}] 的看板。\`);
    }
    return;
  }

  if (lowerText === '/boards') {
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    await sendTelegram(chatId, \`📋 **目前的情境看板清單**：\\n\\n\${categories.map((c: string) => \`- [\${c}]\`).join('\\n')}\\n\\n您可以使用 \\\`/addboard 名稱\\\` 來新增，或 \\\`/rmboard 名稱\\\` 來移除。\`);
    return;
  }

  if (lowerText.startsWith('/research ') || lowerText.startsWith('/read ')) {
    const isUrl = lowerText.startsWith('/read ');
    const query = text.substring(isUrl ? 6 : 10).trim();
    if (!query) {
      await sendTelegram(chatId, '請提供要研究的主題或網址。例如：/research 什麼是 Agentic AI?');
      return;
    }
    const userId = await getOrCreateUser(chatId);
    await handleResearchCommand(chatId, userId, query, isUrl);
    return;
  }

  // EOD Journal shortcut
  if (lowerText.startsWith('/eod') || lowerText.startsWith('今天蠻廢的') || lowerText.startsWith('今日日記') || lowerText.startsWith('總結')) {
    const userId = await getOrCreateUser(chatId);
    const isShort = text.length <= 50;
    const thinkingMessageId = existingThinkingMessageId || await sendThinkingMessage(chatId, isShort);
    const eodText = lowerText.startsWith('/eod') ? text.substring(4).trim() : text;
    await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
    return;
  }

  // Dashboard shortcut
  if (text.includes('dashboard') || text.includes('儀表板') || text.includes('主頁')) {
    const userId = await getOrCreateUser(chatId);
    const reply = '打開 Dashboard 查看所有批次、待辦與行程。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: getDashboardUrl(userId) }]]);
    return;
  }

  const greetings = ['你好', '嗨', '哈囉', 'hello', 'hi', 'test', '測試', '安安', '早安', '午安', '晚安', '在嗎'];
  if (text.length <= 10 && greetings.some(g => lowerText.includes(g))) {
    const reply = '你好！我是你的 MeetingFlow 智能助理 👋\\n\\n你可以直接傳送「會議紀錄」或是「待辦事項」給我，我會幫你自動抽出任務與行程。\\n\\n輸入 /week 即可查看未來一週的行程與待辦總覽！';
    await sendTelegram(chatId, reply);
    return;
  }

  const isShort = text.length <= 50;
  const thinkingMessageId = existingThinkingMessageId || await sendThinkingMessage(chatId, isShort);
  const userId = await getOrCreateUser(chatId);
  
  try {
    const route = await routeIntent(userId, text);
    console.log(\`[Router] intent=\${route.intent} keyword=\${route.delete_keyword} timeframe=\${route.query_timeframe}\`);

    if (route.intent === 'delete_item' && route.delete_keyword) {
      await handleDeleteCommand(chatId as number, userId, route.delete_keyword, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'eod_journal') {
      await handleEodJournalCommand(chatId as number, userId, text, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    }

    if (route.intent === 'query_weather') {
      const location = (route as any).query_location || 'Taichung';
      await handleWeatherCommand(chatId as number, userId, location, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'update_tasks') {
      await handleUpdateTasksCommand(chatId as number, userId, text, route.update_action || null, route.update_new_deadline_iso || null, thinkingMessageId as number);
      return;
    }

    // Default fallthrough: Route extract_meeting and supplement to V2 queue
    console.log(\`[Router] Routing \${route.intent} to V2 Background Worker for user=\${userId}\`);
    const { createProcessingJob } = await import('../repositories/processing-jobs.repo');
    const { createSourceBatch } = await import('../repositories/source-batches.repo');
    const batchId = await createSourceBatch(userId, text || 'voice_or_file_placeholder');
    
    await createProcessingJob(userId, 'EXTRACT_MEETING', {
      chatId,
      text,
      voice: null, 
      batchId,
      thinkingMessageId
    });
    return;
  } catch (err: any) {
    console.error('Routing error:', err);
    await editTelegramMessage(chatId, thinkingMessageId as number, '處理過程發生錯誤。');
  }
}
`;

content = content.substring(0, content.indexOf(startMarker)) + newProcessTelegramUpdate;

fs.writeFileSync(path, content, 'utf8');
console.log('Fixed processTelegramUpdate correctly');

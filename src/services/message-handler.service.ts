import { routeIntent, IntentOutput } from './intent-router.service';
import { handleMorningCommand } from './command-handlers/morning.handler';
import { handleWeekCommand } from './command-handlers/week.handler';
import { handleResearchCommand } from './command-handlers/research.handler';
import { handleEodJournalCommand } from './command-handlers/eod-journal.handler';
import { handleDeleteCommand } from './command-handlers/delete.handler';
import { handleQueryScheduleCommand } from './command-handlers/schedule-query.handler';
import { handleChitChatCommand } from './command-handlers/chit-chat.handler';
import { handleWeatherCommand } from './command-handlers/weather.handler';
import { handleUpdateTasksCommand } from './command-handlers/update.handler';
import { supabase } from '../utils/db';
import { sendTelegram, sendThinkingMessage, editTelegramMessage, getTelegramFileBuffer, answerCallbackQuery } from './telegram.service';
import { callLLM, transcribeAudio } from './llm.service';
import { getOrCreateUser } from '../repositories/users.repo';
import { getDashboardUrl, PARSER_VERSION } from '../utils/env';
import { ExtractedTaskSchema, ExtractedTask, ExtractedEventSchema, ExtractedEvent, ParserOutputSchema, ParserOutput, BatchSummary } from '../schemas/extraction.schema';
import { generateResearchReport } from '../research';
import { insertTasks } from '../repositories/tasks.repo';
import { insertEvents } from '../repositories/calendar-intents.repo';
import { insertMemories } from '../repositories/memories.repo';
import { createSourceBatchV1, updateSourceBatchSummary } from '../repositories/source-batches.repo';
import { loadRelevantMemories } from './memory.service';
import { createDecisionLog } from './decision-logger.service';
import { loadPlaybookRules, buildPlaybookPrompt } from './playbook.service';
import { calculateRiskScore, detectPrepGap } from './strategy.service';
import { handleClientSecretaryMessage } from './client-secretary.service';
export type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
};

export function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  if (parsed > 1) return Math.min(parsed / 100, 1);
  return Math.max(0, Math.min(parsed, 1));
}

export function hasMeaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function looksLikeDashboardCommand(text: string) {
  const normalized = text.trim().toLowerCase();
  return [
    '/dashboard',
    'dashboard',
    'open dashboard',
    'show dashboard',
    '看 dashboard',
    '打開 dashboard',
    '開 dashboard',
    '看儀表板',
    '打開儀表板',
    '開儀表板'
  ].includes(normalized);
}

function startProgressUpdates(chatId: number, messageId: number, isShort: boolean) {
  let stopped = false;
  if (isShort) return () => { stopped = true; };

  const updates = [
    {
      delay: 15_000,
      text: '⚡ 深度解析中...'
    },
    {
      delay: 35_000,
      text: '⚡ 正在萃取任務與行程，請稍候...'
    },
    {
      delay: 70_000,
      text: '⏳ 模型運算時間較長，仍在處理中...'
    }
  ];

  const timers = updates.map((update) => setTimeout(() => {
    if (!stopped) {
      editTelegramMessage(chatId, messageId, update.text).catch((error) => {
        console.error('progress update error', error);
      });
    }
  }, update.delay));

  return () => {
    stopped = true;
    timers.forEach((timer) => clearTimeout(timer));
  };
}

export function makeReviewFlag(confidence: number, explicitNeedsReview: unknown, hasRequiredTime = true) {
  return Boolean(explicitNeedsReview) || confidence < 0.8 || !hasRequiredTime;
}



// chat_history 已停用 — 不再寫入，避免浪費 DB 資源
// 如果未來需要 audit log，可重新啟用此函式
// async function appendChatHistory(userId: string, role: 'user' | 'assistant', content: string) { ... }




export function nullableText(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function nullableDate(value: unknown) {
  if (typeof value !== 'string') return value === null ? null : undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
}

export function booleanOrUndefined(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}



const userCommandCache = new Map<string, number>();

export async function processTelegramUpdate(message: any) {
  const chatId = message.chat?.id;
  let text = message.text?.trim();
  
  if (!chatId) return;

  if (text) {
    const cacheKey = `${chatId}_${text}`;
    const lastTime = userCommandCache.get(cacheKey) || 0;
    if (Date.now() - lastTime < 3000) {
      console.log(`[RateLimit] Dropping repeated command from ${chatId}: ${text}`);
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
      
      await editTelegramMessage(chatId, existingThinkingMessageId as number, `🗣️ **語音辨識成功：**\n「${text}」\n\n正在為您處理...`);
      message.text = text; // fake it for downstream
      delete message.voice;
    } catch (e: any) {
      console.error('Voice extraction error', e);
      await editTelegramMessage(chatId, existingThinkingMessageId as number, `語音處理失敗：${e.message}`);
      return;
    }
  }

  if (!text) return;

  console.log(`[DEBUG] processTelegramUpdate called. chatId: ${chatId}, text: ${text}`);

  const lowerText = text.toLowerCase();
  const secretaryUserId = await getOrCreateUser(chatId);
  try {
    if (await handleClientSecretaryMessage(chatId, secretaryUserId, text)) {
      return;
    }
  } catch (error) {
    console.error('[CLIENT_SECRETARY] Failed to process message:', error);
  }

  if (lowerText === '/start') {
    const userId = await getOrCreateUser(chatId);
    const reply = 'MeetingFlow 已切到專案管理模式。請打開 Dashboard，用「客戶 / 日期 / 一句紀錄」建立可連結到週曆與月曆的專案紀錄。';
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
    
    const memList = memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    await sendTelegram(chatId, `🧠 **我的記憶庫 (長期記憶)**\n\n${memList}\n\n💡 _這些記憶會在每天早安簡報中自動生效，幫您把關重要時程！_`);
    return;
  }

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
      await sendTelegram(chatId, `✅ 已成功新增看板：[${boardName}]\n\n網頁重新整理後即可看到新看板。未來指派任務時可以直接說「放到${boardName}看板」。`);
    } else {
      await sendTelegram(chatId, `⚠️ 看板 [${boardName}] 已經存在囉！`);
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
      await sendTelegram(chatId, `✅ 已成功移除看板：[${boardName}]`);
    } else {
      await sendTelegram(chatId, `⚠️ 找不到名為 [${boardName}] 的看板。`);
    }
    return;
  }

  if (lowerText === '/boards') {
    const userId = await getOrCreateUser(chatId);
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const categories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    await sendTelegram(chatId, `📋 **目前的情境看板清單**：\n\n${categories.map((c: string) => `- [${c}]`).join('\n')}\n\n您可以使用 \`/addboard 名稱\` 來新增，或 \`/rmboard 名稱\` 來移除。`);
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

  if (looksLikeDashboardCommand(text)) {
    const userId = await getOrCreateUser(chatId);
    const reply = '打開 Dashboard 查看所有批次、待辦與行程。';
    await sendTelegram(chatId, reply, [[{ text: '打開 Dashboard', url: getDashboardUrl(userId) }]]);
    return;
  }

  const greetings = ['你好', '嗨', '哈囉', 'hello', 'hi', 'test', '測試', '安安', '早安', '午安', '晚安', '在嗎'];
  if (text.length <= 10 && greetings.some(g => text.toLowerCase().includes(g))) {
    const reply = '你好！我是你的 MeetingFlow 智能助理 👋\n\n你可以直接傳送「會議紀錄」或是「待辦事項」給我，我會幫你自動抽出任務與行程。\n\n輸入 /week 即可查看未來一週的行程與待辦總覽！';
    await sendTelegram(chatId, reply);
    return;
  }

  const isShort = text.length <= 50;
  const thinkingMessageId = existingThinkingMessageId || await sendThinkingMessage(chatId, isShort);

  const userId = await getOrCreateUser(chatId);

  // chat_history 已停用

  const startedAt = Date.now();
  const stopProgressUpdates = startProgressUpdates(chatId as number, thinkingMessageId as number, isShort);

  try {
    const route = await routeIntent(userId, text);
    console.log(`[Router] intent=${route.intent} keyword=${route.delete_keyword} timeframe=${route.query_timeframe}`);

    if (route.intent === 'delete_item' && route.delete_keyword) {
      // Find matching tasks with ilike
      const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', userId).ilike('title', `%${route.delete_keyword}%`).limit(5);
      
      if (tasks && tasks.length > 0) {
        // Construct interactive buttons for each found task
        let replyText = `🔍 為您找到 ${tasks.length} 筆包含「${route.delete_keyword}」的任務，請問要刪除哪一項？`;
        const buttons: TelegramButton[][] = tasks.map(t => [
          { text: `🗑️ 刪除: ${t.title}`, callback_data: `delete_task_${t.id}` }
        ]);
        
        if (tasks.length > 1) {
          const shortKw = route.delete_keyword.substring(0, 15);
          buttons.push([{ text: `⚠️ 一次刪除全部 (${tasks.length} 筆)`, callback_data: `del_all_kw_${shortKw}` }]);
        }
        
        buttons.push([{ text: '❌ 取消', callback_data: `cancel_delete` }]);
        
        await editTelegramMessage(chatId as number, thinkingMessageId as number, replyText, buttons);
      } else {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, `找不到包含「${route.delete_keyword}」的相關任務，請確認名稱是否正確。`);
      }
      return;
    } else if (route.intent === 'delete_item') {
      const isClearAll = /(全部|所有|清空|一切)/.test(text);
      if (isClearAll) {
        const buttons = [
          [{ text: '⚠️ 確定清空「所有」內容', callback_data: 'del_all_content_confirm' }],
          [{ text: '❌ 取消', callback_data: 'cancel_delete' }]
        ];
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '您要求清空全部內容。這將會刪除您所有的任務與行程。確定要繼續嗎？', buttons);
      } else {
        await editTelegramMessage(chatId as number, thinkingMessageId as number, '刪除失敗：缺少刪除關鍵字。請明確指出要刪除什麼任務。');
      }
      return;
    }

    if (route.intent === 'eod_journal' || text.toLowerCase().startsWith('/eod')) {
      const eodText = text.toLowerCase().startsWith('/eod') ? text.substring(4).trim() : text;
      await handleEodJournalCommand(chatId as number, userId, eodText, thinkingMessageId as number);
      return;
    }



    if (route.intent === 'query_schedule') {
      await handleQueryScheduleCommand(chatId as number, userId, route.query_timeframe || null, thinkingMessageId as number);
      return;
    }

    if (route.intent === 'chit_chat' && route.reply_message) {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, route.reply_message);
      return;
    } else if (route.intent === 'chit_chat') {
      await handleChitChatCommand(chatId as number, thinkingMessageId as number, '聽不懂您的意思，可以換個方式說嗎？');
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

    if (route.intent === 'supplement') {
      await editTelegramMessage(chatId as number, thinkingMessageId as number, '「補充/修改會議紀錄」功能已停用。請至 Dashboard 使用新的客戶週控板管理。');
      return;
    }

    // Default
    await editTelegramMessage(chatId as number, thinkingMessageId as number, '自動會議紀錄萃取已停用。請至 Dashboard 使用客戶週控板，或直接選取文字設定日期。');
  } finally {
    stopProgressUpdates();
  }
}

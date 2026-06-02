import { TELEGRAM_BOT_TOKEN } from '../utils/env';

export type TelegramButton = {
  text: string;
  url?: string;
  callback_data?: string;
  web_app?: { url: string };
};

export async function sendTelegram(chatId: number, text: string, buttons?: TelegramButton[][]) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined
      })
    });
  } catch (error) {
    console.error('sendTelegram error', error);
  }
}

export async function sendThinkingMessage(chatId: number, isShort: boolean = false): Promise<number | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: isShort ? '📝 已接收，分析中...' : '收到，我正在萃取會議中的待辦與行程。長篇紀錄可能需要 10~30 秒，請稍候。'
      })
    });
    const data = await response.json() as any;
    return data.result?.message_id || null;
  } catch (error) {
    console.error('sendThinkingMessage error', error);
    return null;
  }
}

export async function editTelegramMessage(chatId: number, messageId: number, text: string, buttons?: TelegramButton[][]) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined
      })
    });
  } catch (error) {
    console.error('editTelegramMessage error', error);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (error) {
    console.error('answerCallbackQuery error', error);
  }
}

export async function getTelegramFileBuffer(fileId: string): Promise<Buffer> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json() as any;
  if (!data.ok) throw new Error('Failed to get file info from Telegram');
  const filePath = data.result.file_path;
  
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

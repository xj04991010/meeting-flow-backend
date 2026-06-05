import { getOrCreateUser } from '../repositories/users.repo';
import { Hono } from 'hono';
import { markTelegramUpdateReceived } from '../repositories/message-events.repo';
import { createSourceBatch } from '../repositories/source-batches.repo';
import { createProcessingJob } from '../repositories/processing-jobs.repo';
import { supabase } from '../utils/db';
import { processTelegramUpdate } from '../services/message-handler.service';
import { handleCallbackQuery } from '../services/callback-handler.service';
import { sendThinkingMessage } from '../services/telegram.service';

export const telegramRoute = new Hono<{ Variables: { userId: string } }>();



telegramRoute.post('/webhook', async (c) => {
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('Unauthorized webhook access attempt');
    return c.text('Unauthorized', 401);
  }

  try {
    const body = await c.req.json();
    const updateId = body.update_id;
    const message = body.message;
    const callback = body.callback_query;

    if (!updateId) return c.text('OK'); // Ignore malformed

    // 1. Dedup (防重複觸發)
    const { duplicated } = await markTelegramUpdateReceived(updateId);
    if (duplicated) {
      console.log(`[Dedup] Update ${updateId} already processed.`);
      return c.text('OK'); // Fast ACK for retries
    }

    if (message) {
      const chatId = message.chat?.id;
      const text = message.text?.trim() || '';

      if (chatId) {
        const lowerText = text.toLowerCase();
        
        // Enqueue the entire message for asynchronous processing (including NLP Intent Routing)
        const userId = await getOrCreateUser(chatId);
        await createProcessingJob(userId, 'PROCESS_TELEGRAM_UPDATE', { message });
      }
    } else if (callback) {
      const chatId = callback.message?.chat?.id;
      const data = callback.data;
      if (chatId && data) {
        const userId = await getOrCreateUser(chatId);
        await createProcessingJob(userId, 'HANDLE_CALLBACK', {
          chatId,
          callbackId: callback.id,
          data,
          messageId: callback.message.message_id
        });
      }
    }
    
    // 4. Return 200 OK immediately
    return c.text('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    return c.text('OK'); // Always return OK to Telegram
  }
});

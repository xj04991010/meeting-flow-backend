import { Hono } from 'hono';
import { markTelegramUpdateReceived } from '../repositories/message-events.repo';
import { createSourceBatch } from '../repositories/source-batches.repo';
import { createProcessingJob } from '../repositories/processing-jobs.repo';
import { supabase } from '../utils/db';
import { sendThinkingMessage } from '../services/telegram.service';

export const telegramRoute = new Hono<{ Variables: { userId: string } }>();

async function getOrCreateUser(telegramChatId: number): Promise<string> {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_chat_id', telegramChatId)
    .maybeSingle();

  if (user) return user.id;

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ telegram_chat_id: telegramChatId })
    .select('id')
    .single();

  if (error) throw error;
  return newUser.id;
}

telegramRoute.post('/webhook', async (c) => {
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
        const userId = await getOrCreateUser(chatId);
        
        // 2. Fast ACK / Thinking message
        // Instead of running LLM here, we just save to DB and queue job
        await sendThinkingMessage(chatId, false);
        
        const batchId = await createSourceBatch(userId, text || 'voice_or_file_placeholder');
        
        // 3. Queue Background Job
        await createProcessingJob(userId, 'EXTRACT_MEETING', {
          chatId,
          text,
          voice: message.voice ? message.voice.file_id : null,
          batchId
        });
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

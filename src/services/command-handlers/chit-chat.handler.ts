import { editTelegramMessage } from '../telegram.service';

export async function handleChitChatCommand(chatId: number, thinkingId: number, replyMessage: string) {
  await editTelegramMessage(chatId, thinkingId, replyMessage);
}

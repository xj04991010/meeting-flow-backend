import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import type { TelegramButton } from '../message-handler.service';

export async function handleDeleteCommand(chatId: number, userId: string, keyword: string, thinkingId: number) {
  const { data: tasks } = await supabase.from('tasks').select('id, title').eq('user_id', userId).ilike('title', `%${keyword}%`).limit(5);
  
  if (tasks && tasks.length > 0) {
    let replyText = `🔍 為您找到 ${tasks.length} 筆包含「${keyword}」的任務，請問要刪除哪一項？`;
    const buttons: TelegramButton[][] = tasks.map(t => [
      { text: `🗑️ 刪除: ${t.title}`, callback_data: `delete_task_${t.id}` }
    ]);
    
    if (tasks.length > 1) {
      const shortKw = keyword.substring(0, 15);
      buttons.push([{ text: `⚠️ 一次刪除全部 (${tasks.length} 筆)`, callback_data: `del_all_kw_${shortKw}` }]);
    }
    
    buttons.push([{ text: '❌ 取消', callback_data: `cancel_delete` }]);
    
    await editTelegramMessage(chatId, thinkingId, replyText, buttons);
  } else {
    await editTelegramMessage(chatId, thinkingId, `找不到包含「${keyword}」的相關任務，請確認名稱是否正確。`);
  }
}

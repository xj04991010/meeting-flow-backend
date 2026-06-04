import { supabase } from '../../utils/db';
import { sendThinkingMessage, editTelegramMessage } from '../telegram.service';
import { generateResearchReport } from '../../research';
import { getDashboardUrl } from '../../utils/env';

export async function handleResearchCommand(chatId: number, userId: string, query: string, isUrl: boolean) {
  const thinkingMessageId = await sendThinkingMessage(chatId, false);
  
  // Update thinking message
  await editTelegramMessage(chatId, thinkingMessageId as number, `🔍 開始為您深度研究：「${query}」\n(這可能需要幾十秒鐘，請稍候...)`);

  // Insert into database as 'processing'
  const { data: doc, error } = await supabase.from('research_documents').insert({
    user_id: userId,
    title: isUrl ? '網頁深度總結' : query,
    content: '正在處理中...',
    status: 'processing'
  }).select('id').single();

  if (error || !doc) {
    console.error('Failed to create research document', error);
    await editTelegramMessage(chatId, thinkingMessageId as number, '❌ 建立研究報告失敗，請稍後再試。');
    return;
  }

  // Run in background so we don't block
  setTimeout(async () => {
    try {
      const report = await generateResearchReport(userId, query, isUrl);
      
      // Extract title from report if possible, or keep the query
      let title = isUrl ? query : query;
      const titleMatch = report.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        title = titleMatch[1].substring(0, 100);
      }

      await supabase.from('research_documents').update({
        title,
        content: report,
        status: 'completed'
      }).eq('id', doc.id);

      await editTelegramMessage(chatId, thinkingMessageId as number, `✅ 深度研究完成！已將報告加入您的 Dashboard：\n\n📌 **${title}**\n\n[打開 Dashboard 閱讀](${getDashboardUrl(userId)})`);
    } catch (e: any) {
      console.error('Deep research failed:', e);
      await supabase.from('research_documents').update({
        content: `研究過程中發生錯誤：${e.message}`,
        status: 'failed'
      }).eq('id', doc.id);
      await editTelegramMessage(chatId, thinkingMessageId as number, `❌ 研究失敗：${e.message}`);
    }
  }, 0);
}

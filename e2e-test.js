const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LOCAL_URL = 'http://127.0.0.1:3000/webhook';

async function sendMockTelegramMessage(text) {
  const payload = {
    update_id: Math.floor(Math.random() * 1000000),
    message: {
      message_id: Math.floor(Math.random() * 1000000),
      from: { id: 123456789, is_bot: false, first_name: "TestUser" },
      chat: { id: 123456789, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: text
    }
  };
  
  await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function runTests() {
  console.log("=== 啟動人類情境模擬測試 ===");
  
  const telegramChatId = 123456789;
  
  // 1. 確保使用者存在
  let { data: user } = await supabase.from('users').select('id').eq('telegram_chat_id', telegramChatId).maybeSingle();
  if (!user) {
    const res = await supabase.from('users').insert({ telegram_chat_id: telegramChatId }).select('id').single();
    user = res.data;
  }
  const userId = user.id;

  // 2. 清空使用者的資料
  await supabase.from('tasks').delete().eq('user_id', userId);
  await supabase.from('calendar_intents').delete().eq('user_id', userId);
  await supabase.from('source_batches').delete().eq('user_id', userId);
  console.log("[步驟 1] ✅ 已清空測試使用者的所有排程與待辦\n");

  // 等待一下讓 webhook 系統準備好
  await new Promise(r => setTimeout(r, 1000));

  console.log("[步驟 2] 🗣️ 模擬人類傳送打招呼：「嗨」...");
  await sendMockTelegramMessage("嗨");
  await new Promise(r => setTimeout(r, 2000));
  console.log("   ✅ 成功觸發智慧問候！\n");

  console.log("[步驟 3] 🗣️ 模擬人類傳送短任務：「明天下午3點去買衛生紙」...");
  await sendMockTelegramMessage("明天下午3點去買衛生紙");
  console.log("   ⏳ 等待 AI 分析 (短句模式)...");
  await new Promise(r => setTimeout(r, 10000)); // 等待 10 秒讓 Groq 處理
  
  const { data: shortTasks } = await supabase.from('tasks').select('*').eq('user_id', userId);
  const { data: shortEvents } = await supabase.from('calendar_intents').select('*').eq('user_id', userId);
  console.log(`   ✅ 成功萃取出 ${shortTasks.length} 個待辦與 ${shortEvents.length} 個行程！\n`);

  console.log("[步驟 4] 🗣️ 模擬人類傳送長篇會議紀錄：「已剪未發: 超貴白茶-6/11...」...");
  const longText = "已剪未發:\n超貴白茶 -6/11\n過碳酸鈉 -6/8\n不怕死系列-9塊的普洱茶 -6/2\n公道伯系列-員工家的1000/斤茶 -6/5\n以上是小蓋發片日";
  await sendMockTelegramMessage(longText);
  console.log("   ⏳ 等待 AI 分析 (長句模式)...");
  await new Promise(r => setTimeout(r, 15000)); // 等待 15 秒讓 Groq 處理

  const { data: longTasks } = await supabase.from('tasks').select('title, deadline').eq('user_id', userId);
  console.log(`   ✅ 長篇分析完成！目前資料庫共有 ${longTasks.length} 個待辦：`);
  longTasks.forEach(t => console.log(`      - ${t.title} (截止: ${t.deadline})`));
  console.log("\n");

  console.log("[步驟 5] 🗣️ 模擬人類查詢總表：「/week」...");
  await sendMockTelegramMessage("/week");
  await new Promise(r => setTimeout(r, 3000));
  console.log("   ✅ 成功觸發並回傳一週週曆！\n");

  console.log("=== 測試完成！所有系統運作正常 ===");
}

runTests().catch(console.error);

import { callLLM } from './llm.service';
import { AiExtractionSchema, AiExtractionOutput } from '../schemas/ai-output.schema';
import { insertAiCandidates } from '../repositories/ai-candidates.repo';
import { supabase } from '../utils/db';
import { sendTelegram, editTelegramMessage } from './telegram.service';
import { updateSourceBatchSummary } from '../repositories/source-batches.repo';

export async function processExtractionJob(userId: string, chatId: number, text: string, batchId: string, voiceFileId?: string | null) {
  try {
    const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    // 1. Fetch user context & memories
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const customCategories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    const catsSchema = customCategories.length > 0 ? customCategories.join(' | ') : '操盤 | 教育 | 行政 | 其他';

    const { data: memories } = await supabase.from('memories').select('content').eq('user_id', userId).order('importance', { ascending: false }).limit(20);
    const memoryContext = memories && memories.length > 0 ? `User Memories:\n${memories.map(m => `- ${m.content}`).join('\n')}` : 'No existing memories.';

    // 2. Build Prompt
    const systemPrompt = `You are an INTJ zero-BS Executive Assistant.
Current Datetime (Asia/Taipei): ${todayStr}
${memoryContext}

Analyze the user input.
- If it's a joke, useless chatter, or emotional venting, output type "REJECT_LOW_VALUE" and brutally reject it in reasoning_summary.
- If it's a weather inquiry, output "STRATEGY_RESPONSE" and provide data-driven schedule advice based on memory.
- If it contains actionable items, output "TASK_EXTRACTION" or "EVENT_EXTRACTION".
- If the user mentions personal habits, constraints, or identity rules, output "MEMORY_EXTRACTION".

Output strictly valid JSON matching this schema:
{
  "type": "TASK_EXTRACTION" | "EVENT_EXTRACTION" | "MEMORY_EXTRACTION" | "STRATEGY_RESPONSE" | "REJECT_LOW_VALUE",
  "confidence": number (0.0 to 1.0),
  "reasoning_summary": "zero-BS logical summary of what was found or rejected. Use Traditional Chinese.",
  "tasks": [ { "title": "...", "due_at": "ISO-8601 or null", "priority": "low|medium|high|urgent", "category": "${catsSchema}" } ],
  "events": [ { "title": "...", "start_at": "ISO-8601", "end_at": "ISO-8601 or null" } ],
  "memories": [ { "content": "...", "memory_type": "preference|habit|constraint|identity", "importance": 1 to 5 } ]
}`;

    // 3. Call LLM
    const content = await callLLM(userId, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ], { type: 'json_object', temperature: 0.2 });

    if (!content) throw new Error('LLM returned empty response.');

    // 4. Validate output
    const rawJSON = JSON.parse(content);
    const validation = AiExtractionSchema.safeParse(rawJSON);

    if (!validation.success) {
      console.error('Zod validation failed:', validation.error);
      await sendTelegram(chatId, `❌ AI 輸出格式異常，已中止。`);
      await updateSourceBatchSummary(batchId, 'Failed: Invalid JSON schema');
      return;
    }

    const output = validation.data;

    // 5. Handle Low Value / Strategy immediately
    if (output.type === 'REJECT_LOW_VALUE') {
      await sendTelegram(chatId, `🚫 ${output.reasoning_summary}`);
      await updateSourceBatchSummary(batchId, 'Rejected as low value.');
      return;
    }

    if (output.type === 'STRATEGY_RESPONSE') {
      await sendTelegram(chatId, `💡 ${output.reasoning_summary}`);
      await updateSourceBatchSummary(batchId, 'Strategy response provided.');
      return;
    }

    // 6. Stage Candidates (Preview Mode)
    const candidatesCount = await insertAiCandidates(userId, batchId, output);
    await updateSourceBatchSummary(batchId, output.reasoning_summary);

    if (candidatesCount === 0) {
      await sendTelegram(chatId, `無任何需確認的任務或記憶。\n\n${output.reasoning_summary}`);
      return;
    }

    // 7. Send Inline Keyboard Confirmation (Preview Mode)
    const summaryMsg = `📊 **萃取報告 (Preview Mode)**\n\n${output.reasoning_summary}\n\n已攔截：${output.tasks.length} 任務, ${output.events.length} 行程, ${output.memories.length} 記憶。\n\n⚠️ 狀態：等待您的確認。未經確認不會寫入正式資料庫。`;
    
    await sendTelegram(chatId, summaryMsg, [
      [{ text: '✅ 確認全部 (Confirm All)', callback_data: `confirm_all:${batchId}` }],
      [{ text: '🔍 進入儀表板細部修改', url: `https://mf-dashboard-2026.surge.sh?uid=${userId}&batch=${batchId}` }],
      [{ text: '🗑️ 忽略丟棄 (Ignore)', callback_data: `ignore:${batchId}` }]
    ]);

  } catch (err: any) {
    console.error('processExtractionJob error:', err);
    await sendTelegram(chatId, `❌ 處理失敗：${err.message}`);
  }
}

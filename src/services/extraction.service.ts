import { callLLM, transcribeAudio } from './llm.service';
import { AiExtractionSchema, AiExtractionOutput } from '../schemas/ai-output.schema';
import { insertAiCandidates } from '../repositories/ai-candidates.repo';
import { supabase } from '../utils/db';
import { sendTelegram, editTelegramMessage, getTelegramFileBuffer } from './telegram.service';
import { updateSourceBatchSummary } from '../repositories/source-batches.repo';
import { loadRelevantMemories } from './memory.service';
import { createDecisionLog } from './decision-logger.service';
import { loadPlaybookRules, buildPlaybookPrompt } from './playbook.service';
import { calculateRiskScore, detectPrepGap } from './strategy.service';

export async function processExtractionJob(userId: string, chatId: number, text: string, batchId: string, voiceFileId?: string | null, thinkingMessageId?: number | null) {
  const reply = async (msg: string, buttons?: any) => { 
    if (thinkingMessageId) { 
      try { 
        await editTelegramMessage(chatId, thinkingMessageId, msg, buttons); 
        return; 
      } catch (e) { 
        console.error(e); 
      } 
    } 
    await sendTelegram(chatId, msg, buttons); 
  };
  try {
    let inputText = text;
    if (voiceFileId) {
      await reply('🎙️ 收到語音，正在轉錄...');
      const audioBuffer = await getTelegramFileBuffer(voiceFileId);
      inputText = await transcribeAudio(audioBuffer, 'voice.ogg');
      await reply(`📝 語音轉錄內容：\n${inputText}`);
    }

    const todayStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    // 1. Fetch user context & memories & rules
    const { data: userRow } = await supabase.from('users').select('custom_categories').eq('id', userId).single();
    const customCategories = userRow?.custom_categories || ['操盤', '教育', '行政', '其他'];
    const catsSchema = customCategories.length > 0 ? customCategories.join(' | ') : '操盤 | 教育 | 行政 | 其他';

    const memories = await loadRelevantMemories(userId, inputText);
    const memoryContext = memories && memories.length > 0 ? `User Memories:\n${memories.map(m => `- ${m.content}`).join('\n')}` : 'No existing memories.';

    const rules = await loadPlaybookRules(userId);
    const playbookPrompt = buildPlaybookPrompt(rules);

    // 2. Build Prompt
    const systemPrompt = `You are a professional, highly capable, and warm Personal Secretary.
Current Datetime (Asia/Taipei): ${todayStr}
${memoryContext}
${playbookPrompt}

Analyze the user input.
- If the user is chatting, asking questions, or greeting you, output type "CONVERSATIONAL_RESPONSE" and provide a helpful, natural, and friendly reply in reasoning_summary.
- If it contains actionable items, output "TASK_EXTRACTION" or "EVENT_EXTRACTION".
- If the user mentions personal habits, constraints, or identity rules, output "MEMORY_EXTRACTION".
- DECISION ENGINE (Tasks): Calculate "risk_score" (0-100) based on urgency and unfulfilled promise risk.
- DECISION ENGINE (Events): If a meeting lacks clear preparation materials, add "prep_gap_notes" to point out the missing items based on memories.
- MEMORY GRAPH: For every memory, explicitly cite the "evidence_text" from the user's input, and classify "entity_type" as "person", "project", "preference", or "rule".

Output strictly valid JSON matching this schema:
{
  "type": "TASK_EXTRACTION" | "EVENT_EXTRACTION" | "MEMORY_EXTRACTION" | "CONVERSATIONAL_RESPONSE",
  "confidence": number (0.0 to 1.0),
  "reasoning_summary": "Your conversational reply or logical summary. Use Traditional Chinese and be polite and professional.",
  "tasks": [ { "title": "...", "due_at": "ISO-8601 or null", "priority": "low|medium|high|urgent", "category": "${catsSchema}", "risk_score": 0, "prep_gap_notes": "null or string" } ],
  "events": [ { "title": "...", "start_at": "ISO-8601", "end_at": "ISO-8601 or null", "prep_gap_notes": "null or string" } ],
  "memories": [ { "content": "...", "memory_type": "preference|habit|constraint|identity", "entity_type": "person|project|preference|rule", "importance": 1 to 5, "evidence_text": "..." } ]
}`;

    // 3. Call LLM
    const content = await callLLM(userId, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: inputText }
    ], { type: 'json_object', temperature: 0.2 });

    if (!content) throw new Error('LLM returned empty response.');

    // 4. Validate output
    const cleanContent = content.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    const rawJSON = JSON.parse(cleanContent);
    const validation = AiExtractionSchema.safeParse(rawJSON);

    if (!validation.success) {
      console.error('Zod validation failed:', validation.error);
      await reply(`❌ AI 輸出格式異常，已中止。`);
      await updateSourceBatchSummary(batchId, 'Failed: Invalid JSON schema');
      return;
    }

    const output = validation.data;

    // Apply Strategy Engine Post-Processing
    if (output.tasks && output.tasks.length > 0) {
      output.tasks.forEach(t => {
        // Only override if LLM didn't calculate a high risk score
        const calcScore = calculateRiskScore(t);
        if (calcScore > (t.risk_score || 0)) {
          t.risk_score = calcScore;
        }
      });
    }

    if (output.events && output.events.length > 0) {
      output.events.forEach(e => {
        if (!e.prep_gap_notes && detectPrepGap(e.title)) {
          e.prep_gap_notes = '系統偵測到可能需要會前準備資料，請確認是否齊全。';
        }
      });
    }

    // Log the decision
    await createDecisionLog({
      userId,
      sourceBatchId: batchId,
      decisionType: output.type,
      inputText,
      selectedMemories: memories.map(m => m.id),
      outputJson: rawJSON,
      model: 'llama-3.3-70b-versatile', // hardcoded for now, or extracted from callLLM response if possible
      confidence: output.confidence
    });

    // 5. Handle Conversational Response immediately
    if (output.type === 'CONVERSATIONAL_RESPONSE') {
      await reply(`${output.reasoning_summary}`);
      await updateSourceBatchSummary(batchId, 'Conversational response provided.');
      return;
    }

    // 6. Stage Candidates (Preview Mode)
    const candidatesCount = await insertAiCandidates(userId, batchId, output);
    await updateSourceBatchSummary(batchId, output.reasoning_summary, output);

    if (candidatesCount === 0) {
      await reply(`無任何需確認的任務或記憶。\n\n${output.reasoning_summary}`);
      return;
    }

    // 7. Send Inline Keyboard Confirmation (Preview Mode)
    const summaryMsg = `📊 **萃取報告 (Preview Mode)**\n\n${output.reasoning_summary}\n\n已攔截：${output.tasks.length} 任務, ${output.events.length} 行程, ${output.memories.length} 記憶。\n\n⚠️ 狀態：等待您的確認。未經確認不會寫入正式資料庫。`;
    
    await reply(summaryMsg, [
      [{ text: '✅ 確認全部 (Confirm All)', callback_data: `confirm_all:${batchId}` }],
      [{ text: '🔍 進入儀表板細部修改', url: `https://meeting-flow-backend-1.onrender.com?uid=${userId}&batch=${batchId}` }],
      [{ text: '🗑️ 忽略丟棄 (Ignore)', callback_data: `ignore:${batchId}` }]
    ]);

  } catch (err: any) {
    console.error('processExtractionJob error:', err);
    await reply(`❌ 處理失敗：${err.message}`);
  }
}

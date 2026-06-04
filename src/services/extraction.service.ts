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
  const startedAt = Date.now();
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
    const systemPrompt = `You are a highly efficient, blunt, and extremely professional Executive Assistant (INTJ persona).
Current Datetime (Asia/Taipei): ${todayStr}
${memoryContext}
${playbookPrompt}

Analyze the user input.
- If the user asks about their schedule, tasks, or calendar (e.g. "本周代辦", "今天有什麼事"), output type "CONVERSATIONAL_RESPONSE" and reply with EXACTLY: "👉 查詢行程與待辦，請直接點擊輸入框旁邊的「/」選單，選擇 /week (本週摘要) 或 /morning (晨間簡報) 喔！".
- If the user is otherwise chatting, asking questions, or greeting you, output type "CONVERSATIONAL_RESPONSE" and provide a brief, logical, and blunt reply in reasoning_summary. DO NOT be overly polite.
- If it contains actionable items, output "TASK_EXTRACTION" or "EVENT_EXTRACTION".
- If the user mentions personal habits, constraints, or identity rules, output "MEMORY_EXTRACTION".
- TASK EXTRACTION RULES: 
  1. ACTIONABLE TITLES: Do NOT just name the client or project (e.g., "雅典木桶 - 4支"). You MUST write out exactly WHAT needs to be done. The title MUST start with an action verb (e.g., "[追蹤] 雅典木桶專案 - 確認4支影片拍攝時間", "[發包] 高大發專案 - 外包5支影片", "[寫企劃] NINI - 14號前開行前會"). Make it instantly clear what the next physical action is.
  2. Do NOT split goals or contexts into separate tasks. If the user mentions a reason or goal, append it to the relevant tasks' notes.
  3. If the task involves bosses, payments, or is emphasized, set priority to "high" or "urgent". Intelligently merge related fragmented items.
  4. ABSOLUTE DATES: Convert all relative dates (e.g., "周四", "下周一", "14號") to ISO-8601. For days of the week (like "周四"), calculate the exact date for THIS WEEK based on the Current Datetime. IF AND ONLY IF the user explicitly types "未排程" (unscheduled), set 'due_at' to null. OTHERWISE, if NO timeframe is mentioned, default to 7 days from now.
  5. CLIENT STATUS/NOTES: Capture ALL tracking statuses, warnings, or anomalies (e.g., "死不回", "待業主確認", "等待業主"). Append these heavily into "prep_gap_notes" or the task "title" so they are not lost.
- DECISION ENGINE (Tasks): Calculate "risk_score" (0-100) based on urgency and unfulfilled promise risk.
- DECISION ENGINE (Events): If a meeting lacks clear preparation materials, add "prep_gap_notes" to point out the missing items based on memories.
- MEMORY GRAPH: For every memory, explicitly cite the "evidence_text" from the user's input, and classify "entity_type" as "person", "project", "preference", or "rule".

Output strictly valid JSON matching this schema:
{
  "type": "TASK_EXTRACTION" | "EVENT_EXTRACTION" | "MEMORY_EXTRACTION" | "CONVERSATIONAL_RESPONSE",
  "confidence": number (0.0 to 1.0),
  "reasoning_summary": "Your brief analytical summary in Traditional Chinese (Taiwanese context). NO polite greetings, be blunt and precise.",
  "memory_applied_log": ["If you applied any rules from User Memories, list them here, e.g., '已知偏好：週五不排會，已改至週四'"],
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
      await reply(`無任何需處理的任務或記憶。\n\n${output.reasoning_summary}`);
      return;
    }

    // 7. Confidence Safeguard
    const confidenceScore = output.confidence || 0;
    
    let memoryStr = '';
    if (output.memory_applied_log && output.memory_applied_log.length > 0) {
      memoryStr = `\n\n🧠 **記憶套用軌跡**：\n` + output.memory_applied_log.map((m: string) => `• ${m}`).join('\n');
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (confidenceScore >= 0.4) {
      // Auto-commit everything!
      const { autoConfirmBatch } = await import('./confirmation.service');
      await autoConfirmBatch(userId, batchId, chatId);
      
      const summaryMsg = `⚡ **已自動為您處理完畢**\n\n${output.reasoning_summary}${memoryStr}\n\n已寫入：${output.tasks.length} 任務, ${output.events.length} 行程, ${output.memories.length} 記憶。\n\n⏱️ 運算耗時：${seconds} 秒`;
      
      await reply(summaryMsg, [
        [{ text: '❌ 撤銷本次新增', callback_data: `undo_batch_${batchId}` }],
        [{ text: '🔍 進入儀表板細部修改', url: `https://meeting-flow-backend-1.onrender.com?uid=${userId}&batch=${batchId}` }]
      ]);
    } else {
      // Low confidence: Send Inline Keyboard Confirmation (Preview Mode)
      const summaryMsg = `📊 **萃取報告 (語意模糊，請求確認)**\n\n${output.reasoning_summary}${memoryStr}\n\n已攔截：${output.tasks.length} 任務, ${output.events.length} 行程, ${output.memories.length} 記憶。\n\n⚠️ 狀態：等待您的確認。未經確認不會寫入正式資料庫。\n\n⏱️ 運算耗時：${seconds} 秒`;
      
      await reply(summaryMsg, [
        [{ text: '✅ 全部確認並同步', callback_data: `sync_batch_${batchId}` }],
        [{ text: '❌ 辨識錯誤，放棄此筆紀錄', callback_data: `reject_batch_${batchId}` }],
        [{ text: '🔍 進入儀表板細部修改', url: `https://meeting-flow-backend-1.onrender.com?uid=${userId}&batch=${batchId}` }]
      ]);
    }

  } catch (err: any) {
    console.error('processExtractionJob error:', err);
    await reply(`❌ 處理失敗：${err.message}`);
  }
}

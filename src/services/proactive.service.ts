import { supabase } from '../utils/db';
import { callLLM } from './llm.service';

type MemoryRow = {
  id: string;
  content: string | null;
  importance?: number | null;
  entity_type?: string | null;
};

type ExistingTaskRow = {
  title: string | null;
  deadline: string | null;
  source_quote?: string | null;
};

type ProactiveTaskRow = {
  user_id: string;
  title: string;
  deadline: string | null;
  priority: 'high' | 'medium' | 'low';
  category: string;
  status: 'needs_review';
  confidence: number;
  needs_review: true;
  source_batch_id: null;
  source_quote: string;
  proactive_source_memory_id: string;
  proactive_occurrence_key: string;
};

const LOOKAHEAD_DAYS = 14;

const scheduleSignalPatterns = [
  /\b\d{1,2}[/-]\d{1,2}\b/,
  /[一二三四五六七八九十\d]{1,3}\s*月\s*[一二三四五六七八九十\d]{1,3}\s*(日|號)?/,
  /每\s*(年|月|週|周|星期|禮拜)/,
  /(每個月|月初|月中|月底|年初|年底)/,
  /(週|周|星期|禮拜)\s*[一二三四五六日天]/,
  /(生日|紀念日|繳費|繳卡費|結帳|結算|續約|到期)/
];

function hasExplicitScheduleSignal(memory: MemoryRow) {
  const content = memory.content || '';
  return scheduleSignalPatterns.some((pattern) => pattern.test(content));
}

function normalizeTitle(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizePriority(value: unknown): 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'low' ? value : 'medium';
}

function getTaipeiDateKey(date: Date) {
  return date.toLocaleString('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function getTaipeiDateKeyFromValue(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return getTaipeiDateKey(date);
}

function isWithinLookahead(dueAt: string, now: Date) {
  const dueKey = getTaipeiDateKeyFromValue(dueAt);
  if (!dueKey) return false;

  const todayKey = getTaipeiDateKey(now);
  const lookaheadKey = getTaipeiDateKey(new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
  return dueKey >= todayKey && dueKey <= lookaheadKey;
}

function buildOccurrenceKey(sourceMemoryId: string, dueAt: string) {
  const dueKey = getTaipeiDateKeyFromValue(dueAt);
  return dueKey ? `proactive:${sourceMemoryId}:${dueKey}` : null;
}

function buildSourceQuote(sourceMemoryId: string, occurrenceKey: string, sourceQuote: string) {
  const quote = sourceQuote.replace(/\s+/g, ' ').trim().slice(0, 180);
  return `AI_PROACTIVE occurrence_key=${occurrenceKey} source_memory_id=${sourceMemoryId} source="${quote}"`;
}

function extractOccurrenceKey(sourceQuote?: string | null) {
  const match = sourceQuote?.match(/occurrence_key=([^\s]+)/);
  return match?.[1] || null;
}

function existingTitleDateKey(task: ExistingTaskRow) {
  const title = normalizeTitle(task.title);
  const day = getTaipeiDateKeyFromValue(task.deadline);
  if (!title || !day) return null;
  return `${title}|${day}`;
}

async function insertProactiveTask(row: ProactiveTaskRow) {
  const { error } = await supabase.from('tasks').insert(row);
  if (!error) return true;

  if (error.code === '23505') return false;

  // Keep deployment order safe: if the new idempotency columns have not been
  // migrated yet, source_quote + pre-insert duplicate checks still protect us.
  if (error.code === '42703' || /proactive_(source_memory_id|occurrence_key)/.test(error.message || '')) {
    const { proactive_source_memory_id, proactive_occurrence_key, ...fallbackRow } = row;
    const fallback = await supabase.from('tasks').insert(fallbackRow);
    if (!fallback.error) return true;
    if (fallback.error.code === '23505') return false;
    console.error('insertProactiveTask fallback error:', fallback.error);
    return false;
  }

  console.error('insertProactiveTask error:', error);
  return false;
}

export async function scanMemoriesAndGenerateTasks(userId: string, simulateDateStr?: string) {
  const { data: memories, error: memoriesError } = await supabase
    .from('memories')
    .select('id, content, importance, entity_type')
    .eq('user_id', userId);

  if (memoriesError) {
    console.error('Failed to fetch memories for proactive scan:', memoriesError);
    return 0;
  }

  const scheduledMemories = (memories || [])
    .filter((memory: MemoryRow) => memory.content && hasExplicitScheduleSignal(memory));

  if (scheduledMemories.length === 0) return 0;

  const { data: tasks, error: tasksError } = await supabase
    .from('tasks')
    .select('title, deadline, source_quote')
    .eq('user_id', userId)
    .not('status', 'in', '("completed","cancelled")');

  if (tasksError) {
    console.error('Failed to fetch existing tasks for proactive scan:', tasksError);
    return 0;
  }

  const existingOccurrenceKeys = new Set(
    (tasks || [])
      .map((task: ExistingTaskRow) => extractOccurrenceKey(task.source_quote))
      .filter(Boolean)
  );
  const existingTitleDateKeys = new Set(
    (tasks || [])
      .map((task: ExistingTaskRow) => existingTitleDateKey(task))
      .filter(Boolean)
  );

  const now = simulateDateStr ? new Date(simulateDateStr) : new Date();
  const today = getTaipeiDateKey(now);
  const lookahead = getTaipeiDateKey(new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));

  const prompt = `You are MeetingFlow's proactive task generator.

Current date in Asia/Taipei: ${today}
Lookahead window: ${today} through ${lookahead}

Only use the memory records below. Each record has an id and content.
${JSON.stringify(scheduledMemories, null, 2)}

Hard rules:
1. Generate a task only when the memory content contains an explicit date, birthday, anniversary, monthly/weekly/yearly recurrence, payment due date, renewal date, or deadline.
2. Do not infer dates from broad identity, preferences, responsibilities, goals, or vague long-term topics.
3. Every generated task must cite exactly one source_memory_id from the provided records.
4. source_quote must copy the exact phrase in the memory that contains the date or recurrence evidence.
5. due_at must be the actual occurrence date within the lookahead window, in ISO-8601 format.
6. If evidence is weak or no occurrence falls in the lookahead window, output an empty new_tasks array.
7. Prefix each title with "[AI推演] ".
8. Output JSON only.

Schema:
{
  "new_tasks": [
    {
      "title": "...",
      "due_at": "ISO-8601 datetime",
      "priority": "high | medium | low",
      "category": "其他",
      "source_memory_id": "memory uuid",
      "source_quote": "exact evidence phrase"
    }
  ]
}`;

  const content = await callLLM(userId, [{ role: 'user', content: prompt }], { type: 'json_object', temperature: 0 });
  if (!content) return 0;

  try {
    const cleanContent = content.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleanContent);
    const newTasks = Array.isArray(parsed.new_tasks) ? parsed.new_tasks : [];
    const memoryById = new Map(scheduledMemories.map((memory: MemoryRow) => [memory.id, memory]));

    let insertedCount = 0;
    for (const task of newTasks) {
      const sourceMemoryId = typeof task.source_memory_id === 'string' ? task.source_memory_id : '';
      const sourceMemory = memoryById.get(sourceMemoryId);
      const title = normalizeTitle(task.title);
      const dueAt = typeof task.due_at === 'string' ? task.due_at : '';
      const dueKey = getTaipeiDateKeyFromValue(dueAt);
      const occurrenceKey = buildOccurrenceKey(sourceMemoryId, dueAt);

      if (!sourceMemory || !title || !dueAt || !dueKey || !occurrenceKey) continue;
      if (!hasExplicitScheduleSignal(sourceMemory)) continue;
      if (!isWithinLookahead(dueAt, now)) continue;
      if (existingOccurrenceKeys.has(occurrenceKey)) continue;

      const titleDateKey = `${title}|${dueKey}`;
      if (existingTitleDateKeys.has(titleDateKey)) continue;

      const sourceQuote = typeof task.source_quote === 'string' && task.source_quote.trim()
        ? task.source_quote
        : sourceMemory.content || '';

      const inserted = await insertProactiveTask({
        user_id: userId,
        title,
        deadline: dueAt,
        priority: normalizePriority(task.priority),
        category: typeof task.category === 'string' && task.category.trim() ? task.category.trim() : '其他',
        status: 'needs_review',
        confidence: 0.6,
        needs_review: true,
        source_batch_id: null,
        source_quote: buildSourceQuote(sourceMemoryId, occurrenceKey, sourceQuote),
        proactive_source_memory_id: sourceMemoryId,
        proactive_occurrence_key: occurrenceKey
      });

      if (inserted) {
        insertedCount += 1;
        existingOccurrenceKeys.add(occurrenceKey);
        existingTitleDateKeys.add(titleDateKey);
      }
    }

    return insertedCount;
  } catch (err) {
    console.error('Failed to parse proactive AI output:', err, content);
    return 0;
  }
}

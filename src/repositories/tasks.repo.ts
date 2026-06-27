import { supabase } from '../utils/db';
import { ExtractedTask } from '../schemas/extraction.schema';

export const AUTO_ACCEPT_CONFIDENCE = 0.8;

export function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  if (parsed > 1) return Math.min(parsed / 100, 1);
  return Math.max(0, Math.min(parsed, 1));
}

export function hasMeaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function makeReviewFlag(confidence: number, explicitNeedsReview: unknown, hasRequiredTime = true) {
  return Boolean(explicitNeedsReview) || confidence < AUTO_ACCEPT_CONFIDENCE || !hasRequiredTime;
}

export async function insertTasks(userId: string, batchId: string | null, tasks: ExtractedTask[]) {
  const rows = tasks
    .filter((task) => hasMeaningfulText(task.title))
    .map((task) => {
      const confidence = normalizeConfidence(task.confidence);
      const needsReview = makeReviewFlag(confidence, task.needs_review);
      return {
        user_id: userId,
        title: (task.title || '').trim(),
        category: task.category || '其他',
        status: needsReview ? 'needs_review' : 'pending',
        deadline: task.deadline || null,
        priority: task.priority || 'medium',
        source_batch_id: batchId,
        client: task.client || null,
        owner: task.owner || null,
        confidence,
        needs_review: needsReview,
        source_quote: task.source_quote || null
      };
    });

  if (rows.length === 0) return 0;

  const { data, error } = await supabase.from('tasks').insert(rows).select('id');
  if (!error) return data.map(d => d.id);

  console.error('insertTasks rich schema error', error);

  const fallbackRows = rows.map(({ user_id, title, category, status, deadline }) => ({
    user_id,
    title,
    category,
    status,
    deadline
  }));
  const fallback = await supabase.from('tasks').insert(fallbackRows).select('id');
  if (fallback.error) throw new Error(`Failed to insert tasks: ${fallback.error.message}`);
  return fallback.data.map(d => d.id);
}

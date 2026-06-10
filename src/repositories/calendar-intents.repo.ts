import { supabase } from '../utils/db';
import { ExtractedEvent } from '../schemas/extraction.schema';
import { normalizeConfidence, hasMeaningfulText } from './tasks.repo';

export async function insertEvents(userId: string, batchId: string | null, events: ExtractedEvent[]) {
  const rows = events
    .filter((event) => hasMeaningfulText(event.title) && hasMeaningfulText(event.start_time))
    .map((event) => {
      const confidence = normalizeConfidence(event.confidence);
      return {
        user_id: userId,
        title: (event.title || '').trim(),
        start_time: event.start_time,
        end_time: event.end_time || null,
        action_type: 'propose_create',
        status: 'needs_review',
        source_batch_id: batchId,
        client: event.client || null,
        location: event.location || null,
        confidence,
        needs_review: true,
        source_quote: event.source_quote || null,
        sync_status: 'pending_review'
      };
    });

  if (rows.length === 0) return 0;

  const { error } = await supabase.from('calendar_intents').insert(rows);
  if (!error) return rows.length;

  console.error('insertEvents rich schema error', error);

  const fallbackRows = rows.map(({ user_id, title, start_time, end_time, action_type, status }) => ({
    user_id,
    title,
    start_time,
    end_time,
    action_type,
    status
  }));
  const fallback = await supabase.from('calendar_intents').insert(fallbackRows);
  if (fallback.error) throw new Error(`Failed to insert events: ${fallback.error.message}`);
  return rows.length;
}

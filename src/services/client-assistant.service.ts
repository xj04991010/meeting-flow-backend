import { getClients } from '../repositories/clients.repo';
import {
  getClientWeeklyNotes,
  getLatestNotesForAllClients,
} from '../repositories/client-weekly-notes.repo';
import { supabase } from '../utils/db';
import { getTaipeiWeekKey, parseSupplementNote } from './client-secretary.service';
import { callLLM } from './llm.service';

type AssistantContext = {
  clients: Array<Record<string, unknown>>;
  notes: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
};

export function buildClientAssistantMessages(
  message: string,
  weekKey: string,
  context: AssistantContext,
) {
  const system = [
    'You are MeetingFlow, a project secretary for a short-video production manager.',
    'Answer in concise Traditional Chinese.',
    'Use only the supplied client, weekly note, task, event, traffic-light, inventory, and linked-date data.',
    'Never invent a date, status, promise, or completed action.',
    'If information is missing, state exactly what needs confirmation.',
    'Prioritize overdue and 0-3 day items, then red lights, yellow lights, low inventory, and unscheduled shoots.',
    'When asked what to do next, return a short ordered action list with client names and dates.',
    'This endpoint is read-only. Never claim that you changed records, sent a message, or scheduled an event.',
  ].join('\n');

  const user = [
    `Week key: ${weekKey}`,
    `Current date in Taipei: ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })}`,
    `Question: ${message}`,
    `MeetingFlow data: ${JSON.stringify(context)}`,
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export async function answerClientAssistant(
  userId: string,
  message: string,
  requestedWeekKey?: string,
) {
  const weekKey = requestedWeekKey || getTaipeiWeekKey();
  const [clients, weeklyNotes, tasksResult, eventsResult] = await Promise.all([
    getClients(userId),
    getClientWeeklyNotes(userId, weekKey),
    supabase
      .from('tasks')
      .select('title, client, category, status, priority, deadline, follow_up_date')
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .neq('status', 'completed')
      .order('deadline', { ascending: true })
      .limit(80),
    supabase
      .from('calendar_intents')
      .select('title, client, status, start_time, end_time, location')
      .eq('user_id', userId)
      .neq('status', 'cancelled')
      .gte('start_time', `${weekKey}T00:00:00+08:00`)
      .order('start_time', { ascending: true })
      .limit(80),
  ]);

  const notes = weeklyNotes.length > 0
    ? weeklyNotes
    : weekKey === getTaipeiWeekKey()
      ? await getLatestNotesForAllClients(userId)
      : [];
  const context: AssistantContext = {
    clients: clients.map((client) => ({
      name: client.name,
      status: client.status,
      contract_end: client.contract_end,
      default_monthly_target: client.default_monthly_target,
    })),
    notes: notes.map((note) => {
      const supplement = parseSupplementNote(note.urgent_note);
      return {
        client_name: note.client_name,
        week_key: note.week_key,
        traffic_light: note.traffic_light,
        raw_count: note.raw_count,
        edited_count: note.edited_count,
        scheduled_count: note.scheduled_count,
        unshot_count: note.unshot_count,
        current_status: note.current_status,
        progress_note: note.progress_note,
        next_week_note: note.next_week_note,
        shooting_note: supplement.shootingNote,
        company_help: supplement.companyHelp,
        date_links: note.date_links,
      };
    }),
    tasks: tasksResult.data || [],
    events: eventsResult.data || [],
  };

  return callLLM(userId, buildClientAssistantMessages(message, weekKey, context), {
    type: 'text',
    temperature: 0.15,
  });
}

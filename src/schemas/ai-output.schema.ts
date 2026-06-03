import { z } from 'zod';

export const AiExtractionSchema = z.object({
  type: z.enum([
    "TASK_EXTRACTION",
    "EVENT_EXTRACTION",
    "MEMORY_EXTRACTION",
    "CONVERSATIONAL_RESPONSE",
  ]),
  confidence: z.coerce.number().min(0).max(1).catch(0.9),
  reasoning_summary: z.string().catch(''),
  tasks: z.array(z.object({
    title: z.string(),
    due_at: z.string().nullable().catch(null),
    priority: z.string().nullable().catch('medium'),
    category: z.string().nullable().catch(null),
    risk_score: z.coerce.number().min(0).max(100).catch(0),
    prep_gap_notes: z.string().nullable().catch(null)
  })).catch([]).default([]),
  events: z.array(z.object({
    title: z.string(),
    start_at: z.string().nullable().catch(null),
    end_at: z.string().nullable().catch(null),
    prep_gap_notes: z.string().nullable().catch(null)
  })).catch([]).default([]),
  memories: z.array(z.object({
    content: z.string(),
    memory_type: z.string().catch('preference'),
    entity_type: z.string().catch('preference'),
    importance: z.coerce.number().min(1).max(5).catch(3),
    evidence_text: z.string().nullable().catch(null)
  })).catch([]).default([]),
});

export type AiExtractionOutput = z.infer<typeof AiExtractionSchema>;

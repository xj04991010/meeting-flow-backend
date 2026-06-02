import { z } from 'zod';

export const AiExtractionSchema = z.object({
  type: z.enum([
    "TASK_EXTRACTION",
    "EVENT_EXTRACTION",
    "MEMORY_EXTRACTION",
    "CONVERSATIONAL_RESPONSE",
  ]),
  confidence: z.number().min(0).max(1),
  reasoning_summary: z.string(),
  tasks: z.array(z.object({
    title: z.string(),
    due_at: z.string().nullable(),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    category: z.string().nullable(),
    risk_score: z.number().min(0).max(100).default(0),
    prep_gap_notes: z.string().nullable().default(null)
  })).default([]),
  events: z.array(z.object({
    title: z.string(),
    start_at: z.string().nullable(),
    end_at: z.string().nullable(),
    prep_gap_notes: z.string().nullable().default(null)
  })).default([]),
  memories: z.array(z.object({
    content: z.string(),
    memory_type: z.enum(["preference", "habit", "constraint", "identity"]),
    entity_type: z.enum(["person", "project", "preference", "rule"]).default("preference"),
    importance: z.number().min(1).max(5),
    evidence_text: z.string().nullable().default(null)
  })).default([]),
});

export type AiExtractionOutput = z.infer<typeof AiExtractionSchema>;

import { z } from 'zod';

export const AiExtractionSchema = z.object({
  type: z.enum([
    "TASK_EXTRACTION",
    "EVENT_EXTRACTION",
    "MEMORY_EXTRACTION",
    "STRATEGY_RESPONSE",
    "REJECT_LOW_VALUE",
  ]),
  confidence: z.number().min(0).max(1),
  reasoning_summary: z.string(),
  tasks: z.array(z.object({
    title: z.string(),
    due_at: z.string().nullable(),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    category: z.string().nullable(),
  })).default([]),
  events: z.array(z.object({
    title: z.string(),
    start_at: z.string().nullable(),
    end_at: z.string().nullable(),
  })).default([]),
  memories: z.array(z.object({
    content: z.string(),
    memory_type: z.enum(["preference", "habit", "constraint", "identity"]),
    importance: z.number().min(1).max(5),
  })).default([]),
});

export type AiExtractionOutput = z.infer<typeof AiExtractionSchema>;

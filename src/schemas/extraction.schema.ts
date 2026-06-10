import { z } from 'zod';

export const ExtractedTaskSchema = z.object({
  title: z.string().nullable().optional(),
  client: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
  category: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});
export type ExtractedTask = z.infer<typeof ExtractedTaskSchema>;

export const ExtractedEventSchema = z.object({
  title: z.string().nullable().optional(),
  client: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

export const ParserOutputSchema = z.object({
  reply_message: z.string().nullable().optional(),
  tasks: z.array(ExtractedTaskSchema).nullable().optional(),
  events: z.array(ExtractedEventSchema).nullable().optional(),
  memories: z.array(z.string()).nullable().optional(),
  unresolved_notes: z.array(z.string().nullable()).nullable().optional(),
  delete_targets: z.array(z.string()).nullable().optional()
});
export type ParserOutput = z.infer<typeof ParserOutputSchema>;

export type BatchSummary = {
  batchId: string | null;
  taskCount: number;
  eventCount: number;
  reviewCount: number;
  autoReadyEventCount: number;
  taskIds?: string[];
  memoryCount?: number;
};

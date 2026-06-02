import { z } from 'zod';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const ExtractedTaskSchema = z.object({
  title: z.string(),
  client: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});

const ExtractedEventSchema = z.object({
  title: z.string(),
  client: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  needs_review: z.boolean().nullable().optional(),
  source_quote: z.string().nullable().optional()
});

const ParserOutputSchema = z.object({
  reply_message: z.string().optional(),
  tasks: z.array(ExtractedTaskSchema).optional(),
  events: z.array(ExtractedEventSchema).optional(),
  unresolved_notes: z.array(z.string()).optional()
});

async function main() {
  const req = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are MeetingFlow's meeting extraction engine.
Extract tasks and events from the text into this exact JSON format:
{
  "reply_message": "...",
  "tasks": [{"title": "...", "priority": "high", "needs_review": true}],
  "events": [],
  "unresolved_notes": []
}` },
        { role: 'user', content: `本周要剪完\n未剪未發:\n茶葉口感 \n香氣口感\n小蓋的影片` }
      ]
    })
  });
  
  const data = await req.json();
  console.log("Groq API Response:", JSON.stringify(data, null, 2));
  const content = data.choices?.[0]?.message?.content;
  console.log("LLM Output:", content);
  
  const rawJSON = JSON.parse(content || '{}');
  const result = ParserOutputSchema.safeParse(rawJSON);
  
  if (!result.success) {
    console.error("Zod Error:", JSON.stringify(result.error.issues, null, 2));
  } else {
    console.log("Zod validation passed!");
  }
}

main();

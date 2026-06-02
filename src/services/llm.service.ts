import { GROQ_API_KEY, GROQ_TIMEOUT_MS } from '../utils/env';

export async function callLLM(userId: string, messages: { role: string; content: string }[], options?: { type?: 'json_object' | 'text', temperature?: number }): Promise<string | null> {
  const model = 'llama3-70b-8192'; // High accuracy
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options?.temperature ?? 0.1,
        response_format: options?.type === 'json_object' ? { type: 'json_object' } : undefined
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error('Groq API error:', errText);
      return null;
    }

    const data = await response.json() as any;
    return data.choices[0]?.message?.content || null;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error('Groq API timeout');
    } else {
      console.error('callLLM error:', error);
    }
    return null;
  }
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([audioBuffer as any], { type: 'audio/ogg' });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-large-v3-turbo');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: formData as any
  });
  
  if (!res.ok) {
    throw new Error(`Groq transcription failed: ${await res.text()}`);
  }
  const data = await res.json() as any;
  return data.text;
}

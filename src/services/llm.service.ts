import { GROQ_API_KEY, GROQ_TIMEOUT_MS } from '../utils/env';
import { getUserSettings } from '../repositories/users.repo';

export async function callLLM(userId: string, messages: { role: string; content: string }[], options?: { type?: 'json_object' | 'text', temperature?: number }): Promise<string | null> {
  const settings = await getUserSettings(userId);
  const provider = settings?.ai_provider || 'groq';
  const model = settings?.ai_model || 'llama-3.3-70b-versatile';
  const apiKey = settings?.api_key || GROQ_API_KEY;

  if (!apiKey) {
    console.error('API Key is missing. Please configure it in the dashboard settings.');
    return null;
  }

  const payload = {
    model,
    messages,
    temperature: options?.temperature ?? 0.1,
    ...(options?.type ? { response_format: { type: options.type } } : {})
  };

  let endpoint = 'https://api.groq.com/openai/v1/chat/completions';
  if (provider === 'openai') endpoint = 'https://api.openai.com/v1/chat/completions';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`${provider} API error:`, errText);
      return null;
    }

    const data = await response.json() as any;
    const content = data.choices[0]?.message?.content;
    
    if (!content || content.trim() === '') {
       console.error('LLM returned an empty response');
       return null;
    }
    return content;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.error(`${provider} API timeout`);
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

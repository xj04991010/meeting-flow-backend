import { supabase } from '../../utils/db';
import { editTelegramMessage } from '../telegram.service';
import { callLLM } from '../llm.service';

export async function handleWeatherCommand(chatId: number, userId: string, location: string, thinkingId: number) {
  let weatherData = '';
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    if (res.ok) {
      const json: any = await res.json();
      const current = json.current_condition?.[0] || {};
      const weatherDesc = current.weatherDesc?.[0]?.value || '';
      weatherData = `目前的溫度: ${current.temp_C}°C, 體感溫度: ${current.FeelsLikeC}°C, 天氣: ${weatherDesc}, 濕度: ${current.humidity}%.`;
      const tomorrow = json.weather?.[1];
      if (tomorrow) {
        weatherData += `\n明天的預報：最高溫 ${tomorrow.maxtempC}°C, 最低溫 ${tomorrow.mintempC}°C, 降雨機率: ${tomorrow.hourly?.[0]?.chanceofrain || 0}%.`;
      }
    } else {
      weatherData = '無法取得氣象數據。';
    }
  } catch (err) {
    weatherData = '氣象 API 連線失敗。';
  }

  // Fetch user memories to personalize the weather report
  const { data: userMemories } = await supabase.from('memories').select('content').eq('user_id', userId);
  const memoryStr = userMemories ? userMemories.map(m => m.content).join('; ') : '';

  const weatherPrompt = `You are an INTJ zero-BS executive assistant.
The user asked about the weather for: ${location}.
Raw Weather Data: ${weatherData}
User's Long-Term Memories & Habits: ${memoryStr}

Instructions:
1. Provide a brutally direct, logical weather report.
2. Cross-reference the weather data with the user's memories (e.g. if it will rain, suggest moving A-Fu's dog training indoors, or advise on their gym/diet routine).
3. Do NOT use polite fluff. Output ONLY the data-driven report and actionable suggestions.`;

  const aiReply = await callLLM(userId, [{ role: 'system', content: weatherPrompt }], { type: 'text' });
  await editTelegramMessage(chatId, thinkingId, aiReply || '氣象分析失敗。');
}

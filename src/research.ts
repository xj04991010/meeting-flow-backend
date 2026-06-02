import { callLLM } from './services/llm.service';
import * as cheerio from 'cheerio';

const RESEARCH_PROMPT = `
You are a world-class AI research assistant and technical writer. 
Your task is to conduct a "Deep Research" on the provided topic or summarize the provided text in extreme detail.
Provide a comprehensive, structured Markdown report.
Make sure to include:
- An executive summary.
- Core concepts and deep-dive analysis.
- Structured sections with clear headers (H2, H3).
- Bullet points or tables for comparison where appropriate.
- Actionable takeaways or conclusions.
Write your response in Traditional Chinese (zh-TW).
`;

/**
 * Fetch and extract text from a given URL
 */
export async function fetchUrlText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    // Remove scripts and styles
    $('script, style, noscript, iframe, img, svg').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 30000); // limit to 30k chars
  } catch (error: any) {
    throw new Error(`Failed to fetch URL: ${error.message}`);
  }
}

/**
 * Generate a Deep Research report for a topic or text
 */
export async function generateResearchReport(userId: string, input: string, isUrl: boolean = false): Promise<string> {
  let contentToAnalyze = input;
  
  if (isUrl) {
    try {
      contentToAnalyze = await fetchUrlText(input);
      contentToAnalyze = `Please deeply analyze and summarize the following content from ${input}:\n\n${contentToAnalyze}`;
    } catch (e: any) {
      return `## ❌ Fetch Error\nFailed to read the URL: ${e.message}\n\nPlease check if the URL is accessible publicly.`;
    }
  } else {
    contentToAnalyze = `Please conduct a deep research and write a comprehensive report on the following topic:\n\n${input}`;
  }

  const content = await callLLM(userId, [
    { role: 'system', content: RESEARCH_PROMPT },
    { role: 'user', content: contentToAnalyze }
  ], { type: 'text', temperature: 0.3 });

  return content || "No content generated.";
}

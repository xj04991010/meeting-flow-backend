import { beforeAll, vi } from 'vitest';

process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.CRON_SECRET = 'test-secret';

beforeAll(() => {
  // Mock console to keep test output clean
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

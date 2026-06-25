import * as dotenv from 'dotenv';
dotenv.config();

export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
export const PORT = Number(process.env.PORT || 3000);
export const PARSER_VERSION = 'meeting-extract-v2';
export const GROQ_TIMEOUT_MS = 90_000;
export const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || 'https://meeting-flow-backend-1.onrender.com';
export const DASHBOARD_ACCESS_TOKEN = process.env.DASHBOARD_ACCESS_TOKEN || '';

export function getDashboardUrl(uid?: string) {
  const url = new URL(DASHBOARD_BASE_URL);
  if (uid) url.searchParams.set('uid', uid);
  if (DASHBOARD_ACCESS_TOKEN) url.searchParams.set('token', DASHBOARD_ACCESS_TOKEN);
  return url.toString();
}

export const CRON_SECRET = process.env.CRON_SECRET || 'fallback-secret';

export function requireEnv() {
  const missing = [
    ['SUPABASE_URL', SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY],
    ['TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN],
    ['GROQ_API_KEY', GROQ_API_KEY]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.map(([key]) => key).join(', ')}`);
    process.exit(1);
  }
}

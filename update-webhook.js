const fs = require('fs');
let code = fs.readFileSync('src/routes/telegram.ts', 'utf8');

// Remove duplicate getOrCreateUser and import it
const getOrCreateUserDef = `async function getOrCreateUser(telegramChatId: number): Promise<string> {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_chat_id', telegramChatId)
    .maybeSingle();

  if (user) return user.id;

  const { data: newUser, error } = await supabase
    .from('users')
    .insert({ telegram_chat_id: telegramChatId })
    .select('id')
    .single();

  if (error) throw error;
  return newUser.id;
}`;
code = code.replace(getOrCreateUserDef, '');

if (!code.includes("import { getOrCreateUser } from '../repositories/users.repo';")) {
  code = "import { getOrCreateUser } from '../repositories/users.repo';\n" + code;
}

// Update webhook route to include secret token verification
const webhookStartStr = `telegramRoute.post('/webhook', async (c) => {
  try {
    const body = await c.req.json();`;

const newWebhookStart = `telegramRoute.post('/webhook', async (c) => {
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('Unauthorized webhook access attempt');
    return c.text('Unauthorized', 401);
  }

  try {
    const body = await c.req.json();`;

code = code.replace(webhookStartStr, newWebhookStart);

fs.writeFileSync('src/routes/telegram.ts', code);
console.log('Successfully updated telegram webhook logic');

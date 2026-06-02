const fs = require('fs');
const dotenv = require('dotenv');

const envConfig = dotenv.parse(fs.readFileSync('.env'));
const token = envConfig.TELEGRAM_BOT_TOKEN;
const args = process.argv.slice(2);

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

if (args.length === 0) {
  console.log('Usage: node set_webhook.js https://your-public-tunnel-url');
  process.exit(1);
}

const publicUrl = args[0].replace(/\/$/, '');
const webhookUrl = `${publicUrl}/webhook`;

async function setWebhook() {
  console.log(`Setting Telegram webhook to ${webhookUrl}`);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });

    const data = await response.json();
    if (data.ok) {
      console.log('Webhook configured successfully.');
    } else {
      console.error('Webhook setup failed:', data.description || data);
      process.exit(1);
    }
  } catch (error) {
    console.error('Webhook setup request failed:', error);
    process.exit(1);
  }
}

setWebhook();

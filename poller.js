require('dotenv').config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOCAL_URL = 'http://localhost:3000/webhook';

async function clearWebhook() {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
  const json = await res.json();
  console.log('Webhook cleared:', json);
}

async function poll() {
  let offset = 0;
  console.log('Starting long polling for Telegram updates...');
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const json = await res.json();
      if (json.ok && json.result.length > 0) {
        for (const update of json.result) {
          offset = update.update_id + 1;
          console.log(`Forwarding update ${update.update_id}...`);
          try {
            await fetch(LOCAL_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(update)
            });
          } catch(err) {
            console.error('Failed to forward to local server:', err.message);
          }
        }
      }
    } catch(e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

clearWebhook().then(poll);

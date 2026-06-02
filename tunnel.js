const { spawn } = require('child_process');

function startTunnel() {
  console.log('Starting localtunnel...');
  const lt = spawn('npx', ['localtunnel', '--port', '3000', '--subdomain', 'meetingflow-tunnel'], { stdio: 'pipe', shell: true });

  lt.stdout.on('data', async (data) => {
    const output = data.toString();
    console.log(output);
    if (output.includes('your url is:')) {
      const match = output.match(/https:\/\/[^\s]+/);
      if (match) {
        const url = match[0];
        console.log('Detected URL:', url);
        try {
          const res = await fetch(`https://api.telegram.org/bot8876776825:AAEt0zJM0ruLNS2gjFeecNrBhEBISDkD7pQ/setWebhook?url=${url}/api/telegram`);
          const json = await res.json();
          console.log('Webhook update response:', json);
        } catch(e) {
          console.error('Failed to update webhook', e);
        }
      }
    }
  });

  lt.stderr.on('data', data => console.error(data.toString()));

  lt.on('close', (code) => {
    console.log(`localtunnel exited with code ${code}. Restarting in 2s...`);
    setTimeout(startTunnel, 2000);
  });
}

startTunnel();

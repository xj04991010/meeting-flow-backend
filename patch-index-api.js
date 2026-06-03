const fs = require('fs');
let content = fs.readFileSync('src/index.ts', 'utf8');

const injectStr = `
app.get('/api/dashboard/journals', async (c) => {
  const userId = c.get('userId');
  const { data, error } = await supabase.from('daily_journals').select('*').eq('user_id', userId).order('date', { ascending: false }).limit(7);
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});
`;

if (!content.includes('/api/dashboard/journals')) {
  content = content.replace("app.get('/api/dashboard/weekly',", injectStr + "\napp.get('/api/dashboard/weekly',");
  fs.writeFileSync('src/index.ts', content);
  console.log('Injected journals API');
} else {
  console.log('API already exists');
}

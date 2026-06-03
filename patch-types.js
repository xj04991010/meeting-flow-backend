const fs = require('fs');
let content = fs.readFileSync('frontend/src/types.ts', 'utf8');

const inject = `export type JournalRow = {
  id: string;
  user_id?: string;
  date: string;
  content: string;
  created_at: string;
};\n\n`;

if (!content.includes('export type JournalRow')) {
  content = inject + content;
  fs.writeFileSync('frontend/src/types.ts', content);
  console.log('Added JournalRow type');
}

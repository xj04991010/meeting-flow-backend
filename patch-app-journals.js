const fs = require('fs');
let content = fs.readFileSync('frontend/src/App.tsx', 'utf8');

// 1. Add Imports
if (!content.includes('import { JournalOverview }')) {
  content = content.replace(
    "import { SettingsModal } from './components/SettingsModal';",
    "import { SettingsModal } from './components/SettingsModal';\nimport { JournalOverview } from './components/JournalOverview';"
  );
}

if (!content.includes('JournalRow')) {
  content = content.replace(
    "import type { CalendarIntentRow, SourceBatchRow, TaskRow, UserRow, WeekBucket } from './types';",
    "import type { CalendarIntentRow, SourceBatchRow, TaskRow, UserRow, WeekBucket, JournalRow } from './types';"
  );
}

// 2. Add State
if (!content.includes('const [journals, setJournals]')) {
  content = content.replace(
    "const [batches, setBatches] = useState<SourceBatchRow[]>([]);",
    "const [batches, setBatches] = useState<SourceBatchRow[]>([]);\n  const [journals, setJournals] = useState<JournalRow[]>([]);"
  );
}

// 3. Update fetchData
const fetchOriginal = `        const dashboardRes = await fetch(\`\${API_BASE_URL}/api/dashboard/weekly\`, {`;
const fetchNew = `        const journalsRes = await fetch(\`\${API_BASE_URL}/api/dashboard/journals\`, {
          headers: { Authorization: \`tma \${initData}\` },
        });
        if (journalsRes.ok) {
          const jData = await journalsRes.json();
          setJournals(jData || []);
        }

        const dashboardRes = await fetch(\`\${API_BASE_URL}/api/dashboard/weekly\`, {`;
if (!content.includes('/api/dashboard/journals')) {
  content = content.replace(fetchOriginal, fetchNew);
}

// 4. Render JournalOverview in sidebar
if (!content.includes('<JournalOverview')) {
  content = content.replace(
    "<BatchList batches={batches} />",
    "<BatchList batches={batches} />\n          <JournalOverview journals={journals} />"
  );
}

fs.writeFileSync('frontend/src/App.tsx', content);
console.log('App.tsx patched successfully');

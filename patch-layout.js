const fs = require('fs');

// 1. Update App.tsx
let appContent = fs.readFileSync('frontend/src/App.tsx', 'utf8');

// The new layout sequence:
// 1. WeeklyTasks
// 2. Week Grid (calendar-priority)
// 3. ReviewPanel
// 4. RoleBoard
// 5. Metrics (Summary strip)
// 6. BatchList
// 7. JournalOverview
// 8. QuickInput

// We will construct the new layout by extracting elements and placing them in a new structure.
// Instead of complex regex, let's just do an intelligent replace.

const startOfLayout = '<main className="operations-layout">';
const endOfLayout = '{editing && ('; // Assuming editing modal starts after

const beforeLayout = appContent.substring(0, appContent.indexOf(startOfLayout));
const afterLayout = appContent.substring(appContent.indexOf(endOfLayout));

// I need to extract Week Grid out of calendar-priority because calendar-priority currently wraps WeeklyTasks. Wait, no.
// Currently App.tsx structure:
/*
      <main className="operations-layout">
        <section className="secondary-workspace">
          <WeeklyTasks ... />
          <RoleBoard ... />
          {user && <QuickInput onSuccess={fetchData} />}
        </section>

        <aside className="sidebar support-sidebar">
          <ReviewPanel ... />
          <section className="summary-strip compact" ... />
          <BatchList ... />
          <JournalOverview ... />
        </aside>
      </main>

      <section className="calendar-priority" aria-label="週曆主工作區">
        ... Week Grid ...
      </section>
*/

// Let's just find the exact strings to reconstruct.
const extractTag = (tagStart) => {
  const start = appContent.indexOf(tagStart);
  if (start === -1) return '';
  let brackets = 0;
  let end = start;
  let started = false;
  
  for (let i = start; i < appContent.length; i++) {
    if (appContent[i] === '<') {
      // Check if it's opening or closing
      if (appContent[i+1] === '/') {
        brackets--;
      } else if (appContent[i+1] !== '!' && appContent[i+1] !== '?') {
        const isSelfClosing = appContent.substring(i, i+200).match(/<[^>]+?\/>/);
        const tagContent = appContent.substring(i, appContent.indexOf('>', i) + 1);
        if (!tagContent.endsWith('/>')) {
          brackets++;
        }
      }
    }
    if (brackets > 0) started = true;
    if (started && brackets === 0) {
      end = appContent.indexOf('>', i) + 1;
      break;
    }
  }
  return appContent.substring(start, end);
};

// Wait, the tag extraction logic might be brittle for React elements.
// Since React components start with <ComponentName, we can just find them.
const extractComponent = (compName) => {
  const start = appContent.indexOf('<' + compName);
  if (start === -1) return '';
  const end = appContent.indexOf('/>', start) + 2;
  return appContent.substring(start, end);
};

const weeklyTasks = extractComponent('WeeklyTasks');
const roleBoard = extractComponent('RoleBoard');
const quickInput = '{user && <QuickInput onSuccess={fetchData} />}';
const reviewPanel = extractComponent('ReviewPanel');
const batchList = extractComponent('BatchList');
const journalOverview = extractComponent('JournalOverview');

// Metrics strip
const metricsStart = '<section className="summary-strip';
const metricsEnd = '</section>';
let metricsStrip = '';
if (appContent.includes(metricsStart)) {
  const mStart = appContent.indexOf(metricsStart);
  // Find matching </section>
  let depth = 1;
  let cur = mStart + 1;
  while(depth > 0 && cur < appContent.length) {
    const nextOpen = appContent.indexOf('<section', cur);
    const nextClose = appContent.indexOf('</section>', cur);
    if (nextClose === -1) break;
    
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cur = nextOpen + 1;
    } else {
      depth--;
      cur = nextClose + 10;
    }
  }
  metricsStrip = appContent.substring(mStart, cur);
}

// Calendar priority
const calStart = '<section className="calendar-priority" aria-label="週曆主工作區">';
let calBlock = '';
if (appContent.includes(calStart)) {
  const cStart = appContent.indexOf(calStart);
  let depth = 1;
  let cur = cStart + 1;
  while(depth > 0 && cur < appContent.length) {
    const nextOpen = appContent.indexOf('<section', cur);
    const nextClose = appContent.indexOf('</section>', cur);
    if (nextClose === -1) break;
    
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cur = nextOpen + 1;
    } else {
      depth--;
      cur = nextClose + 10;
    }
  }
  calBlock = appContent.substring(cStart, cur);
}

const newLayout = `
      <div className="linear-layout">
        ${weeklyTasks}
        ${calBlock}
        ${reviewPanel}
        ${roleBoard}
        ${metricsStrip.replace('summary-strip compact', 'summary-strip')}
        ${batchList}
        ${journalOverview}
        ${quickInput}
      </div>
`;

// Replace everything between </header> and {editing && (
const headerEnd = '</header>';
const hEndIdx = appContent.indexOf(headerEnd) + headerEnd.length;
const editIdx = appContent.indexOf(endOfLayout);

const finalAppContent = appContent.substring(0, hEndIdx) + '\n' + newLayout + '\n      ' + appContent.substring(editIdx);

fs.writeFileSync('frontend/src/App.tsx', finalAppContent);
console.log('App.tsx layout rewritten');

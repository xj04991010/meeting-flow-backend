const fs = require('fs');
let content = fs.readFileSync('frontend/src/App.tsx', 'utf8');

// 1. Remove WeeklyTasks from calendar-priority
const weeklyTasksStr = `
        <WeeklyTasks
          tasks={allTasks}
          selectedDate={selectedDate}
          onEditTask={(task) => setEditing({ type: 'task', item: task })}
          onToggleTaskComplete={handleToggleTaskComplete}
        />`;
content = content.replace(weeklyTasksStr, '');

// 2. Extract calendar-priority section
const calendarStart = '<section className="calendar-priority" aria-label="週曆主工作區">';
const calendarEnd = '</section>\n\n      <main className="operations-layout">';
const calendarBlock = content.substring(content.indexOf(calendarStart), content.indexOf(calendarEnd) + 10); // +10 to capture </section>

// 3. Extract operations-layout section
const opsStart = '<main className="operations-layout">';
const opsEnd = '</main>\n\n      {editing && (';
const opsBlock = content.substring(content.indexOf(opsStart), content.indexOf(opsEnd) + 7); // +7 to capture </main>

// 4. Inject WeeklyTasks into operations-layout
const newOpsBlock = opsBlock.replace(
  '<RoleBoard',
  `<WeeklyTasks
            tasks={allTasks}
            selectedDate={selectedDate}
            onEditTask={(task) => setEditing({ type: 'task', item: task })}
            onToggleTaskComplete={handleToggleTaskComplete}
          />
          <RoleBoard`
);

// 5. Reconstruct file
// The original structure is:
// </header>
// calendarBlock
// opsBlock
// {editing && (

const part1 = content.substring(0, content.indexOf(calendarStart));
const part2 = newOpsBlock + '\n\n      ' + calendarBlock;
const part3 = content.substring(content.indexOf(opsEnd) + 7);

fs.writeFileSync('frontend/src/App.tsx', part1 + part2 + part3);
console.log('App.tsx layout rearranged successfully.');

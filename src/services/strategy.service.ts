// This service provides business logic for calculating task risk scores and event prep gaps.
// We can use it to post-process AI outputs, or feed its context into the AI prompt.

export function calculateRiskScore(task: { due_at?: string | null, priority?: string | null }): number {
  let score = 0;
  
  // 1. Priority base score
  const priorityScores: Record<string, number> = {
    'urgent': 50,
    'high': 35,
    'medium': 15,
    'low': 0
  };
  score += priorityScores[task.priority || 'medium'] || 0;

  // 2. Deadline proximity score
  if (task.due_at) {
    const dueTime = new Date(task.due_at).getTime();
    const nowTime = new Date().getTime();
    const hoursLeft = (dueTime - nowTime) / (1000 * 60 * 60);

    if (hoursLeft < 0) {
      score += 50; // Overdue is max risk
    } else if (hoursLeft <= 24) {
      score += 40; // Due within 24h
    } else if (hoursLeft <= 72) {
      score += 20; // Due within 3 days
    }
  }

  // Future: historical delay rate could be fetched from DB and added here

  return Math.min(100, score);
}

export function detectPrepGap(eventTitle: string, eventDesc?: string): boolean {
  // A simple heuristic rule-based detection for now.
  // In the future, this can be powered by embedding similarity search.
  const keywords = ['pitch', 'board meeting', 'review', '投資人', '匯報', '報告', '月會'];
  const text = (eventTitle + ' ' + (eventDesc || '')).toLowerCase();
  
  return keywords.some(k => text.includes(k));
}

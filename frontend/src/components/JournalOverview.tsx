import { memo } from 'react';
import { BookOpen, Calendar as CalendarIcon } from 'lucide-react';
import type { JournalRow } from '../types';

interface JournalOverviewProps {
  journals: JournalRow[];
}

export const JournalOverview = memo(function JournalOverview({ journals }: JournalOverviewProps) {
  if (!journals || journals.length === 0) {
    return null; // Don't show anything if no journals
  }

  return (
    <section className="panel" aria-label="交接日誌總覽">
      <div className="panel-title">
        <div className="panel-title-main">
          <BookOpen size={16} />
          <h2>交接日誌總覽</h2>
        </div>
        <span className="badge">{journals.length} 篇</span>
      </div>
      <div className="batch-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
        {journals.map((journal) => {
          const dateObj = new Date(journal.date);
          const weekday = !Number.isNaN(dateObj.getTime())
            ? ['日', '一', '二', '三', '四', '五', '六'][dateObj.getDay()]
            : '';

          return (
            <div key={journal.id} className="batch-item">
              <div className="review-card-body">
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-main)', fontWeight: 600 }}>
                  <CalendarIcon size={14} style={{ color: 'var(--accent)' }} />
                  {journal.date} {weekday ? `(週${weekday})` : ''}
                </span>
                <strong style={{ fontSize: '0.86rem', color: 'var(--text-muted)', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
                  {journal.content}
                </strong>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
});

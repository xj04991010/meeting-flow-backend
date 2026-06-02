import { ClipboardList } from 'lucide-react';
import type { BatchListProps } from '../types';
import { formatDateOnly } from '../utils';

export function BatchList({ batches }: BatchListProps) {
  return (
    <section className="panel import-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <ClipboardList size={18} />
          <h2>最近匯入</h2>
        </div>
      </div>
      <div className="batch-list">
        {batches.slice(0, 4).map((batch) => (
          <article key={batch.id} className="batch-item">
            <strong>{batch.summary || '未命名批次'}</strong>
            <span>{formatDateOnly(batch.created_at)}</span>
          </article>
        ))}
        {batches.length === 0 && <div className="empty-state">尚無匯入紀錄。</div>}
      </div>
    </section>
  );
}

import { memo } from 'react';
import { AlertTriangle, CheckCircle2, SquarePen, Trash2 } from 'lucide-react';
import type { ReviewPanelProps } from '../types';
import { confidencePercent, formatDateOnly, formatTimeOnly } from '../utils';

export const ReviewPanel = memo(function ReviewPanel({
  tasks,
  events,
  onConfirmTask,
  onConfirmEvent,
  onEditTask,
  onEditEvent,
  onDeleteTask,
  onDeleteEvent,
}: ReviewPanelProps) {
  const total = tasks.length + events.length;

  return (
    <section className="panel review-panel">
      <div className="panel-title warning-title">
        <div className="panel-title-main">
          <AlertTriangle size={18} />
          <h2>待審核</h2>
        </div>
        <span className="badge">{total}</span>
      </div>

      <div className="review-list">
        {tasks.map((task) => (
          <article key={task.id} className="review-card task-type" onClick={() => onEditTask(task)}>
            <div className="review-card-body">
              <span className="card-type-badge task-badge">任務</span>
              <strong>
                {task.priority === 'high' && <span className="priority-dot">高</span>}
                {task.title}
              </strong>
              <p>{task.client || task.category || '未分類'} · 信心 {confidencePercent(task.confidence)}</p>
            </div>
            <div className="review-quick-actions" onClick={(event) => event.stopPropagation()}>
              <button className="icon-btn success-btn" onClick={() => onConfirmTask(task.id)} title="確認任務">
                <CheckCircle2 size={16} />
              </button>
              <button className="icon-btn neutral-btn" onClick={() => onEditTask(task)} title="編輯">
                <SquarePen size={15} />
              </button>
              {onDeleteTask && (
                <button className="icon-btn danger-btn" onClick={() => onDeleteTask(task.id)} title="忽略">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </article>
        ))}

        {events.map((event) => (
          <article key={event.id} className="review-card event-type" onClick={() => onEditEvent(event)}>
            <div className="review-card-body">
              <span className="card-type-badge event-badge">行程</span>
              <strong>{event.title}</strong>
              <p>{formatDateOnly(event.start_time)} {formatTimeOnly(event.start_time)} · 信心 {confidencePercent(event.confidence)}</p>
            </div>
            <div className="review-quick-actions" onClick={(clickEvent) => clickEvent.stopPropagation()}>
              <button className="icon-btn success-btn" onClick={() => onConfirmEvent(event.id)} title="確認行程">
                <CheckCircle2 size={16} />
              </button>
              <button className="icon-btn neutral-btn" onClick={() => onEditEvent(event)} title="編輯">
                <SquarePen size={15} />
              </button>
              {onDeleteEvent && (
                <button className="icon-btn danger-btn" onClick={() => onDeleteEvent(event.id)} title="忽略">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </article>
        ))}

        {total === 0 && <div className="empty-state">目前沒有待審核項目。</div>}
      </div>
    </section>
  );
});

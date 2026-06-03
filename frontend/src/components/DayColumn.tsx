import { memo } from 'react';
import { Calendar, CheckSquare, Clock, MapPin, Trash2 } from 'lucide-react';
import type { DayColumnProps } from '../types';
import { confidencePercent, formatTimeOnly, statusLabel } from '../utils';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function getDaySuffix(date: string) {
  if (date === 'past' || date === 'future') return '';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return '';
  return `週${WEEKDAYS[parsed.getDay()]}`;
}

function isPastBucket(date: string) {
  if (date === 'past') return true;
  if (date === 'future') return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parsed = new Date(date);
  parsed.setHours(0, 0, 0, 0);
  return !Number.isNaN(parsed.getTime()) && parsed < today;
}

export const DayColumn = memo(function DayColumn({
  bucket,
  onEditTask,
  onEditEvent,
  onToggleTaskComplete,
  onSyncEvent,
  onDropTask,
  onDropEvent,
  onDeleteTask,
  onDeleteEvent,
  weather,
}: DayColumnProps) {
  const isPast = isPastBucket(bucket.date);
  const daySuffix = getDaySuffix(bucket.date);

  return (
    <div
      className={`day-column ${bucket.is_today ? 'is-today' : ''} ${isPast ? 'is-past' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.currentTarget.classList.add('drag-over');
      }}
      onDragLeave={(event) => event.currentTarget.classList.remove('drag-over')}
      onDrop={(event) => {
        event.preventDefault();
        event.currentTarget.classList.remove('drag-over');
        if (bucket.date === 'past' || bucket.date === 'future') return;

        const type = event.dataTransfer.getData('type');
        if (type === 'task' && onDropTask) {
          const taskId = event.dataTransfer.getData('id');
          if (taskId) onDropTask(taskId, bucket.date);
        }

        if (type === 'event' && onDropEvent) {
          const eventId = event.dataTransfer.getData('id');
          const originalStart = event.dataTransfer.getData('originalStart');
          if (eventId && originalStart) onDropEvent(eventId, bucket.date, originalStart);
        }
      }}
    >
      <div className="day-header">
        <div>
          <h3>{bucket.label}</h3>
          <span>{bucket.date} {daySuffix}</span>
        </div>
        {weather && (
          <div className="weather-chip" title="天氣預報">
            <strong>{weather.label}</strong>
            <span>{weather.min}-{weather.max}C</span>
          </div>
        )}
      </div>

      <div className="day-content">
        <div className="day-section">
          <h4><Calendar size={13} /> 行程</h4>
          <div className="card-list">
            {bucket.events.map((event) => {
              const needsSync = event.sync_status !== 'synced' && event.sync_status !== 'pending_review';
              return (
                <article
                  key={event.id}
                  className={`event-card ${event.sync_status === 'synced' ? 'synced' : ''} ${isPast && event.sync_status !== 'synced' ? 'overdue' : ''}`}
                  onClick={() => onEditEvent(event)}
                  draggable
                  onDragStart={(dragEvent) => {
                    dragEvent.dataTransfer.setData('type', 'event');
                    dragEvent.dataTransfer.setData('id', event.id);
                    dragEvent.dataTransfer.setData('originalStart', event.start_time || '');
                  }}
                >
                  <div className="event-time">
                    <Clock size={12} />
                    {formatTimeOnly(event.start_time)}
                  </div>
                  <strong className="card-title">{event.title}</strong>
                  {event.location && (
                    <span className="muted-line"><MapPin size={12} /> {event.location}</span>
                  )}
                  <div className="card-footer">
                    <span className="client-tag">{event.client || 'General'}</span>
                    <div className="card-actions">
                      {event.sync_status === 'pending_review' ? (
                        <span className="status-pill neutral">{statusLabel(event.sync_status)}</span>
                      ) : event.sync_status === 'synced' ? (
                        <span className="status-pill success">已同步</span>
                      ) : needsSync ? (
                        <button
                          className="sync-btn"
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            onSyncEvent(event.id);
                          }}
                        >
                          <Calendar size={12} /> 同步
                        </button>
                      ) : null}
                      {onDeleteEvent && (
                        <button
                          className="icon-button compact danger"
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            onDeleteEvent(event.id);
                          }}
                          title="刪除行程"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="day-section">
          <h4><CheckSquare size={13} /> 任務</h4>
          <div className="card-list">
            {bucket.tasks.map((task) => (
              <article
                key={task.id}
                className={`task-card ${task.status === 'completed' ? 'completed' : ''} ${isPast && task.status !== 'completed' ? 'overdue' : ''}`}
                onClick={() => onEditTask(task)}
                draggable
                onDragStart={(dragEvent) => {
                  dragEvent.dataTransfer.setData('type', 'task');
                  dragEvent.dataTransfer.setData('id', task.id);
                  dragEvent.dataTransfer.setData('taskId', task.id);
                }}
              >
                <div className="task-header">
                  <button
                    className={`check-btn ${task.status === 'completed' ? 'checked' : ''}`}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      onToggleTaskComplete(task.id, task.status || 'pending');
                    }}
                    title="切換完成狀態"
                  />
                  <strong className="card-title">
                    {task.priority === 'high' && <span className="priority-dot">高</span>}
                    {task.title}
                  </strong>
                </div>
                <div className="card-footer">
                  <span className="client-tag">{task.client || task.category || 'General'}</span>
                  <span className="confidence-text">{confidencePercent(task.confidence)}</span>
                  {onDeleteTask && (
                    <button
                      className="icon-button compact danger"
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        onDeleteTask(task.id);
                      }}
                      title="刪除任務"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>

        {bucket.events.length === 0 && bucket.tasks.length === 0 && (
          <div className="empty-day">無排程。可拖曳任務到此日。</div>
        )}
      </div>
    </div>
  );
});

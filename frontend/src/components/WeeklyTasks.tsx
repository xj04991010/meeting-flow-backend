import { CheckSquare, Inbox } from 'lucide-react';
import type { TaskRow } from '../types';
import { formatDateOnly } from '../utils';

interface WeeklyTasksProps {
  tasks: TaskRow[];
  selectedDate: string;
  onEditTask: (task: TaskRow) => void;
  onToggleTaskComplete: (id: string, current: string) => void;
}

export function WeeklyTasks({ tasks, selectedDate, onEditTask, onToggleTaskComplete }: WeeklyTasksProps) {
  const targetDate = selectedDate ? new Date(selectedDate) : new Date();
  const day = targetDate.getDay();
  const diffToMonday = targetDate.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(targetDate);
  startOfWeek.setDate(diffToMonday);
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const weeklyTasks = tasks.filter((task) => {
    if (task.status === 'completed' || task.status === 'cancelled') return false;
    if (!task.deadline) return true;

    const taskDate = new Date(task.deadline);
    return taskDate >= startOfWeek && taskDate <= endOfWeek;
  });

  return (
    <section className="weekly-tasks-section">
      <div className="weekly-tasks-header">
        <h3 className="weekly-tasks-title">
          <CheckSquare size={16} />
          本週代辦池
        </h3>
        <span className="badge">{weeklyTasks.length}</span>
      </div>

      {weeklyTasks.length === 0 ? (
        <div className="weekly-empty-state">
          <Inbox size={18} />
          <span>本週沒有未完成任務。Telegram 或快速整理匯入後會集中顯示在這裡。</span>
        </div>
      ) : (
        <div className="weekly-tasks-grid">
          {weeklyTasks.map((task) => (
            <article key={task.id} className="weekly-task-card" onClick={() => onEditTask(task)}>
              <div className="task-header">
                <button
                  className={`check-btn ${task.status === 'completed' ? 'checked' : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
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
                {task.deadline ? (
                  <span className="client-tag">期限 {formatDateOnly(task.deadline)}</span>
                ) : (
                  <span className="client-tag attention">未排程</span>
                )}
                {task.client && <span className="client-tag">{task.client}</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

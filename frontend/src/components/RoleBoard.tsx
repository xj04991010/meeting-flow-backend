import { memo, useMemo } from 'react';
import { Calendar, Layers3, Trash2 } from 'lucide-react';
import type { TaskRow } from '../types';
import { formatDateOnly } from '../utils';

type RoleBoardProps = {
  tasks: TaskRow[];
  customCategories?: string[] | null;
  onEditTask: (task: TaskRow) => void;
  onToggleTaskComplete: (taskId: string, currentStatus: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUnscheduleTask?: (taskId: string) => void;
  onUpdateTaskCategory?: (taskId: string, category: string) => void;
};

const DEFAULT_CATEGORIES = ['工作', '客戶', '研究', '其他'];
const FALLBACK_CATEGORY = '其他';

export const RoleBoard = memo(function RoleBoard({
  tasks,
  customCategories,
  onEditTask,
  onToggleTaskComplete,
  onDeleteTask,
  onUnscheduleTask,
  onUpdateTaskCategory,
}: RoleBoardProps) {
  const categories = useMemo(() => {
    const baseCategories = customCategories && customCategories.length > 0 ? customCategories : DEFAULT_CATEGORIES;
    const finalCats = [...baseCategories];
    while (finalCats.length < 4) finalCats.push(FALLBACK_CATEGORY);
    return finalCats.slice(0, 4);
  }, [customCategories]);

  return (
    <section className="panel backlog-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <Layers3 size={18} />
          <h2>未排程看板</h2>
        </div>
        <span className="badge">{tasks.length}</span>
      </div>

      <div className="role-board-grid">
        {categories.map((category, idx) => {
          const categoryTasks = tasks.filter((task) => {
            const taskCategory = task.category || FALLBACK_CATEGORY;
            const isKnownCategory = categories.includes(taskCategory);
            if (category === FALLBACK_CATEGORY) return !isKnownCategory || taskCategory === FALLBACK_CATEGORY;
            return taskCategory === category;
          });

          return (
            <div
              key={`${category}-${idx}`}
              className="role-column"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const type = event.dataTransfer.getData('type');
                if (type !== 'task') return;

                const taskId = event.dataTransfer.getData('id') || event.dataTransfer.getData('taskId');
                if (!taskId) return;

                if (onUpdateTaskCategory) {
                  onUpdateTaskCategory(taskId, category);
                  return;
                }

                onUnscheduleTask?.(taskId);
              }}
            >
              <div className="role-column-header">
                <h3>{category}</h3>
                <span className="badge">{categoryTasks.length}</span>
              </div>

              <div className="role-task-list">
                {categoryTasks.length === 0 ? (
                  <div className="empty-state">沒有任務</div>
                ) : (
                  categoryTasks.map((task) => (
                    <article
                      key={task.id}
                      className={`task-card ${task.status === 'completed' ? 'completed' : ''}`}
                      draggable
                      onClick={() => onEditTask(task)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('type', 'task');
                        event.dataTransfer.setData('id', task.id);
                        event.dataTransfer.setData('taskId', task.id);
                      }}
                    >
                      <div className="task-header">
                        <button
                          className={`check-btn ${task.status === 'completed' ? 'checked' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleTaskComplete(task.id, task.status || 'pending');
                          }}
                          title="切換完成狀態"
                          aria-label="切換完成狀態"
                        />
                        <strong className="card-title">
                          {task.priority === 'high' && <span className="priority-dot">高</span>}
                          {task.title}
                        </strong>
                      </div>
                      <div className="card-footer">
                        <span className="muted-line">
                          <Calendar size={12} />
                          {task.deadline ? formatDateOnly(task.deadline) : '未排程'}
                        </span>
                        <div className="card-actions">
                          {task.client && <span className="client-tag">{task.client}</span>}
                          <button
                            className="icon-button compact danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteTask(task.id);
                            }}
                            title="刪除任務"
                            aria-label="刪除任務"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
});

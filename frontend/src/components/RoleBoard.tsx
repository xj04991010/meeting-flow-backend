import { memo, useMemo, useState } from 'react';
import { Calendar, Layers3, Trash2 } from 'lucide-react';
import type { TaskRow } from '../types';
import { formatDateOnly } from '../utils';

type RoleBoardProps = {
  tasks: TaskRow[];
  customCategories?: string[] | null;
  onEditTask: (task: TaskRow) => void;
  onToggleTaskComplete: (taskId: string, currentStatus: string) => void;
  onDeleteTask: (taskId: string) => void;
};

const DEFAULT_CATEGORIES = ['工作', '客戶', '研究', '個人', '其他'];

export const RoleBoard = memo(function RoleBoard({
  tasks,
  customCategories,
  onEditTask,
  onToggleTaskComplete,
  onDeleteTask,
}: RoleBoardProps) {
  const categories = useMemo(() => {
    const baseCategories = customCategories && customCategories.length > 0 ? customCategories : DEFAULT_CATEGORIES;
    const set = new Set(baseCategories);
    tasks.forEach((task) => {
      if (task.category) set.add(task.category);
    });
    return Array.from(set);
  }, [tasks, customCategories]);

  const [activeTab, setActiveTab] = useState(categories[0] || '其他');
  const activeCategory = categories.includes(activeTab) ? activeTab : categories[0] || '其他';

  const activeTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (!task.category && activeCategory === '其他') return true;
      return task.category === activeCategory;
    });
  }, [tasks, activeCategory]);

  return (
    <section className="panel backlog-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <Layers3 size={18} />
          <h2>未排程看板</h2>
        </div>
        <span className="badge">{tasks.length}</span>
      </div>

      <div className="tab-row" role="tablist" aria-label="任務分類">
        {categories.map((category) => (
          <button
            key={category}
            className={`tab-button ${activeCategory === category ? 'active' : ''}`}
            onClick={() => setActiveTab(category)}
            role="tab"
            aria-selected={activeCategory === category}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="role-task-list">
        {activeTasks.length === 0 ? (
          <div className="empty-state">此分類沒有未排程任務。</div>
        ) : (
          activeTasks.map((task) => (
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
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
});

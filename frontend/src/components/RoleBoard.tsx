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
};

const DEFAULT_CATEGORIES = ['工作', '客戶', '研究', '其他'];

export const RoleBoard = memo(function RoleBoard({
  tasks,
  customCategories,
  onEditTask,
  onToggleTaskComplete,
  onDeleteTask,
  onUnscheduleTask,
}: RoleBoardProps) {
  const categories = useMemo(() => {
    // Force exactly 4 categories for the 4-grid layout
    const baseCategories = customCategories && customCategories.length > 0 ? customCategories : DEFAULT_CATEGORIES;
    const finalCats = [...baseCategories];
    while (finalCats.length < 4) finalCats.push('其他');
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

      <div className="role-board-grid" style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(4, 1fr)', 
        gap: '16px',
        alignItems: 'start'
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('type');
        if (type === 'task' && onUnscheduleTask) {
          const taskId = e.dataTransfer.getData('id');
          if (taskId) onUnscheduleTask(taskId);
        }
      }}
      >
        {categories.map((category, idx) => {
          const categoryTasks = tasks.filter((task) => {
            if (!task.category && category === '其他') return true;
            return task.category === category;
          });

          return (
            <div key={`${category}-${idx}`} className="role-column" style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: '12px',
              background: 'var(--surface)',
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid var(--line)'
            }}>
              <h3 style={{ 
                margin: '0', 
                fontSize: '14px', 
                color: 'var(--text-soft)', 
                borderBottom: '1px solid var(--line)', 
                paddingBottom: '8px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                {category}
                <span className="badge">{categoryTasks.length}</span>
              </h3>
              
              <div className="role-task-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {categoryTasks.length === 0 ? (
                  <div className="empty-state" style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>無任務</div>
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
                      style={{ cursor: 'pointer' }}
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
            </div>
          );
        })}
      </div>
    </section>
  );
});

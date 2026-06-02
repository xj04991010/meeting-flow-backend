import { useState } from 'react';
import { Save, X } from 'lucide-react';
import type { EditModalProps } from '../types';
import { fromLocalInputValue, toLocalInputValue } from '../utils';

export function EditModal({ editing, onSave, onClose, saving }: EditModalProps) {
  const isTask = editing.type === 'task';
  const item = editing.item;

  const [title, setTitle] = useState(item.title || '');
  const [client, setClient] = useState(item.client || '');
  const [owner, setOwner] = useState(isTask ? editing.item.owner || '' : '');
  const [location, setLocation] = useState(!isTask ? editing.item.location || '' : '');
  const [deadline, setDeadline] = useState(isTask ? toLocalInputValue(editing.item.deadline) : '');
  const [startTime, setStartTime] = useState(!isTask ? toLocalInputValue(editing.item.start_time) : '');
  const [endTime, setEndTime] = useState(!isTask ? toLocalInputValue(editing.item.end_time) : '');
  const [status, setStatus] = useState(item.status || (isTask ? 'pending' : 'ready'));
  const [syncStatus, setSyncStatus] = useState(!isTask ? editing.item.sync_status || 'ready' : '');
  const [needsReview, setNeedsReview] = useState(Boolean(item.needs_review));

  const handleSave = () => {
    if (!title.trim()) return;

    const data: Record<string, unknown> = {
      title: title.trim(),
      client: client.trim() || null,
      status,
      needs_review: needsReview,
    };

    if (isTask) {
      data.owner = owner.trim() || null;
      data.deadline = fromLocalInputValue(deadline);
    } else {
      data.location = location.trim() || null;
      data.start_time = fromLocalInputValue(startTime);
      data.end_time = fromLocalInputValue(endTime);
      data.sync_status = syncStatus;
    }

    onSave(data);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="edit-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="modal-eyebrow">{isTask ? 'Task' : 'Event'}</span>
            <h2>{isTask ? '編輯任務' : '編輯行程'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="關閉">
            <X size={18} />
          </button>
        </div>

        <div className="edit-form">
          <label>
            <span>標題</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>

          <label>
            <span>客戶 / 專案</span>
            <input value={client} onChange={(event) => setClient(event.target.value)} />
          </label>

          {isTask ? (
            <>
              <label>
                <span>負責人</span>
                <input value={owner} onChange={(event) => setOwner(event.target.value)} />
              </label>
              <label>
                <span>期限</span>
                <input type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
              </label>
              <label>
                <span>狀態</span>
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="needs_review">待審核</option>
                  <option value="pending">待處理</option>
                  <option value="completed">已完成</option>
                  <option value="cancelled">已取消</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                <span>地點</span>
                <input value={location} onChange={(event) => setLocation(event.target.value)} />
              </label>
              <div className="form-grid">
                <label>
                  <span>開始時間</span>
                  <input type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
                </label>
                <label>
                  <span>結束時間</span>
                  <input type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
                </label>
              </div>
              <label>
                <span>同步狀態</span>
                <select value={syncStatus} onChange={(event) => setSyncStatus(event.target.value)}>
                  <option value="pending_review">待審核</option>
                  <option value="ready">待同步</option>
                  <option value="synced">已同步</option>
                  <option value="failed">失敗</option>
                </select>
              </label>
            </>
          )}

          <label className="checkbox-row">
            <input type="checkbox" checked={needsReview} onChange={(event) => setNeedsReview(event.target.checked)} />
            <span>需要人工審核</span>
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary-action" onClick={handleSave} disabled={saving || !title.trim()}>
            <Save size={15} />
            {saving ? '儲存中' : '儲存'}
          </button>
        </div>
      </section>
    </div>
  );
}

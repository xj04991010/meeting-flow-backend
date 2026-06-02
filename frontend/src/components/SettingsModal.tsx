import { useState } from 'react';
import { Calendar, CheckCircle2, Cpu, KeyRound, Save, X } from 'lucide-react';
import { getGoogleAuthUrl } from '../api';
import type { UserRow } from '../types';

export const TAIWAN_CITIES = [
  { name: '自動定位', lat: 25.0478, lon: 121.5319 },
  { name: '台北市', lat: 25.0478, lon: 121.5319 },
  { name: '新北市', lat: 25.0112, lon: 121.4617 },
  { name: '桃園市', lat: 24.9936, lon: 121.3010 },
  { name: '台中市', lat: 24.1477, lon: 120.6736 },
  { name: '台南市', lat: 22.9999, lon: 120.2269 },
  { name: '高雄市', lat: 22.6273, lon: 120.3014 },
  { name: '基隆市', lat: 25.1276, lon: 121.7392 },
  { name: '新竹市', lat: 24.8138, lon: 120.9675 },
  { name: '苗栗縣', lat: 24.5602, lon: 120.8214 },
  { name: '彰化縣', lat: 24.0518, lon: 120.5393 },
  { name: '南投縣', lat: 23.9037, lon: 120.6798 },
  { name: '雲林縣', lat: 23.7093, lon: 120.4313 },
  { name: '嘉義市', lat: 23.4801, lon: 120.4491 },
  { name: '屏東縣', lat: 22.6700, lon: 120.4851 },
  { name: '宜蘭縣', lat: 24.7303, lon: 121.7645 },
  { name: '花蓮縣', lat: 23.9872, lon: 121.6016 },
  { name: '台東縣', lat: 22.7583, lon: 121.1444 },
  { name: '澎湖縣', lat: 23.5711, lon: 119.5793 },
  { name: '金門縣', lat: 24.4327, lon: 118.3125 },
  { name: '連江縣', lat: 26.1505, lon: 119.9334 },
];

type AiSettings = {
  provider: string;
  model: string;
  apiKey: string;
};

type SettingsModalProps = {
  initialCity: string;
  initialAiSettings?: AiSettings;
  user?: UserRow | null;
  onSave: (city: string, aiSettings: AiSettings) => void;
  onClose: () => void;
};

export function SettingsModal({ initialCity, initialAiSettings, user, onSave, onClose }: SettingsModalProps) {
  const [city, setCity] = useState(initialCity || '自動定位');
  const [provider, setProvider] = useState(initialAiSettings?.provider || 'groq');
  const [model, setModel] = useState(initialAiSettings?.model || 'llama-3.3-70b-versatile');
  const [apiKey, setApiKey] = useState(initialAiSettings?.apiKey || '');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="edit-modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="modal-eyebrow">Preferences</span>
            <h2>系統設定</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="關閉">
            <X size={18} />
          </button>
        </div>

        <div className="edit-form">
          <label>
            <span>天氣城市</span>
            <select value={city} onChange={(event) => setCity(event.target.value)}>
              {TAIWAN_CITIES.map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
            <small>用於早報、天氣策略與戶外活動判斷。</small>
          </label>

          <div className="settings-section">
            <h3><Cpu size={16} /> AI 模型</h3>
            <label>
              <span>Provider</span>
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="groq">Groq</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label>
              <span>Model</span>
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="llama-3.3-70b-versatile 或 gpt-4o"
              />
            </label>
            <label>
              <span>API Key</span>
              <div className="input-with-icon">
                <KeyRound size={14} />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="僅儲存在目前瀏覽器"
                />
              </div>
              <small>此欄位目前只作為前端偏好。正式產品應改成後端加密保存或使用平台金鑰。</small>
            </label>
          </div>

          <div className="settings-section">
            <h3><Calendar size={16} /> Google Calendar</h3>
            {user?.is_calendar_authorized ? (
              <div className="calendar-status connected">
                <CheckCircle2 size={18} />
                <div>
                  <strong>已連接</strong>
                  <span>可將確認後的行程同步到 Google Calendar。</span>
                </div>
              </div>
            ) : (
              <div className="calendar-status disconnected">
                <Calendar size={18} />
                <div>
                  <strong>尚未連接</strong>
                  <span>連接後可執行行程同步。</span>
                </div>
                {user?.id && (
                  <a className="secondary-link" href={getGoogleAuthUrl(user.id)} target="_blank" rel="noreferrer">
                    連接 Google
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary-action" onClick={() => onSave(city, { provider, model, apiKey })}>
            <Save size={15} />
            儲存設定
          </button>
        </div>
      </section>
    </div>
  );
}

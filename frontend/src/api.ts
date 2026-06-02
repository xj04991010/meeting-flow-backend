/**
 * MeetingFlow API Hooks — 唯一的資料存取層
 * ============================================
 * ⛔ 禁止在元件中直接寫 fetch()
 * ⛔ 禁止新增 API 端點（除非後端先新增了對應的 route）
 * ⛔ 禁止直連 Supabase
 * ✅ 所有元件必須透過此檔案的函式存取後端
 */

import type { WeeklyDashboardResponse } from './types';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3000';

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  
  if (typeof window !== 'undefined' && (window as any).Telegram?.WebApp?.initData) {
    headers['Authorization'] = `tma ${(window as any).Telegram.WebApp.initData}`;
  } else {
    // Development fallback
    const devToken = localStorage.getItem('dev_auth_token') || localStorage.getItem('MF_USER_ID') || '6578915a-d33e-4eed-8d22-a3e334480f56';
    headers['Authorization'] = `tma ${devToken}`;
  }
  return headers;
}

// ─── 讀取 ─────────────────────────────────

/** 取得周曆視圖資料（含所有 tasks, events, batches） */
export async function fetchWeeklyDashboard(dateStr?: string): Promise<WeeklyDashboardResponse> {
  const url = new URL(`${BACKEND_URL}/api/dashboard/weekly`);
  if (dateStr) {
    url.searchParams.append('date', dateStr);
  }
  
  const res = await fetch(url.toString(), {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  return res.json();
}

/** 取得深度研究報告列表 */
export async function fetchDocuments(): Promise<{ documents: any[] }> {
  const res = await fetch(`${BACKEND_URL}/api/documents`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  return res.json();
}

// ─── 任務操作 ───────────────────────────────

/** 更新任務狀態（Kanban 用） */
export async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ status }),
  });
}

/** 編輯任務（title, client, owner, deadline, status, needs_review） */
export async function updateTask(taskId: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Task update failed: ${res.status}`);
}

// ─── 行程操作 ───────────────────────────────

/** 編輯行程（title, client, location, start_time, end_time, status, sync_status, needs_review） */
export async function updateCalendarIntent(intentId: string, data: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/calendar-intents/${intentId}`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Event update failed: ${res.status}`);
}

export async function updateCalendarIntentStatus(id: string, status: string, sync_status: string) {
  const res = await fetch(`${BACKEND_URL}/api/calendar-intents/${id}/status`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify({ status, sync_status })
  });
  if (!res.ok) throw new Error('Failed to update event status');
}

export async function extractMeetingNotes(rawText: string) {
  const res = await fetch(`${BACKEND_URL}/api/extract`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ raw_text: rawText })
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Failed to extract meeting notes');
  }
  return res.json();
}

export async function getUserSettings() {
  const res = await fetch(`${BACKEND_URL}/api/user-settings`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error('Failed to get user settings');
  return res.json();
}

export async function saveUserSettings(settings: any) {
  const res = await fetch(`${BACKEND_URL}/api/user-settings`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error('Failed to save user settings');
  return res.json();
}

/** 確認行程（將 status 設為 ready，needs_review 設為 false） */
export async function confirmCalendarIntent(intentId: string): Promise<void> {
  await updateCalendarIntent(intentId, { status: 'ready', needs_review: false });
}

// ─── Google Calendar 同步 ────────────────────

export async function checkGoogleAuthStatus(): Promise<{ hasAuth: boolean }> {
  const res = await fetch(`${BACKEND_URL}/api/auth/google/status`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error('Failed to check Google auth status');
  return res.json();
}

/** 同步單筆行程到 Google Calendar */
export async function syncEventToGoogle(eventId: string): Promise<{ success: boolean; error?: string; code?: string }> {
  const res = await fetch(`${BACKEND_URL}/api/calendar-intents/${eventId}/sync`, { 
    method: 'POST',
    headers: getAuthHeaders()
  });
  return res.json();
}

/** Google OAuth 授權 URL */
export function getGoogleAuthUrl(userId: string): string {
  // 由於這是外跳連結，我們可以直接帶 user_id，或者後端透過 session 處理。
  // 但因為 OAuth flow 需要 user_id state，所以這保留原樣。
  return `${BACKEND_URL}/auth/google?user_id=${userId}`;
}

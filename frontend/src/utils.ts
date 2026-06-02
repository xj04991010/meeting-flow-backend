import { STATUS_LABELS } from './types';

export function formatTimeOnly(value?: string | null): string {
  if (!value) return '未排程';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '未排程';
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateOnly(value?: string | null): string {
  if (!value) return '未排程';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '未排程';
  return d.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '未排程';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function toLocalInputValue(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function fromLocalInputValue(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function statusLabel(status?: string | null): string {
  return STATUS_LABELS[status || ''] || status || '未設定';
}

export function confidencePercent(value?: number | null): string {
  if (typeof value !== 'number') return '未評分';
  return `${Math.round(value * 100)}%`;
}

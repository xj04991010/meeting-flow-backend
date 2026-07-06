import { describe, it, expect, vi } from 'vitest';
import app from '../index';
// Mock the background services to avoid actually hitting DB or LLM during tests
vi.mock('../services/command-handlers/morning.handler', () => ({
  handleMorningCommand: vi.fn().mockResolvedValue(true)
}));
vi.mock('../services/proactive.service', () => ({
  scanMemoriesAndGenerateTasks: vi.fn().mockResolvedValue(1)
}));
vi.mock('../cron', () => ({
  startCronJobs: vi.fn()
}));
vi.mock('../services/cron-lock.service', () => ({
  acquireCronLock: vi.fn().mockResolvedValue(true)
}));
vi.mock('../services/cron-window.service', () => ({
  checkCronWindow: vi.fn().mockReturnValue({
    allowed: true,
    currentTime: '2026-06-10 09:00 Asia/Taipei',
    windowLabel: 'test'
  })
}));
vi.mock('../utils/db', () => {
  const result = { data: [], error: null };
  let query: any;
  query = {
    select: vi.fn(() => query),
    not: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return {
    supabase: {
      from: vi.fn(() => query),
    },
  };
});

describe('Cron Endpoints', () => {
  it('should reject morning cron without valid token', async () => {
    const res = await app.request('/api/cron/morning', {
      method: 'POST',
      headers: {
        'x-cron-token': 'wrong-token'
      }
    });
    expect(res.status).toBe(401);
  });

  it('should accept morning cron with valid token', async () => {
    const res = await app.request('/api/cron/morning', {
      method: 'POST',
      headers: {
        'x-cron-token': 'test-secret' // Set in setup.ts
      }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
  });

  it('should accept proactive cron with valid token', async () => {
    const res = await app.request('/api/cron/proactive', {
      method: 'POST',
      headers: {
        'x-cron-token': 'test-secret'
      }
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.message).toBe('Proactive scan completed');
  });
});

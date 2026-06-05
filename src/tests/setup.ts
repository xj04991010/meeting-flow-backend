import { beforeAll, vi } from 'vitest';

beforeAll(() => {
  process.env.CRON_SECRET = 'test-secret';
  // Mock console to keep test output clean
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

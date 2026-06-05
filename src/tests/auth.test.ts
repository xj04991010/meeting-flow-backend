import { describe, it, expect } from 'vitest';
import app from '../index';

describe('TMA Auth Middleware', () => {
  it('should block requests to /api/users without token', async () => {
    const res = await app.request('/api/users');
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.error).toBe('Unauthorized: Missing or invalid TMA token');
  });

  it('should allow requests to /api/cron/morning even without TMA token', async () => {
    // It should be allowed by TMA Auth, but blocked by Cron Auth (which returns 401 Unauthorized but a different message/logic)
    // Actually our cron returns 401 { error: 'Unauthorized' } when x-cron-token is missing.
    // Let's test that it DOES NOT return the TMA error.
    const res = await app.request('/api/cron/morning', {
      method: 'POST'
    });
    
    // We expect 401 because x-cron-token is missing, but not the TMA error!
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.error).toBe('Unauthorized'); 
    expect(data.error).not.toBe('Unauthorized: Missing or invalid TMA token');
  });
});

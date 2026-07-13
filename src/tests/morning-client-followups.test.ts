import { describe, expect, it } from 'vitest';
import { collectClientFollowups } from '../services/command-handlers/morning.handler';

describe('collectClientFollowups', () => {
  it('keeps linked dates within three days and red/yellow issues', () => {
    const result = collectClientFollowups([
      {
        client_name: '水果王',
        traffic_light: 'yellow',
        urgent_note: '拍攝時間未確認',
        date_links: [
          { label: '確認拍攝', date: '2026-07-16' },
          { label: '八月再確認', date: '2026-08-01' },
        ],
      },
      {
        client_name: '妮妮',
        traffic_light: 'green',
        date_links: [{ label: '拍攝', date: '2026-07-14' }],
      },
    ], '2026-07-13');

    expect(result).toEqual([
      { client: '妮妮', light: 'green', item: '拍攝', date: '2026-07-14', days: 1 },
      { client: '水果王', light: 'yellow', item: '確認拍攝', date: '2026-07-16', days: 3 },
      { client: '水果王', light: 'yellow', item: '拍攝時間未確認' },
    ]);
  });
});

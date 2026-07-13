import { describe, expect, it } from 'vitest';
import { collectClientDateLinksForMonth } from '../repositories/client-weekly-notes.repo';

describe('collectClientDateLinksForMonth', () => {
  it('returns only links in the requested month with their client names', () => {
    const links = collectClientDateLinksForMonth([
      {
        client_name: '水果王',
        date_links: [
          { id: 'a', label: '收款', date: '2026-07-21', field: 'progress' },
          { id: 'b', label: '拍片', date: '2026-08-02', field: 'nextPush' },
        ],
      },
    ], '2026-07');

    expect(links).toEqual([
      {
        id: 'a',
        label: '收款',
        date: '2026-07-21',
        field: 'progress',
        client_name: '水果王',
      },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildClientWeeklyNotePayload,
  type ClientWeeklyNoteData,
} from '../repositories/client-weekly-notes.repo';

describe('buildClientWeeklyNotePayload', () => {
  it('keeps only writable weekly-note fields', () => {
    const payload = buildClientWeeklyNotePayload('user-1', {
      id: 'old-row-id',
      user_id: 'another-user',
      created_at: '2026-01-01',
      client_name: ' 水果王 ',
      week_key: '2026-07-06',
      traffic_light: 'yellow',
      progress_note: '等待確認拍攝時間',
      raw_count: 3,
      date_links: [],
    } as unknown as ClientWeeklyNoteData);

    expect(payload).toEqual({
      user_id: 'user-1',
      client_name: '水果王',
      week_key: '2026-07-06',
      traffic_light: 'yellow',
      progress_note: '等待確認拍攝時間',
      raw_count: 3,
      date_links: [],
    });
  });

  it('rejects a missing client or week key', () => {
    expect(() => buildClientWeeklyNotePayload('user-1', {
      client_name: ' ',
      week_key: '2026-07-06',
    })).toThrow('client_name and week_key are required');
  });
});

import { describe, expect, it } from 'vitest';
import {
  getTaipeiDateKey,
  getTaipeiWeekKey,
  parseClientSecretaryCommand,
} from '../services/client-secretary.service';

describe('parseClientSecretaryCommand', () => {
  const clients = ['水果王', '水果王朱哥', '妮妮'];

  it('matches the longest client name before parsing an update', () => {
    expect(parseClientSecretaryCommand('水果王朱哥 下週 確認拍攝時間', clients)).toEqual({
      type: 'append_note',
      clientName: '水果王朱哥',
      field: 'next_week_note',
      text: '確認拍攝時間',
    });
  });

  it('parses a traffic light and keeps the reason', () => {
    expect(parseClientSecretaryCommand('水果王朱哥 改黃燈 拍攝時間未確認', clients)).toEqual({
      type: 'set_light',
      clientName: '水果王朱哥',
      light: 'yellow',
      reason: '拍攝時間未確認',
    });
  });

  it('parses summary and client creation commands', () => {
    expect(parseClientSecretaryCommand('/week', clients)).toEqual({
      type: 'summary',
      range: 'week',
    });
    expect(parseClientSecretaryCommand('新增客戶 包子', clients)).toEqual({
      type: 'create_client',
      clientName: '包子',
    });
  });

  it('uses an unmatched client message as a progress update', () => {
    expect(parseClientSecretaryCommand('妮妮 腳本已完成', clients)).toEqual({
      type: 'append_note',
      clientName: '妮妮',
      field: 'progress_note',
      text: '腳本已完成',
    });
  });
});

describe('Taipei date helpers', () => {
  it('returns the Taipei date and Monday week key', () => {
    const sundayInTaipei = new Date('2026-07-05T04:00:00.000Z');
    const mondayInTaipei = new Date('2026-07-05T16:30:00.000Z');

    expect(getTaipeiDateKey(sundayInTaipei)).toBe('2026-07-05');
    expect(getTaipeiWeekKey(sundayInTaipei)).toBe('2026-06-29');
    expect(getTaipeiDateKey(mondayInTaipei)).toBe('2026-07-06');
    expect(getTaipeiWeekKey(mondayInTaipei)).toBe('2026-07-06');
  });
});

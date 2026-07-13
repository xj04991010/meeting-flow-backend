import { describe, expect, it } from 'vitest';
import {
  getTaipeiDateKey,
  getTaipeiWeekKey,
  parseClientSecretaryCommand,
  parseSupplementNote,
  serializeSupplementNote,
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

  it('routes current status and shooting updates to their report sections', () => {
    expect(parseClientSecretaryCommand('水果王朱哥 目前狀態：可發至 7/9', clients)).toEqual({
      type: 'append_note',
      clientName: '水果王朱哥',
      field: 'current_status',
      text: '可發至 7/9',
    });
    expect(parseClientSecretaryCommand('水果王朱哥 待拍攝：美村店收店', clients)).toEqual({
      type: 'append_note',
      clientName: '水果王朱哥',
      field: 'shooting_note',
      text: '美村店收店',
    });
    expect(parseClientSecretaryCommand('水果王朱哥 待拍攝內容：\n1. 美村店收店\n2. 百香果投放片', clients)).toEqual({
      type: 'append_note',
      clientName: '水果王朱哥',
      field: 'shooting_note',
      text: '1. 美村店收店\n2. 百香果投放片',
    });
  });
});

describe('supplement note sections', () => {
  it('keeps shooting content separate from company decisions', () => {
    const stored = serializeSupplementNote('1. 美村店收店\n2. 百香果投放片', '拍攝日期待公司確認');
    expect(parseSupplementNote(stored)).toEqual({
      shootingNote: '1. 美村店收店\n2. 百香果投放片',
      companyHelp: '拍攝日期待公司確認',
    });
  });

  it('treats an unmarked legacy value as company help', () => {
    expect(parseSupplementNote('客戶回覆變慢')).toEqual({
      shootingNote: '',
      companyHelp: '客戶回覆變慢',
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

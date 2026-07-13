import { describe, expect, it } from 'vitest';
import { buildClientAssistantMessages } from '../services/client-assistant.service';

describe('client assistant prompt', () => {
  it('grounds the model in client status and linked dates', () => {
    const messages = buildClientAssistantMessages('這週先追誰？', '2026-07-13', {
      clients: [{ name: '水果王', status: 'active' }],
      notes: [{
        client_name: '水果王',
        traffic_light: 'yellow',
        urgent_note: '拍攝時間未確認',
        date_links: [{ label: '確認拍攝', date: '2026-07-16' }],
      }],
      tasks: [],
      events: [],
    });

    expect(messages[0].content).toContain('Never invent a date');
    expect(messages[0].content).toContain('read-only');
    expect(messages[1].content).toContain('水果王');
    expect(messages[1].content).toContain('2026-07-16');
    expect(messages[1].content).toContain('這週先追誰？');
  });
});

type CronWindow = {
  end: number;
  label: string;
  start: number;
};

const CRON_WINDOWS: Record<string, CronWindow> = {
  morning: { start: 8 * 60 + 45, end: 10 * 60 + 30, label: '08:45-10:30 Asia/Taipei' },
  nudging: { start: 14 * 60 + 45, end: 16 * 60 + 30, label: '14:45-16:30 Asia/Taipei' },
  evening: { start: 19 * 60 + 45, end: 21 * 60 + 30, label: '19:45-21:30 Asia/Taipei' },
  proactive: { start: 2 * 60 + 30, end: 4 * 60 + 30, label: '02:30-04:30 Asia/Taipei' }
};

function getTaipeiParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value || '00';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    minute: Number(value('minute'))
  };
}

export function checkCronWindow(jobType: string, date = new Date()) {
  const window = CRON_WINDOWS[jobType];
  if (!window) {
    return { allowed: true, currentTime: '', windowLabel: 'unrestricted' };
  }

  const taipei = getTaipeiParts(date);
  const currentMinutes = taipei.hour * 60 + taipei.minute;
  const allowed = currentMinutes >= window.start && currentMinutes <= window.end;

  return {
    allowed,
    currentTime: `${taipei.date} ${String(taipei.hour).padStart(2, '0')}:${String(taipei.minute).padStart(2, '0')} Asia/Taipei`,
    windowLabel: window.label
  };
}

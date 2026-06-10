import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock3,
  History,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  RefreshCcw,
  Settings,
} from 'lucide-react';
import './App.css';

import type { CalendarIntentRow, SourceBatchRow, TaskRow, UserRow, WeekBucket, JournalRow } from './types';
import {
  fetchWeeklyDashboard,
  fetchJournals,
  getGoogleAuthUrl,
  syncEventToGoogle,
  updateCalendarIntent,
  updateTask,
  updateTaskStatus,
  saveUserSettings,
} from './api';

import { BatchList } from './components/BatchList';
import { DayColumn } from './components/DayColumn';
import { EditModal } from './components/EditModal';
import { QuickInput } from './components/QuickInput';
import { ReviewPanel } from './components/ReviewPanel';
import { RoleBoard } from './components/RoleBoard';
import { JournalOverview } from './components/JournalOverview';
import { SettingsModal, TAIWAN_CITIES } from './components/SettingsModal';
import { WeeklyTasks } from './components/WeeklyTasks';
import { formatDateOnly, formatTimeOnly } from './utils';

const WEATHER_LABELS: Record<number, string> = {
  0: '晴',
  1: '晴時多雲',
  2: '多雲',
  3: '陰',
  45: '霧',
  48: '霧',
  51: '毛雨',
  53: '毛雨',
  55: '毛雨',
  56: '凍雨',
  57: '凍雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '凍雨',
  67: '凍雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '陣雨',
  81: '陣雨',
  82: '強陣雨',
  85: '陣雪',
  86: '強陣雪',
  95: '雷雨',
  96: '雷雨',
  99: '雷雨',
};

function getStorage() {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

type ViewMode = 'focus' | 'calendar' | 'board' | 'history';

function getTaipeiDateKey(value = new Date()) {
  return value.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function extractDateKey(value?: string | null) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return getTaipeiDateKey(parsed);
}

function isOpenTask(task: TaskRow) {
  return task.status !== 'completed' && task.status !== 'cancelled';
}

function isActiveEvent(event: CalendarIntentRow) {
  return event.status !== 'cancelled' && !event.needs_review && event.status !== 'needs_review';
}

type TodayFocusPanelProps = {
  tasks: TaskRow[];
  events: CalendarIntentRow[];
  overdueCount: number;
  onEditTask: (task: TaskRow) => void;
  onEditEvent: (event: CalendarIntentRow) => void;
  onToggleTaskComplete: (taskId: string, currentStatus: string) => void;
};

function TodayFocusPanel({
  tasks,
  events,
  overdueCount,
  onEditTask,
  onEditEvent,
  onToggleTaskComplete,
}: TodayFocusPanelProps) {
  const total = tasks.length + events.length;

  return (
    <section className="panel today-focus-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <ListChecks size={18} />
          <h2>今日焦點</h2>
        </div>
        <span className={`badge ${overdueCount > 0 ? 'danger-badge' : ''}`}>
          {overdueCount > 0 ? `${overdueCount} 逾期` : total}
        </span>
      </div>

      <div className="focus-list">
        {events.map((event) => (
          <article key={event.id} className="focus-row event-focus" onClick={() => onEditEvent(event)}>
            <span className="focus-icon"><Clock3 size={15} /></span>
            <div className="focus-row-body">
              <strong>{event.title}</strong>
              <span>{formatTimeOnly(event.start_time)} · {event.client || event.location || '行程'}</span>
            </div>
          </article>
        ))}

        {tasks.map((task) => (
          <article key={task.id} className="focus-row task-focus" onClick={() => onEditTask(task)}>
            <button
              className={`check-btn ${task.status === 'completed' ? 'checked' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleTaskComplete(task.id, task.status || 'pending');
              }}
              title="切換完成狀態"
              aria-label="切換完成狀態"
            />
            <div className="focus-row-body">
              <strong>
                {task.priority === 'high' && <span className="priority-dot">高</span>}
                {task.title}
              </strong>
              <span>{formatDateOnly(task.deadline)} · {task.client || task.category || '未分類'}</span>
            </div>
          </article>
        ))}

        {total === 0 && <div className="empty-state">今天沒有已確認的任務或行程。</div>}
      </div>
    </section>
  );
}

function App() {
  const [user, setUser] = useState<UserRow | null>(null);
  const [weekView, setWeekView] = useState<WeekBucket[]>([]);
  const [showPastDays, setShowPastDays] = useState(false);
  const [unscheduledTasks, setUnscheduledTasks] = useState<TaskRow[]>([]);
  const [batches, setBatches] = useState<SourceBatchRow[]>([]);
  const [journals, setJournals] = useState<JournalRow[]>([]);
  const [allTasks, setAllTasks] = useState<TaskRow[]>([]);
  const [allEvents, setAllEvents] = useState<CalendarIntentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<{ type: 'task'; item: TaskRow } | { type: 'event'; item: CalendarIntentRow } | null>(null);
  const [saving, setSaving] = useState(false);
  const [weatherMap, setWeatherMap] = useState<Record<string, { label: string; max: number; min: number }>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [preferredCity, setPreferredCity] = useState(() => getStorage()?.getItem('preferredCity') || '自動定位');
  const [selectedDate, setSelectedDate] = useState('');
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewMode>('focus');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uid = params.get('uid');
    if (!uid) return;

    getStorage()?.setItem('MF_USER_ID', uid);
    window.history.replaceState({}, document.title, window.location.pathname);
  }, []);

  const fetchData = useCallback(async () => {
    setRefreshing(true);
    try {
      setDashboardError(null);
      const [payload, journalsData] = await Promise.all([
        fetchWeeklyDashboard(selectedDate),
        fetchJournals().catch(() => [])
      ]);
      setUser(payload.user || null);
      setWeekView(payload.week_view || []);
      setUnscheduledTasks(payload.unscheduled_tasks || []);
      setBatches(payload.batches || []);
      setAllTasks(payload.tasks || []);
      setAllEvents(payload.calendarIntents || []);
      setJournals(journalsData || []);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : '資料同步失敗');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedDate]);

  const fetchWeather = async (forceCity?: string) => {
    const targetCity = forceCity || preferredCity;
    const todayStr = new Date().toLocaleString('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const storage = getStorage();
    const cachedDate = storage?.getItem('weatherCacheDate');
    const cachedCity = storage?.getItem('weatherCacheCity');
    const cachedData = storage?.getItem('weatherCacheData');

    if (!forceCity && cachedDate === todayStr && cachedCity === targetCity && cachedData) {
      try {
        setWeatherMap(JSON.parse(cachedData));
        return;
      } catch (error) {
        console.error('Failed to parse cached weather', error);
      }
    }

    const getWeather = async (lat: number, lon: number) => {
      try {
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTaipei`);
        const data = await res.json();
        const nextWeatherMap: Record<string, { label: string; max: number; min: number }> = {};

        if (data.daily) {
          for (let i = 0; i < data.daily.time.length; i += 1) {
            nextWeatherMap[data.daily.time[i]] = {
              label: WEATHER_LABELS[data.daily.weathercode[i]] || '天氣',
              max: Math.round(data.daily.temperature_2m_max[i]),
              min: Math.round(data.daily.temperature_2m_min[i]),
            };
          }
        }

        setWeatherMap(nextWeatherMap);
        storage?.setItem('weatherCacheDate', todayStr);
        storage?.setItem('weatherCacheCity', targetCity);
        storage?.setItem('weatherCacheData', JSON.stringify(nextWeatherMap));
      } catch (error) {
        console.error('Failed to fetch weather', error);
      }
    };

    if (targetCity !== '自動定位') {
      const cityConfig = TAIWAN_CITIES.find((city) => city.name === targetCity);
      if (cityConfig) {
        await getWeather(cityConfig.lat, cityConfig.lon);
        return;
      }
    }

    if (!navigator.geolocation) {
      await getWeather(25.0478, 121.5319);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        void getWeather(position.coords.latitude, position.coords.longitude);
      },
      (error) => {
        console.log('Geolocation denied or failed, defaulting to Taipei.', error);
        void getWeather(25.0478, 121.5319);
      },
    );
  };

  useEffect(() => {
    void fetchData();
    void fetchWeather();
    const intervalId = window.setInterval(fetchData, 60_000);
    return () => window.clearInterval(intervalId);
  }, [fetchData]);

  const handleSaveSettings = (city: string, aiSettings: { provider: string; model: string; apiKey: string }) => {
    setPreferredCity(city);
    getStorage()?.setItem('preferredCity', city);
    setShowSettings(false);
    void fetchWeather(city);
    
    // Save AI settings to backend
    void saveUserSettings({
      weather_city: city,
      ai_provider: aiSettings.provider,
      ai_model: aiSettings.model,
      api_key: aiSettings.apiKey
    });
  };

  const handleUpdateTaskStatus = async (taskId: string, status: string) => {
    // Optimistic UI update for zero latency feel
    setAllTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
    setUnscheduledTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
    setWeekView(prev => prev.map(bucket => ({
      ...bucket,
      tasks: bucket.tasks.map(t => t.id === taskId ? { ...t, status } : t)
    })));

    try {
      await updateTaskStatus(taskId, status);
    } catch (e) {
      console.error('Failed to update task status:', e);
      // Revert if API failed
      fetchData();
    }
  };

  const handleToggleTaskComplete = (id: string, current: string) => {
    void handleUpdateTaskStatus(id, current === 'completed' ? 'pending' : 'completed');
  };

  const handleSyncEvent = async (eventId: string) => {
    try {
      const res = await syncEventToGoogle(eventId);
      if (!res.success && res.code === 'NOT_AUTHORIZED') {
        if (window.confirm('尚未連接 Google Calendar。現在前往授權？')) {
          window.location.href = getGoogleAuthUrl(user?.id || '');
        }
      } else {
        await fetchData();
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleConfirmTask = async (taskId: string) => {
    await updateTask(taskId, { status: 'pending', needs_review: false });
    await fetchData();
  };

  const handleConfirmEvent = async (eventId: string) => {
    await updateCalendarIntent(eventId, { status: 'ready', needs_review: false });
    await fetchData();
  };

  const closeEditor = () => {
    if (!saving) setEditing(null);
  };

  const saveEdit = async (data: Record<string, unknown>) => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      if (editing.type === 'task') {
        await updateTask(editing.item.id, data);
      } else {
        await updateCalendarIntent(editing.item.id, data);
      }
      await fetchData();
      setEditing(null);
    } catch (error) {
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDropTask = async (taskId: string, dateStr: string) => {
    await updateTask(taskId, { deadline: dateStr, status: 'pending', needs_review: false });
    await fetchData();
  };

  const handleUnscheduleTask = async (taskId: string) => {
    await updateTask(taskId, { deadline: null });
    await fetchData();
  };

  const handleUpdateTaskCategory = async (taskId: string, category: string) => {
    await updateTask(taskId, {
      category,
      deadline: null,
      status: 'pending',
      needs_review: false,
    });
    await fetchData();
  };

  const handleDropEvent = async (eventId: string, targetDateStr: string, originalStartStr: string) => {
    try {
      const [year, month, day] = targetDateStr.split('-').map(Number);
      const newStart = new Date(originalStartStr);
      newStart.setFullYear(year, month - 1, day);

      const updatePayload: Record<string, unknown> = {
        start_time: newStart.toISOString(),
        needs_review: false,
      };

      let oldEvent: CalendarIntentRow | null = null;
      for (const bucket of weekView) {
        const found = bucket.events.find((event) => event.id === eventId);
        if (found) {
          oldEvent = found;
          break;
        }
      }

      if (oldEvent?.end_time) {
        const newEnd = new Date(oldEvent.end_time);
        newEnd.setFullYear(year, month - 1, day);
        updatePayload.end_time = newEnd.toISOString();
      }

      await updateCalendarIntent(eventId, updatePayload);
      await fetchData();
    } catch (error) {
      console.error('Failed to move event date:', error);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!window.confirm('確定要移除此任務？')) return;
    try {
      await updateTaskStatus(taskId, 'cancelled');
      await fetchData();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const handleDeleteEvent = async (eventId: string) => {
    if (!window.confirm('確定要移除此行程？')) return;
    try {
      await updateCalendarIntent(eventId, { status: 'cancelled' });
      await fetchData();
    } catch (error) {
      console.error('Failed to delete event:', error);
    }
  };

  const reviewTasks = useMemo(() => allTasks.filter((task) => task.needs_review || task.status === 'needs_review'), [allTasks]);
  const reviewEvents = useMemo(() => allEvents.filter((event) => event.needs_review || event.status === 'needs_review'), [allEvents]);
  
  const activeTasks = useMemo(() => allTasks.filter((task) => !task.needs_review && task.status !== 'needs_review'), [allTasks]);
  const activeUnscheduledTasks = useMemo(() => unscheduledTasks.filter((task) => !task.needs_review && task.status !== 'needs_review'), [unscheduledTasks]);
  
  const activeWeekView = useMemo(() => weekView.map(bucket => ({
    ...bucket,
    tasks: bucket.tasks.filter((t: any) => !t.needs_review && t.status !== 'needs_review'),
    events: bucket.events.filter((e: any) => !e.needs_review && e.status !== 'needs_review')
  })), [weekView]);

  const activeTaskCount = useMemo(() => activeTasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled').length, [activeTasks]);
  const completedTaskCount = useMemo(() => activeTasks.filter((task) => task.status === 'completed').length, [activeTasks]);
  const activeEventCount = useMemo(() => allEvents.filter((event) => event.status !== 'cancelled' && !event.needs_review).length, [allEvents]);
  const syncedEventCount = useMemo(() => allEvents.filter((event) => event.sync_status === 'synced' && !event.needs_review).length, [allEvents]);
  const reviewCount = reviewTasks.length + reviewEvents.length;
  const todayKey = useMemo(() => getTaipeiDateKey(), []);
  const todayBucket = useMemo(
    () => activeWeekView.find((bucket) => bucket.is_today) || activeWeekView.find((bucket) => bucket.date === todayKey),
    [activeWeekView, todayKey],
  );
  const todayTasks = useMemo(
    () => (todayBucket?.tasks || []).filter(isOpenTask),
    [todayBucket],
  );
  const todayEvents = useMemo(
    () => (todayBucket?.events || []).filter(isActiveEvent),
    [todayBucket],
  );
  const overdueTasks = useMemo(
    () => activeTasks.filter((task) => isOpenTask(task) && extractDateKey(task.deadline) !== '' && extractDateKey(task.deadline) < todayKey),
    [activeTasks, todayKey],
  );
  const focusTasks = useMemo(() => {
    const seen = new Set<string>();
    return [...overdueTasks, ...todayTasks].filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    }).slice(0, 10);
  }, [overdueTasks, todayTasks]);

  const navItems = useMemo(() => [
    { id: 'focus' as const, label: '焦點', icon: ListChecks, count: reviewCount + overdueTasks.length + todayTasks.length + todayEvents.length },
    { id: 'calendar' as const, label: '週曆', icon: Calendar, count: activeEventCount },
    { id: 'board' as const, label: '看板', icon: KanbanSquare, count: activeUnscheduledTasks.length },
    { id: 'history' as const, label: '紀錄', icon: History, count: batches.length + journals.length },
  ], [activeEventCount, activeUnscheduledTasks.length, batches.length, journals.length, overdueTasks.length, reviewCount, todayEvents.length, todayTasks.length]);

  if (loading) {
    return (
      <div className="loading">
        <Activity className="spin" />
        <span>載入儀表板</span>
      </div>
    );
  }

  return (
    <div className="dashboard-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-mark">
            <LayoutDashboard size={22} />
          </div>
          <div>
            <h1>MeetingFlow</h1>
            <p>任務、行程與 AI 審核中心</p>
          </div>
        </div>

        <div className="header-actions">
          {selectedDate && (
            <button className="ghost subtle" onClick={() => setSelectedDate('')}>
              回到本週
            </button>
          )}
          <input
            type="date"
            className="date-selector-input"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            title="選擇週視圖日期"
          />
          {user?.is_calendar_authorized ? (
            <span className="connection-pill connected">
              <Calendar size={15} />
              Calendar 已連接
            </span>
          ) : (
            <button className="primary-action" onClick={() => { window.location.href = getGoogleAuthUrl(user?.id || ''); }}>
              <Calendar size={16} />
              連接 Calendar
            </button>
          )}
          <button className="icon-button" onClick={() => setShowSettings(true)} title="設定">
            <Settings size={19} />
          </button>
          <button className="icon-button" onClick={() => { void fetchData(); }} title="重新整理">
            <RefreshCcw size={19} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <section className="command-strip" aria-label="工作摘要">
        <button
          type="button"
          className={`metric-card command-card attention ${reviewCount > 0 ? 'is-hot' : ''}`}
          onClick={() => setActiveView('focus')}
        >
          <AlertTriangle size={18} />
          <div>
            <span>待審核</span>
            <strong>{reviewCount}</strong>
          </div>
        </button>
        <button type="button" className="metric-card command-card" onClick={() => setActiveView('focus')}>
          <CheckSquare size={18} />
          <div>
            <span>今日 / 逾期</span>
            <strong>{todayTasks.length} / {overdueTasks.length}</strong>
          </div>
        </button>
        <button type="button" className="metric-card command-card" onClick={() => setActiveView('board')}>
          <Inbox size={18} />
          <div>
            <span>未排程</span>
            <strong>{activeUnscheduledTasks.length}</strong>
          </div>
        </button>
        <button type="button" className="metric-card command-card success" onClick={() => setActiveView('history')}>
          <ClipboardList size={18} />
          <div>
            <span>完成 / 同步</span>
            <strong>{completedTaskCount} / {syncedEventCount}</strong>
          </div>
        </button>
      </section>

      {dashboardError && (
        <div className="system-notice inline" role="status">
          <AlertTriangle size={16} />
          <span>資料同步失敗：{dashboardError}</span>
        </div>
      )}

      <nav className="workspace-nav" aria-label="主要工作區">
        {navItems.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            className={`workspace-tab ${activeView === id ? 'active' : ''}`}
            onClick={() => setActiveView(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
            <strong>{count}</strong>
          </button>
        ))}
      </nav>

      <main className="workspace-shell">
        {activeView === 'focus' && (
          <div className="focus-layout">
            <div className="focus-main">
              <ReviewPanel
                tasks={reviewTasks}
                events={reviewEvents}
                onConfirmTask={handleConfirmTask}
                onConfirmEvent={handleConfirmEvent}
                onEditTask={(task) => setEditing({ type: 'task', item: task })}
                onEditEvent={(event) => setEditing({ type: 'event', item: event })}
                onDeleteTask={handleDeleteTask}
                onDeleteEvent={handleDeleteEvent}
              />
              <TodayFocusPanel
                tasks={focusTasks}
                events={todayEvents}
                overdueCount={overdueTasks.length}
                onEditTask={(task) => setEditing({ type: 'task', item: task })}
                onEditEvent={(event) => setEditing({ type: 'event', item: event })}
                onToggleTaskComplete={handleToggleTaskComplete}
              />
            </div>
            <aside className="focus-side">
              {user && <QuickInput onSuccess={fetchData} />}
              <section className="panel flow-health-panel">
                <div className="panel-title">
                  <div className="panel-title-main">
                    <MessageSquareText size={18} />
                    <h2>流程狀態</h2>
                  </div>
                </div>
                <div className="status-stack">
                  <div>
                    <span>本週任務</span>
                    <strong>{activeTaskCount}</strong>
                  </div>
                  <div>
                    <span>有效行程</span>
                    <strong>{activeEventCount}</strong>
                  </div>
                  <div>
                    <span>匯入批次</span>
                    <strong>{batches.length}</strong>
                  </div>
                </div>
              </section>
            </aside>
          </div>
        )}

        {activeView === 'calendar' && (
          <div className="calendar-workspace">
            <WeeklyTasks
              tasks={activeTasks}
              selectedDate={selectedDate}
              onEditTask={(task) => setEditing({ type: 'task', item: task })}
              onToggleTaskComplete={handleToggleTaskComplete}
              onUnscheduleTask={handleUnscheduleTask}
            />
            <section className="calendar-priority" aria-label="週曆主工作區">
              <div className="calendar-section-header">
                <div className="section-heading-row">
                  <div>
                    <span className="modal-eyebrow">Weekly Calendar</span>
                    <h2>週曆</h2>
                  </div>
                  <button
                    className={`icon-button compact ${showPastDays ? 'active' : 'subtle'}`}
                    onClick={() => setShowPastDays(!showPastDays)}
                    title={showPastDays ? '隱藏過去' : '展開過去兩天'}
                  >
                    <History size={16} />
                  </button>
                </div>
                <div className="calendar-inline-stats">
                  <span>待審核 {reviewCount}</span>
                  <span>任務 {activeTaskCount}</span>
                  <span>行程 {activeEventCount}</span>
                </div>
              </div>

              <div className="week-grid-container">
                {activeWeekView.length > 0 ? (
                  <div className="week-grid">
                    {activeWeekView.filter((day) => {
                      if (showPastDays) return true;
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      const parsed = new Date(day.date);
                      parsed.setHours(0, 0, 0, 0);
                      return !(!Number.isNaN(parsed.getTime()) && parsed < today);
                    }).map((day) => (
                      <DayColumn
                        key={`${day.date}-${day.label}`}
                        bucket={day}
                        onEditTask={(task) => setEditing({ type: 'task', item: task })}
                        onEditEvent={(event) => setEditing({ type: 'event', item: event })}
                        onToggleTaskComplete={handleToggleTaskComplete}
                        onSyncEvent={handleSyncEvent}
                        onDropTask={handleDropTask}
                        onDropEvent={handleDropEvent}
                        onDeleteTask={handleDeleteTask}
                        onDeleteEvent={handleDeleteEvent}
                        weather={weatherMap[day.date]}
                      />
                    ))}
                  </div>
                ) : (
                  <section className="empty-board">
                    <LayoutDashboard size={24} />
                    <h2>尚無週排程資料</h2>
                    <p>確認後端 `/api/dashboard/weekly` 已啟動，或從 Telegram / 快速整理匯入第一批任務。</p>
                  </section>
                )}
              </div>
            </section>
          </div>
        )}

        {activeView === 'board' && (
          <RoleBoard
            tasks={activeUnscheduledTasks}
            customCategories={user?.custom_categories}
            onEditTask={(task) => setEditing({ type: 'task', item: task })}
            onToggleTaskComplete={handleToggleTaskComplete}
            onDeleteTask={handleDeleteTask}
            onUnscheduleTask={handleUnscheduleTask}
            onUpdateTaskCategory={handleUpdateTaskCategory}
          />
        )}

        {activeView === 'history' && (
          <div className="history-workspace">
            <section className="summary-strip" aria-label="本週摘要">
              <div className="metric-card attention">
                <AlertTriangle size={18} />
                <div>
                  <span>待審核</span>
                  <strong>{reviewCount}</strong>
                </div>
              </div>
              <div className="metric-card">
                <CheckSquare size={18} />
                <div>
                  <span>未完成任務</span>
                  <strong>{activeTaskCount}</strong>
                </div>
              </div>
              <div className="metric-card">
                <Calendar size={18} />
                <div>
                  <span>有效行程</span>
                  <strong>{activeEventCount}</strong>
                </div>
              </div>
              <div className="metric-card success">
                <Activity size={18} />
                <div>
                  <span>完成 / 同步</span>
                  <strong>{completedTaskCount} / {syncedEventCount}</strong>
                </div>
              </div>
            </section>
            <BatchList batches={batches} />
            <JournalOverview journals={journals} />
          </div>
        )}
      </main>

      {editing && (
        <EditModal
          editing={editing}
          onSave={saveEdit}
          onClose={closeEditor}
          saving={saving}
        />
      )}

      {showSettings && (
        <SettingsModal
          initialCity={preferredCity}
          user={user}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;

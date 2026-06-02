export type UserRow = {
  id: string;
  telegram_chat_id?: number | null;
  is_calendar_authorized?: boolean;
  custom_categories?: string[] | null;
  created_at?: string;
};

export type TaskRow = {
  id: string;
  title: string;
  client?: string | null;
  owner?: string | null;
  category?: string | null;
  status?: string | null;
  deadline?: string | null;
  confidence?: number | null;
  needs_review?: boolean | null;
  source_quote?: string | null;
  priority?: 'high' | 'medium' | 'low' | null;
  created_at: string;
};

export type CalendarIntentRow = {
  id: string;
  title: string;
  client?: string | null;
  location?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  status?: string | null;
  confidence?: number | null;
  needs_review?: boolean | null;
  sync_status?: string | null;
  source_quote?: string | null;
  external_calendar_id?: string | null;
  synced_at?: string | null;
  created_at: string;
};

export type SourceBatchRow = {
  id: string;
  summary?: string | null;
  created_at: string;
  metadata?: {
    task_count?: number;
    event_count?: number;
    review_count?: number;
    unresolved_notes?: string[];
  } | null;
};

export type DocumentRow = {
  id: string;
  user_id?: string;
  title: string;
  content: string;
  status: 'processing' | 'completed' | 'failed';
  created_at: string;
};

export type WeekBucket = {
  date: string;
  label: string;
  is_today: boolean;
  tasks: TaskRow[];
  events: CalendarIntentRow[];
};

export type WeeklyDashboardResponse = {
  user: UserRow | null;
  week_view: WeekBucket[];
  unscheduled_tasks: TaskRow[];
  batches: SourceBatchRow[];
  tasks: TaskRow[];
  calendarIntents: CalendarIntentRow[];
};

export type DayColumnProps = {
  bucket: WeekBucket;
  onEditTask: (task: TaskRow) => void;
  onEditEvent: (event: CalendarIntentRow) => void;
  onToggleTaskComplete: (taskId: string, currentStatus: string) => void;
  onSyncEvent: (eventId: string) => void;
  onDropTask?: (taskId: string, date: string) => void;
  onDropEvent?: (eventId: string, targetDate: string, originalStartTime: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteEvent?: (eventId: string) => void;
  weather?: { label: string; max: number; min: number };
};

export type ReviewPanelProps = {
  tasks: TaskRow[];
  events: CalendarIntentRow[];
  onConfirmTask: (taskId: string) => void;
  onConfirmEvent: (eventId: string) => void;
  onEditTask: (task: TaskRow) => void;
  onEditEvent: (event: CalendarIntentRow) => void;
  onDeleteTask?: (taskId: string) => void;
  onDeleteEvent?: (eventId: string) => void;
};

export type BacklogPanelProps = {
  tasks: TaskRow[];
  onEditTask: (task: TaskRow) => void;
  onToggleTaskComplete: (taskId: string, currentStatus: string) => void;
  onDeleteTask?: (taskId: string) => void;
};

export type BatchListProps = {
  batches: SourceBatchRow[];
};

export type EditModalProps = {
  editing: { type: 'task'; item: TaskRow } | { type: 'event'; item: CalendarIntentRow };
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
  saving: boolean;
};

export const STATUS_LABELS: Record<string, string> = {
  pending: '待處理',
  needs_review: '待審核',
  ready: '待同步',
  completed: '已完成',
  cancelled: '已取消',
  synced: '已同步',
  failed: '失敗',
  ignored: '已忽略',
  pending_review: '待審核',
};

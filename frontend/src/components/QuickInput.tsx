import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { extractMeetingNotes } from '../api';

type QuickInputProps = {
  onSuccess: () => void;
};

export function QuickInput({ onSuccess }: QuickInputProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    try {
      await extractMeetingNotes(text);
      setText('');
      onSuccess();
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : '萃取失敗，請稍後重試。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel quick-input-panel">
      <div className="panel-title">
        <div className="panel-title-main">
          <Send size={18} />
          <h2>快速整理</h2>
        </div>
      </div>
      <div className="quick-input-body">
        <textarea
          placeholder="貼上會議紀錄、對話、任務碎片。系統會萃取任務與行程，先進待審核區。"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={loading}
        />
        <button className="primary-action full-width" onClick={handleSubmit} disabled={loading || !text.trim()}>
          {loading ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          {loading ? '分析中' : '送出分析'}
        </button>
      </div>
    </section>
  );
}

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X } from 'lucide-react';
import type { DocumentRow } from '../types';

type DocumentViewerProps = {
  document: DocumentRow | null;
  onClose: () => void;
};

export function DocumentViewer({ document, onClose }: DocumentViewerProps) {
  if (!document) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="edit-modal document-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="modal-eyebrow">Research</span>
            <h2>{document.title}</h2>
            <small>{new Date(document.created_at).toLocaleString('zh-TW')}</small>
          </div>
          <button className="icon-button" onClick={onClose} title="關閉">
            <X size={18} />
          </button>
        </div>

        <div className="document-content markdown-body">
          {document.status === 'processing' ? (
            <div className="empty-state spacious">
              <Loader2 className="spin" size={22} />
              <p>研究報告產生中。</p>
            </div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {document.content}
            </ReactMarkdown>
          )}
        </div>
      </section>
    </div>
  );
}

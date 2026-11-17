import { useState, useEffect } from 'react';
import { FileText, Download, ExternalLink, PenTool } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useClientPortal } from '../../../contexts/ClientPortalContext';
import { getPortalChangeRequests } from '../../../services/projectClientPortals';
import type { ProjectChangeRequest, ProjectChangeOrder } from '../../../types';
import { Portal } from '../../../components/shared/Portal';

interface DocumentItem {
  id: string;
  title: string;
  type: 'change_order' | 'attachment';
  status: string;
  date: string;
  url?: string;
  frozenHtml?: string | null;
  changeOrderObj?: ProjectChangeOrder;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  change_order: 'Change Order',
  attachment: 'Attachment',
};

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-hud-bg-mid text-hud-cream-mute',
  sent: 'bg-hud-gold/20 text-hud-gold',
  viewed: 'bg-hud-gold/20 text-hud-gold',
  signed: 'bg-hud-emerald/15 text-hud-emerald',
  declined: 'bg-hud-plum/15 text-hud-plum',
  voided: 'bg-hud-bg-mid text-hud-cream-mute',
};

export function ClientPortalDocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { portal } = useClientPortal();

  const [requests, setRequests] = useState<ProjectChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewDoc, setPreviewDoc] = useState<DocumentItem | null>(null);

  useEffect(() => {
    if (!portal) return;
    getPortalChangeRequests(portal.project_id)
      .then(setRequests)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [portal]);

  if (!portal) return null;

  const documents: DocumentItem[] = [];

  for (const req of requests) {
    if (req.change_orders) {
      for (const order of req.change_orders) {
        if (['sent', 'viewed', 'signed', 'declined'].includes(order.status)) {
          documents.push({
            id: order.id,
            title: order.title,
            type: 'change_order',
            status: order.status,
            date: order.sent_at ?? order.created_at,
            frozenHtml: order.frozen_html_snapshot,
            changeOrderObj: order,
          });
        }
      }
    }

    if (req.attachments?.length) {
      for (const att of req.attachments) {
        documents.push({
          id: `${req.id}-${att.name}`,
          title: att.name,
          type: 'attachment',
          status: 'available',
          date: req.created_at,
          url: att.url,
        });
      }
    }
  }

  documents.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-hud-cream-soft">Documents</h2>
        <p className="text-sm text-hud-cream-mute mt-0.5">All documents and files associated with your project</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" />
        </div>
      ) : documents.length === 0 ? (
        <div className="bg-hud-bg-elev rounded-2xl border border-hud-line text-center py-16">
          <FileText className="w-10 h-10 text-hud-cream-soft mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-white mb-1">No documents yet</h3>
          <p className="text-sm text-hud-cream-dim">Documents shared by the project team will appear here.</p>
        </div>
      ) : (
        <div className="bg-hud-bg-elev rounded-2xl border border-hud-line overflow-hidden">
          <div className="divide-y divide-hud-bg-elev">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-4 px-5 py-4 hover:bg-hud-bg-elev transition-colors group"
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-none ${
                  doc.type === 'change_order' ? 'bg-hud-rust/20' : 'bg-hud-bg-mid'
                }`}>
                  <FileText className={`w-5 h-5 ${doc.type === 'change_order' ? 'text-hud-rust' : 'text-hud-cream-mute'}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-hud-cream-soft truncate">{doc.title}</div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs text-hud-cream-dim">{DOC_TYPE_LABELS[doc.type] ?? doc.type}</span>
                    <span className="text-hud-cream-soft">&middot;</span>
                    <span className="text-xs text-hud-cream-dim">
                      {new Date(doc.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-none">
                  {doc.status !== 'available' && (
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[doc.status] ?? 'bg-hud-bg-mid text-hud-cream-mute'}`}>
                      {doc.status}
                    </span>
                  )}

                  <div className="flex items-center gap-1">
                    {doc.frozenHtml && (
                      <button
                        onClick={() => setPreviewDoc(doc)}
                        className="p-1.5 text-hud-cream-dim hover:text-hud-cream-mute hover:bg-hud-bg-mid rounded-lg transition-colors"
                        title="Preview"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </button>
                    )}
                    {doc.url && (
                      <a
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 text-hud-cream-dim hover:text-hud-cream-mute hover:bg-hud-bg-mid rounded-lg transition-colors"
                        title="Download"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                    {doc.type === 'change_order' && ['sent', 'viewed'].includes(doc.status) && (
                      <span className="flex items-center gap-1 text-xs text-hud-rust font-medium">
                        <PenTool className="w-3 h-3" />
                        Needs signature
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {previewDoc?.frozenHtml && (
        <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPreviewDoc(null)} />
          <div className="relative bg-hud-bg-elev border border-hud-line rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90dvh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-hud-cream">
              <h3 className="text-sm font-semibold text-hud-cream-soft">{previewDoc.title}</h3>
              <button
                onClick={() => setPreviewDoc(null)}
                className="text-hud-cream-dim hover:text-hud-cream-mute text-sm"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-hud-bg-elev">
              <iframe
                srcDoc={previewDoc.frozenHtml}
                className="w-full h-full min-h-[500px]"
                title={previewDoc.title}
                sandbox="allow-same-origin"
              />
            </div>
          </div>
        </div></Portal>
      )}
    </div>
  );
}

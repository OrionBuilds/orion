import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Loader2, Search, Inbox, Eye, ExternalLink, X } from 'lucide-react';
import { getFormById, getFormSubmissions } from '../../services/forms';
import type { Form, FormSubmission, FormField } from '../../types';
import { Portal } from '../../components/shared/Portal';

export function FormSubmissions() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form | null>(null);
  const [submissions, setSubmissions] = useState<FormSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<FormSubmission | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const f = await getFormById(id);
        if (cancelled) return;
        setForm(f);
        const { submissions: subs } = await getFormSubmissions(id, { limit: 200 });
        if (cancelled) return;
        setSubmissions(subs);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load submissions');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const fieldMap = useMemo(() => {
    const map: Record<string, FormField> = {};
    for (const f of form?.definition?.fields || []) map[f.id] = f;
    return map;
  }, [form]);

  const filtered = useMemo(() => {
    if (!search.trim()) return submissions;
    const s = search.trim().toLowerCase();
    return submissions.filter((sub) => {
      const c = sub.contact;
      if (c) {
        const name = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
        if (name.includes(s)) return true;
        if (c.email?.toLowerCase().includes(s)) return true;
        if (c.phone?.toLowerCase().includes(s)) return true;
      }
      return Object.values(sub.payload || {}).some((v) =>
        v !== null && v !== undefined && String(v).toLowerCase().includes(s)
      );
    });
  }, [submissions, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="w-6 h-6 animate-spin text-hud-cream-mute" />
      </div>
    );
  }

  if (error || !form) {
    return (
      <div className="p-6">
        <p className="text-sm text-hud-plum">{error || 'Form not found'}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <button onClick={() => navigate('/marketing/forms')} className="flex items-center gap-2 text-sm text-hud-cream-dim hover:text-hud-cream-soft mb-2">
            <ArrowLeft className="w-4 h-4" /> Back to Forms
          </button>
          <div className="flex items-center gap-2">
            <Inbox className="w-5 h-5 text-hud-cream-soft" />
            <h1 className="text-2xl font-semibold text-white">{form.name}</h1>
            <span className="text-sm text-hud-cream-mute">
              {filtered.length} submission{filtered.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <Link
          to={`/marketing/forms/${form.id}/edit`}
          className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-hud-cream-soft hover:bg-hud-bg-elev rounded-lg"
        >
          <ExternalLink className="w-4 h-4" /> Open builder
        </Link>
      </div>

      <div className="mb-4 relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-mute" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by contact name, email, or any submitted value..."
          className="w-full pl-9 pr-3 py-2 text-sm border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-hud-cream-dim">
            <Inbox className="w-10 h-10 mx-auto mb-3 text-hud-cream-soft" />
            <p className="text-sm">No submissions yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-hud-bg-card/50 border-b border-hud-bg-elev">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Contact</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Submitted</th>
                <th className="px-4 py-2 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Source</th>
                <th className="px-4 py-2 w-24" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((sub) => (
                <tr key={sub.id} className="border-b border-hud-bg-elev last:border-b-0 hover:bg-hud-bg-elev/50">
                  <td className="px-4 py-3 text-sm">
                    {sub.contact ? (
                      <Link to={`/contacts/${sub.contact.id}`} className="text-blue-600 hover:underline">
                        {sub.contact.first_name || sub.contact.last_name
                          ? `${sub.contact.first_name || ''} ${sub.contact.last_name || ''}`.trim()
                          : sub.contact.email || sub.contact.phone}
                      </Link>
                    ) : (
                      <span className="text-hud-cream-mute italic">No contact</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-hud-cream-dim">
                    {new Date(sub.submitted_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs text-hud-cream-dim">
                    {sub.attribution?.utm_source || sub.attribution?.referrer || 'direct'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelected(sub)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded"
                    >
                      <Eye className="w-3 h-3" /> View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {selected && (
        <SubmissionDrawer submission={selected} fieldMap={fieldMap} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function SubmissionDrawer({
  submission,
  fieldMap,
  onClose,
}: {
  submission: FormSubmission;
  fieldMap: Record<string, FormField>;
  onClose: () => void;
}) {
  const entries = Object.entries(submission.payload || {}).filter(
    ([key]) => !key.startsWith('_') && key !== 'data'
  );

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-end z-50">
      <div className="bg-hud-bg-card h-full w-full max-w-md overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-hud-bg-elev sticky top-0 bg-hud-bg-card">
          <h3 className="text-sm font-semibold text-white">Submission detail</h3>
          <button onClick={onClose} className="p-1 text-hud-cream-mute hover:text-hud-cream-soft rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">Submitted</span>
              <span className="text-white">{new Date(submission.submitted_at).toLocaleString()}</span>
            </div>
            {submission.contact && (
              <div className="flex justify-between">
                <span className="text-hud-cream-dim">Contact</span>
                <Link to={`/contacts/${submission.contact.id}`} className="text-blue-600 hover:underline">
                  {submission.contact.first_name || submission.contact.last_name
                    ? `${submission.contact.first_name || ''} ${submission.contact.last_name || ''}`.trim()
                    : submission.contact.email || submission.contact.phone}
                </Link>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">Status</span>
              <span className="text-white">{submission.processed_status}</span>
            </div>
          </div>

          <div className="border-t border-hud-bg-elev pt-4">
            <h4 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wider mb-3">Answers</h4>
            <div className="space-y-3">
              {entries.length === 0 ? (
                <p className="text-sm text-hud-cream-mute italic">No data submitted.</p>
              ) : (
                entries.map(([key, value]) => {
                  const field = fieldMap[key];
                  return (
                    <div key={key}>
                      <div className="text-xs font-medium text-hud-cream-dim">{field?.label || key}</div>
                      <div className="text-sm text-white break-words">
                        {formatValue(value)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {submission.attribution && Object.values(submission.attribution).some(Boolean) && (
            <div className="border-t border-hud-bg-elev pt-4">
              <h4 className="text-xs font-semibold text-hud-cream-dim uppercase tracking-wider mb-3">Attribution</h4>
              <div className="space-y-1 text-xs">
                {Object.entries(submission.attribution || {}).map(([k, v]) =>
                  v ? (
                    <div key={k} className="flex justify-between">
                      <span className="text-hud-cream-dim">{k}</span>
                      <span className="text-white truncate ml-2 max-w-[60%]">{String(v)}</span>
                    </div>
                  ) : null
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

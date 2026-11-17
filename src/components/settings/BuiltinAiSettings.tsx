import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { updateOrganization } from '../../services/organizations';

/**
 * Org setting: the name the built-in AI answers to (Ask AI in Conversations, workflow AI steps,
 * AI reports). Default "Clara". Leave it empty to switch the persona off. This is identity only: it
 * gives the AI no extra access, and what it can see and do is unchanged.
 */
export function BuiltinAiSettings({ canManage }: { canManage: boolean }) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? user?.organization_id ?? null;
  const [saved, setSaved] = useState('Clara');
  const [name, setName] = useState('Clara');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    supabase.from('organizations').select('builtin_ai_name').eq('id', orgId).maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setMessage({ ok: false, text: error.message });
        else {
          const v = (data as { builtin_ai_name?: string | null } | null)?.builtin_ai_name;
          const current = v === null || v === undefined ? 'Clara' : v;
          setSaved(current);
          setName(current);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  const dirty = name.trim() !== saved;

  const save = async () => {
    if (!orgId || !user || !canManage || !dirty) return;
    const next = name.trim();
    setSaving(true);
    setMessage(null);
    try {
      await updateOrganization(orgId, { builtin_ai_name: next }, user);
      setSaved(next);
      setName(next);
      setMessage({ ok: true, text: next ? `The built-in AI is now ${next}.` : 'The built-in AI persona is off.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
      <div className="p-4 border-b border-hud-bg-card">
        <h3 className="text-lg font-semibold text-white flex items-center gap-2">
          <Bot className="w-5 h-5 text-hud-gold" />
          Built-in AI name
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          The assistant behind Ask AI, workflow AI steps and AI reports. It answers as this name,
          and its usage is listed under it. Leave the field empty to turn the persona off. It never
          gets more access than it has today.
        </p>
      </div>
      <div className="p-4 flex flex-wrap items-center gap-3">
        {loading ? (
          <span className="flex items-center gap-2 text-sm text-hud-cream-dim"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</span>
        ) : (
          <>
            <input
              value={name}
              maxLength={40}
              disabled={!canManage || saving}
              onChange={(e) => setName(e.target.value)}
              aria-label="Built-in AI name"
              placeholder="Clara"
              className="w-56 px-3 py-2 rounded-lg bg-hud-bg-card text-white text-sm border border-hud-bg-card focus:outline-none focus:border-hud-gold disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!canManage || saving || !dirty}
              onClick={() => void save()}
              className="px-3 py-2 rounded-lg bg-hud-gold text-black text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
            {saving && <Loader2 className="w-4 h-4 animate-spin text-hud-cream-dim" />}
            {!canManage && <span className="text-xs text-hud-cream-mute">Only admins can change this.</span>}
          </>
        )}
        {message && (
          <span className={`text-sm flex items-center gap-1.5 ml-auto ${message.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
            {message.ok && <CheckCircle2 className="w-4 h-4" />}{message.text}
          </span>
        )}
      </div>
    </div>
  );
}

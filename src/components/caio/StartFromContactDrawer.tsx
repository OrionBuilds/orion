/** Drawer: pick a contact, then start a CAIO engagement (creates the assessment project and opens the engagement). */
import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Search } from 'lucide-react';
import { SlideInDrawer } from '../ui/SlideInDrawer';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { getErrorMessage } from '../../lib/errors';
import { startFromContact, todayIso } from '../../services/caio';
import { ErrorBox } from './ui';
import { btnGhost, btnPrimary, inputCls, labelCls } from './styles';

interface PickedContact { id: string; first_name: string; last_name: string | null; email: string | null; company: string | null }

/** Strip characters that would break a PostgREST `or` filter. */
const safeTerm = (s: string) => s.replace(/[,()%*\\]/g, ' ').trim();

export function StartFromContactDrawer({ isOpen, onClose, onStarted }: { isOpen: boolean; onClose: () => void; onStarted: (engagementId: string) => void }) {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedContact[]>([]);
  const [searching, setSearching] = useState(false);
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [kickoff, setKickoff] = useState(todayIso());
  const [client, setClient] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setQuery(''); setResults([]); setContact(null); setKickoff(todayIso()); setClient(''); setSponsor(''); setOwner(''); setError(null);
  }, [isOpen]);

  // Debounced search over the org's active contacts.
  useEffect(() => {
    const term = safeTerm(query);
    if (contact || term.length < 2 || !user?.organization_id) { setResults([]); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase.from('contacts').select('id, first_name, last_name, email, company')
        .eq('organization_id', user.organization_id).eq('status', 'active')
        .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%`).limit(10);
      if (live) { setResults((data ?? []) as PickedContact[]); setSearching(false); }
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query, contact, user?.organization_id]);

  const pick = (c: PickedContact) => { setContact(c); setClient(c.company?.trim() ?? ''); setQuery(''); setResults([]); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!contact) return;
    setBusy(true);
    setError(null);
    try {
      const id = await startFromContact(contact.id, {
        kickoff, clientLegalName: client.trim() || undefined, executiveSponsor: sponsor.trim() || undefined, registerOwner: owner.trim() || undefined,
      });
      onStarted(id);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not start the engagement'));
      setBusy(false);
    }
  };

  const name = (c: PickedContact) => `${c.first_name} ${c.last_name ?? ''}`.trim();

  return (
    <SlideInDrawer isOpen={isOpen} onClose={onClose} title="Start CAIO engagement" subtitle="From a contact" width="md">
      <form onSubmit={submit} className="space-y-4 p-1">
        <div>
          <label htmlFor="caio-contact" className={labelCls}>Contact</label>
          {contact ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-hud-line-soft bg-hud-bg-card px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{name(contact)}</p>
                <p className="truncate text-xs text-hud-cream-dim">{[contact.company, contact.email].filter(Boolean).join(' · ') || 'No email'}</p>
              </div>
              <button type="button" onClick={() => setContact(null)} className="text-xs text-hud-gold-soft hover:text-hud-gold">Change</button>
            </div>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-hud-cream-mute" />
              <input id="caio-contact" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email or company" className={`${inputCls} pl-10`} autoComplete="off" />
              {(searching || results.length > 0 || safeTerm(query).length >= 2) && (
                <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-hud-bg-elev bg-hud-bg-card">
                  {searching ? <p className="p-3 text-sm text-hud-cream-dim">Searching...</p>
                    : results.length === 0 ? <p className="p-3 text-sm text-hud-cream-dim">No matching contacts.</p>
                    : results.map((c) => (
                      <button key={c.id} type="button" onClick={() => pick(c)} className="w-full p-3 text-left hover:bg-hud-bg-elev">
                        <p className="text-sm font-medium text-white">{name(c)}</p>
                        <p className="text-xs text-hud-cream-dim">{[c.company, c.email].filter(Boolean).join(' · ') || 'No email'}</p>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sfc-kickoff" className={labelCls}>Kickoff date</label>
            <input id="sfc-kickoff" type="date" required value={kickoff} onChange={(e) => setKickoff(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="sfc-client" className={labelCls}>Client legal name</label>
            <input id="sfc-client" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Defaults to the contact" className={inputCls} />
          </div>
          <div>
            <label htmlFor="sfc-sponsor" className={labelCls}>Executive sponsor</label>
            <input id="sfc-sponsor" value={sponsor} onChange={(e) => setSponsor(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="sfc-owner" className={labelCls}>Register owner</label>
            <input id="sfc-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls} />
          </div>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !contact || !kickoff} className={btnPrimary}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Start engagement
          </button>
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        </div>
      </form>
    </SlideInDrawer>
  );
}

export default StartFromContactDrawer;

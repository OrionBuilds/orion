/**
 * Portal Access — who at the client company can see this project in the client
 * portal, managed from the project detail page.
 *
 * The primary contact appears automatically (mirrored from projects.contact_id
 * by trigger). Additional POCs added here get identical portal visibility: the
 * portal edge function authorizes every read against project_contacts. Each row
 * has its own "Send invite" that emails the branded portal-invite to that
 * person; sign-in is their own email + one-time code.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, Plus, Search, Trash2, UserPlus, Users } from 'lucide-react';
import {
  addProjectContact,
  createPortalContact,
  listProjectContacts,
  removeProjectContact,
  searchContactsForPortal,
  type ProjectContactMember,
} from '../../services/projectContacts';
import { sendPortalInvite } from '../../services/clientPortal';
import { getErrorMessage, logError } from '../../lib/errors';

const ROLE_LABEL: Record<string, string> = {
  primary: 'Primary',
  poc: 'POC',
  billing: 'Billing',
  technical: 'Technical',
};

export function ProjectPortalAccessCard({
  projectId,
  orgId,
  canManage,
  currentUserId,
}: {
  projectId: string;
  orgId: string;
  canManage: boolean;
  currentUserId: string;
}) {
  const [members, setMembers] = useState<ProjectContactMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProjectContactMember['contact'][]>([]);
  const [searching, setSearching] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [newFirst, setNewFirst] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // contact/member id currently acted on
  const [invited, setInvited] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      setMembers(await listProjectContacts(projectId));
      setError(null);
    } catch (err) {
      logError('ProjectPortalAccessCard.reload', err);
      setError(getErrorMessage(err, 'Failed to load portal members'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!adding || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await searchContactsForPortal(query);
        const memberIds = new Set(members.map((m) => m.contact_id));
        setResults(found.filter((c) => c && !memberIds.has(c.id)));
      } catch (err) {
        logError('ProjectPortalAccessCard.search', err);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [adding, query, members]);

  async function grant(contactId: string) {
    setBusy(contactId);
    try {
      await addProjectContact({ orgId, projectId, contactId, addedByUserId: currentUserId });
      setQuery('');
      setAdding(false);
      setShowCreate(false);
      await reload();
    } catch (err) {
      logError('ProjectPortalAccessCard.grant', err);
      setError(getErrorMessage(err, 'Failed to add portal member'));
    } finally {
      setBusy(null);
    }
  }

  async function createAndGrant() {
    if (!newFirst.trim() || !newEmail.trim()) return;
    setBusy('create');
    try {
      const contactId = await createPortalContact({
        orgId,
        firstName: newFirst.trim(),
        lastName: newLast.trim(),
        email: newEmail.trim(),
        ownerUserId: currentUserId,
      });
      await addProjectContact({ orgId, projectId, contactId, addedByUserId: currentUserId });
      setNewFirst(''); setNewLast(''); setNewEmail('');
      setShowCreate(false);
      setAdding(false);
      await reload();
    } catch (err) {
      logError('ProjectPortalAccessCard.create', err);
      setError(getErrorMessage(err, 'Failed to create contact'));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(member: ProjectContactMember) {
    if (member.role === 'primary') return;
    setBusy(member.id);
    try {
      await removeProjectContact(member.id);
      await reload();
    } catch (err) {
      logError('ProjectPortalAccessCard.revoke', err);
      setError(getErrorMessage(err, 'Failed to remove portal member'));
    } finally {
      setBusy(null);
    }
  }

  async function invite(member: ProjectContactMember) {
    setBusy(`invite-${member.id}`);
    try {
      const res = await sendPortalInvite(projectId, member.contact_id);
      if (res.skippedReason) {
        setError(`Invite skipped: ${res.skippedReason}`);
      } else {
        setInvited((prev) => ({ ...prev, [member.id]: true }));
        setError(null);
      }
    } catch (err) {
      logError('ProjectPortalAccessCard.invite', err);
      setError(getErrorMessage(err, 'Failed to send invite'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-6 mb-6 bg-hud-bg-elev border border-hud-line rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-hud-gold" />
          <h3 className="text-sm font-semibold text-white">Portal Access</h3>
          <span className="text-xs text-hud-cream-dim">
            {members.length} {members.length === 1 ? 'person' : 'people'}
          </span>
        </div>
        {canManage && (
          <button
            onClick={() => { setAdding((v) => !v); setShowCreate(false); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-hud-bg-mid hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add person
          </button>
        )}
      </div>

      {error && <p className="text-xs text-hud-plum mb-3">{error}</p>}

      {adding && (
        <div className="mb-4 p-3 bg-hud-bg-mid rounded-lg border border-hud-line">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-hud-cream-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts by name or email…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-hud-bg-elev border border-hud-line rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold"
              autoFocus
            />
          </div>
          {searching && <p className="text-xs text-hud-cream-dim mt-2">Searching…</p>}
          {results.length > 0 && (
            <div className="mt-2 space-y-1">
              {results.map((c) => c && (
                <button
                  key={c.id}
                  onClick={() => grant(c.id)}
                  disabled={busy === c.id}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 text-sm text-left rounded-lg hover:bg-hud-bg-elev text-hud-cream-soft"
                >
                  <span>
                    {c.first_name} {c.last_name}
                    <span className="text-hud-cream-dim ml-2 text-xs">{c.email ?? 'no email'}</span>
                  </span>
                  {busy === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5 text-hud-gold" />}
                </button>
              ))}
            </div>
          )}
          {query.trim().length >= 2 && !searching && results.length === 0 && !showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-2 text-xs text-hud-gold-soft hover:underline"
            >
              No match — create a new contact
            </button>
          )}
          {showCreate && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <input value={newFirst} onChange={(e) => setNewFirst(e.target.value)} placeholder="First name"
                className="px-2.5 py-1.5 text-sm bg-hud-bg-elev border border-hud-line rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold" />
              <input value={newLast} onChange={(e) => setNewLast(e.target.value)} placeholder="Last name"
                className="px-2.5 py-1.5 text-sm bg-hud-bg-elev border border-hud-line rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold" />
              <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" type="email"
                className="col-span-2 px-2.5 py-1.5 text-sm bg-hud-bg-elev border border-hud-line rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold" />
              <button
                onClick={createAndGrant}
                disabled={busy === 'create' || !newFirst.trim() || !newEmail.trim()}
                className="col-span-2 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep rounded-lg disabled:opacity-50"
              >
                {busy === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                Create &amp; grant access
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-hud-gold" /></div>
      ) : members.length === 0 ? (
        <p className="text-sm text-hud-cream-dim">No portal members yet.</p>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between px-3 py-2 bg-hud-bg-mid rounded-lg">
              <div className="min-w-0">
                <span className="text-sm text-white">
                  {m.contact ? `${m.contact.first_name ?? ''} ${m.contact.last_name ?? ''}`.trim() || '—' : '—'}
                </span>
                <span className={`ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${m.role === 'primary' ? 'bg-hud-gold/20 text-hud-gold' : 'bg-hud-cream-mute/20 text-hud-cream-dim'}`}>
                  {ROLE_LABEL[m.role] ?? m.role}
                </span>
                <div className="text-xs text-hud-cream-dim truncate">{m.contact?.email ?? 'no email — cannot sign in'}</div>
              </div>
              {canManage && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => invite(m)}
                    disabled={busy === `invite-${m.id}` || !m.contact?.email}
                    title={m.contact?.email ? 'Email this person their portal invite' : 'Contact has no email'}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-hud-bg-elev hover:bg-hud-cream-mute text-hud-cream-soft hover:text-white rounded-lg disabled:opacity-40"
                  >
                    {busy === `invite-${m.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                    {invited[m.id] ? 'Sent!' : 'Invite'}
                  </button>
                  {m.role !== 'primary' && (
                    <button
                      onClick={() => revoke(m)}
                      disabled={busy === m.id}
                      title="Revoke portal access"
                      className="p-1.5 text-hud-cream-dim hover:text-hud-plum rounded-lg hover:bg-hud-bg-elev"
                    >
                      {busy === m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

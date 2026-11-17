import { useEffect, useState } from 'react';
import { Users, Search, Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getContacts } from '../../services/contacts';
import { updateProject } from '../../services/projects';
import { InlineCreateContactForm } from '../shared/InlineCreateContactForm';
import type { Contact, Project } from '../../types';

interface Props {
  project: Project;
  onLinked: (project: Project) => void;
}

// Shown on a project that has no client contact yet (e.g. created from a GitHub repo):
// pick an existing contact or create one, and the project is linked to it.
export function ProjectContactCard({ project, onLinked }: Props) {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getContacts(user.organization_id).then(setContacts).catch(() => setContacts([]));
  }, [user]);

  async function link(contactId: string) {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      onLinked(await updateProject(project.id, { contact_id: contactId } as Partial<Project>, user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link the contact');
    } finally {
      setSaving(false);
    }
  }

  const needle = search.trim().toLowerCase();
  const matches = (needle
    ? contacts.filter(
        (c) =>
          `${c.first_name} ${c.last_name}`.trim().toLowerCase().includes(needle) ||
          c.email?.toLowerCase().includes(needle),
      )
    : contacts
  ).slice(0, 8);

  return (
    <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <Users className="w-3.5 h-3.5 text-hud-cream-dim" />
        <span className="text-xs text-hud-cream-mute uppercase tracking-wide">Contact</span>
      </div>
      {creating && user ? (
        <InlineCreateContactForm
          orgId={user.organization_id}
          currentUser={user}
          initialFirstName={search}
          onCreated={(contact) => { setContacts((prev) => [contact, ...prev]); setCreating(false); void link(contact.id); }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <>
          <p className="text-xs text-hud-cream-dim mb-2">No client linked yet.</p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hud-cream-dim" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-hud-bg-mid border border-hud-cream-mute rounded-lg pl-7 pr-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-hud-gold"
                placeholder="Search contacts..."
              />
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1 px-2 py-1.5 bg-hud-bg-mid border border-hud-cream-mute rounded-lg text-hud-gold-soft hover:bg-hud-bg-elev text-xs whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
          </div>
          {matches.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-hud-bg-elev/50">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void link(c.id)}
                    className="w-full text-left px-2 py-1.5 hover:bg-hud-bg-elev disabled:opacity-50"
                  >
                    <p className="text-xs text-white">{`${c.first_name} ${c.last_name}`.trim() || c.email}</p>
                    {c.email && <p className="text-[11px] text-hud-cream-dim truncate">{c.email}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </>
      )}
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { X, Loader2, Search, User as UserIcon, FolderKanban, Home } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getContacts, getContactById } from '../../services/contacts';
import { getProjects } from '../../services/projects';
import { getUsers } from '../../services/users';
import {
  createUnifiedTask,
  getPersonalCalendarId,
  type UnifiedTaskParentType,
  type UnifiedTask,
} from '../../services/tasksHub';
import type { Contact, Project, TaskOriginType, User } from '../../types';
import { reportBackgroundError } from '../../lib/errors';
import { Portal } from '../shared/Portal';

interface CreateTaskModalProps {
  /** Org member list for the assignee picker. If omitted, fetched internally. */
  users?: User[];
  /**
   * Prefill from a "Create task" action elsewhere in the app. originType/originId
   * are only set (and only ever `team_message`|`conversation_message`, the DB
   * CHECK constraint's full set) for the message hover-action; other callers
   * (e.g. the /meetings action-item and call "Create task" buttons) prefill
   * title/description/contactId without stamping an origin.
   */
  prefill?: {
    title?: string;
    description?: string;
    originType?: TaskOriginType;
    originId?: string;
    contactId?: string | null;
  };
  onClose: () => void;
  onCreated: (task: UnifiedTask) => void;
}

const PARENT_OPTIONS: { value: UnifiedTaskParentType; label: string; icon: typeof UserIcon }[] = [
  { value: 'contact', label: 'Contact', icon: UserIcon },
  { value: 'project', label: 'Project', icon: FolderKanban },
  { value: 'personal', label: 'Personal', icon: Home },
];

export function CreateTaskModal({ users: usersProp, prefill, onClose, onCreated }: CreateTaskModalProps) {
  const { user: currentUser } = useAuth();
  const [loadedUsers, setLoadedUsers] = useState<User[]>([]);
  const users = usersProp ?? loadedUsers;
  const [parentType, setParentType] = useState<UnifiedTaskParentType>(prefill?.contactId ? 'contact' : 'personal');
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [description, setDescription] = useState(prefill?.description ?? '');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [assignedUserId, setAssignedUserId] = useState('');

  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);

  const [projectSearch, setProjectSearch] = useState('');
  const [projectResults, setProjectResults] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const orgId = currentUser?.organization_id;

  useEffect(() => {
    if (usersProp || !orgId) return;
    getUsers(orgId).then(setLoadedUsers).catch(reportBackgroundError('CreateTaskModal.getUsers'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Preload the prefilled contact (from a "Create task" hover action on a customer message).
  useEffect(() => {
    if (!prefill?.contactId) return;
    getContactById(prefill.contactId)
      .then((contact) => {
        if (contact) setSelectedContact(contact);
      })
      .catch(reportBackgroundError('CreateTaskModal.getContactById'));
  }, [prefill?.contactId]);

  useEffect(() => {
    if (!orgId || parentType !== 'contact' || !contactSearch.trim()) {
      setContactResults([]);
      return;
    }
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      getContacts(orgId, { search: contactSearch.trim() })
        .then((res) => setContactResults(res.slice(0, 8)))
        .catch(() => setContactResults([]));
    }, 250);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [contactSearch, parentType, orgId]);

  useEffect(() => {
    if (!orgId || parentType !== 'project' || !projectSearch.trim()) {
      setProjectResults([]);
      return;
    }
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      getProjects(orgId, { search: projectSearch.trim() }, 1, 8)
        .then((res) => setProjectResults(res.data))
        .catch(() => setProjectResults([]));
    }, 250);
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [projectSearch, parentType, orgId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentUser || !orgId || !title.trim()) return;

    if (parentType === 'contact' && !selectedContact) {
      setError('Pick a contact for this task');
      return;
    }
    if (parentType === 'project' && !selectedProject) {
      setError('Pick a project for this task');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      let calendarId: string | undefined;
      if (parentType === 'personal') {
        const personalCalendarId = await getPersonalCalendarId(orgId, currentUser.id);
        if (!personalCalendarId) {
          setError('No personal calendar found for your account -- ask an admin to create one.');
          setSaving(false);
          return;
        }
        calendarId = personalCalendarId;
      }

      const created = await createUnifiedTask(
        {
          parentType,
          title: title.trim(),
          description: description.trim() || null,
          dueDate: dueDate || null,
          priority,
          assignedUserId: assignedUserId || null,
          contactId: selectedContact?.id,
          orgId,
          projectId: selectedProject?.id,
          calendarId,
          originType: prefill?.originType ?? null,
          originId: prefill?.originId ?? null,
        },
        currentUser
      );
      onCreated(created);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-hud-bg-mid rounded-xl border border-hud-bg-elev shadow-2xl max-h-[90dvh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white">New Task</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-hud-bg-card transition-colors">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="mx-4 mt-4 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/30">
              <p className="text-sm text-hud-plum/40">{error}</p>
            </div>
          )}

          <div className="p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Parent</label>
              <div className="grid grid-cols-3 gap-2">
                {PARENT_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setParentType(opt.value)}
                      className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors ${
                        parentType === opt.value
                          ? 'bg-hud-gold/20 text-hud-gold-soft border-hud-gold/40'
                          : 'bg-hud-bg-card text-hud-cream-dim border-hud-bg-elev hover:bg-hud-bg-elev'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {parentType === 'contact' && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Contact</label>
                {selectedContact ? (
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev">
                    <span className="text-sm text-white">
                      {selectedContact.first_name} {selectedContact.last_name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedContact(null)}
                      className="text-xs text-hud-cream-dim hover:text-white"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="w-4 h-4 text-hud-cream-mute absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                    {contactResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-lg">
                        {contactResults.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setSelectedContact(c);
                              setContactSearch('');
                              setContactResults([]);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                          >
                            {c.first_name} {c.last_name}
                            {c.company && <span className="text-hud-cream-mute"> &middot; {c.company}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {parentType === 'project' && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Project</label>
                {selectedProject ? (
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev">
                    <span className="text-sm text-white">{selectedProject.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedProject(null)}
                      className="text-xs text-hud-cream-dim hover:text-white"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Search className="w-4 h-4 text-hud-cream-mute absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      placeholder="Search projects..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                    />
                    {projectResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-lg">
                        {projectResults.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedProject(p);
                              setProjectSearch('');
                              setProjectResults([]);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                autoFocus={!prefill?.title}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Add description..."
                className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim text-sm resize-none focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  {parentType === 'project' && <option value="urgent">Urgent</option>}
                </select>
              </div>
            </div>

            {parentType !== 'personal' && (
              <div>
                <label className="block text-sm font-medium text-hud-cream-soft mb-1">Assign To</label>
                <select
                  value={assignedUserId}
                  onChange={(e) => setAssignedUserId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {prefill?.originType && (
              <p className="text-xs text-hud-cream-mute italic">
                Created from a {prefill.originType === 'team_message' ? 'team message' : 'conversation message'} --
                the task will link back to it.
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 p-4 border-t border-hud-bg-card">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft text-sm hover:bg-hud-bg-elev transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-hud-gold-deep text-white text-sm font-medium hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div></Portal>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { BrandBadge } from '../../components/contacts/BrandBadge';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getContactById, deleteContact, archiveContact, restoreContact, updateContact } from '../../services/contacts';
import { BRANDS, isBrand, type Brand } from '../../lib/brands';
import { getContactNotes } from '../../services/contactNotes';
import { getContactTasks } from '../../services/contactTasks';
import { getAggregatedTimeline, type AggregatedTimelineEvent } from '../../services/contactTimeline';
import { getTags, addTagToContact, removeTagFromContact } from '../../services/tags';
import { getCustomFields, getContactCustomFieldValues } from '../../services/customFields';
import { getDepartments } from '../../services/departments';
import { getUsers } from '../../services/users';
import { getMeetingTranscriptionsByContact } from '../../services/meetingTranscriptions';
import { getProjectsForContact } from '../../services/projects';
import type { Contact, ContactNote, ContactTask, Tag, CustomField, ContactCustomFieldValue, Department, User, MeetingTranscription, Project } from '../../types';
import { ArrowLeft, Loader2, AlertCircle, Mail, Phone, Building2, MapPin, Calendar, User as UserIcon, CreditCard as Edit2, Trash2, Archive, RotateCcw, MoreVertical, Clock, Tag as TagIcon } from 'lucide-react';
import { ContactModal } from '../../components/contacts/ContactModal';
import { ContactOverviewTab } from '../../components/contacts/ContactOverviewTab';
import { ContactNotesTab } from '../../components/contacts/ContactNotesTab';
import { ContactTasksTab } from '../../components/contacts/ContactTasksTab';
import { ContactPaymentsTab } from '../../components/contacts/ContactPaymentsTab';
import ContactFilesTab from '../../components/contacts/ContactFilesTab';
import { ContactMeetingsTab } from '../../components/contacts/ContactMeetingsTab';
import { ContactProjectsTab } from '../../components/contacts/ContactProjectsTab';
import { ScoreWidget } from '../../components/scoring/ScoreWidget';
import { ClientPasswordPanel } from '../../components/contacts/ClientPasswordPanel';
import { ReferencesPanel } from '../../components/shared/ReferencesPanel';
import { VirtualizedTimeline } from '../../components/contacts/VirtualizedTimeline';
import { LeadScoreBadge } from '../../components/contacts/LeadScoreBadge';
import { getAttachmentCount } from '../../services/fileAttachments';
import { usePaymentsAccess } from '../../hooks/usePaymentsAccess';
import { reportBackgroundError } from '../../lib/errors';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';

type TabType = 'overview' | 'notes' | 'tasks' | 'timeline' | 'meetings' | 'projects' | 'payments' | 'files';
const CONTACT_TABS: TabType[] = ['overview', 'notes', 'tasks', 'timeline', 'meetings', 'projects', 'payments', 'files'];

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: currentUser, hasPermission, isSuperAdmin, isFeatureEnabled } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tasks, setTasks] = useState<ContactTask[]>([]);
  const [aggregatedTimeline, setAggregatedTimeline] = useState<AggregatedTimelineEvent[]>([]);
  const [meetings, setMeetings] = useState<MeetingTranscription[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<ContactCustomFieldValue[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<User[]>([]);

  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const t = searchParams.get('tab');
    return t && CONTACT_TABS.includes(t as TabType) ? (t as TabType) : 'overview';
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isTimelineLoading, setIsTimelineLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [filesCount, setFilesCount] = useState(0);
  const [isProjectsLoading, setIsProjectsLoading] = useState(false);
  const timelineAbortRef = useRef(false);

  const paymentsEnabled = isFeatureEnabled('payments');
  const mediaEnabled = isFeatureEnabled('media');
  const scoringEnabled = isFeatureEnabled('scoring_management');
  const conversationsEnabled = isFeatureEnabled('conversations');
  const calendarsEnabled = isFeatureEnabled('calendars');
  const opportunitiesEnabled = isFeatureEnabled('opportunities');
  const projectsEnabled = isFeatureEnabled('projects');

  const canEdit = hasPermission('contacts.edit');
  const [savingBrand, setSavingBrand] = useState(false);

  // Brand selector on the detail card: decides which sender this contact's email comes from.
  const handleBrandChange = async (value: string) => {
    if (!contact || !currentUser || !isBrand(value) || value === contact.brand) return;
    const previous = contact.brand;
    setSavingBrand(true);
    setContact({ ...contact, brand: value as Brand });
    try {
      await updateContact(contact.id, { brand: value as Brand }, currentUser);
      // updateContact logs an `updated` timeline event; show it without a reload.
      setAggregatedTimeline(await getAggregatedTimeline(contact.id));
    } catch (err) {
      console.error('Failed to update brand:', err);
      setContact((c) => (c ? { ...c, brand: previous } : c));
    } finally {
      setSavingBrand(false);
    }
  };
  const canViewPayments = hasPermission('payments.view');
  const canAccessPayments = usePaymentsAccess();
  const canViewMedia = hasPermission('media.view');
  const canViewProjects = projectsEnabled && hasPermission('projects.view');
  const canDelete = hasPermission('contacts.delete');
  const canAdjustScore = hasPermission('scoring.adjust');
  const canSendMessage = hasPermission('conversations.send');
  const canCreateOpportunity = hasPermission('opportunities.create');
  const canBookAppointment = hasPermission('appointments.create');
  const canCreateInvoice = hasPermission('invoices.create');
  const isAdmin = isSuperAdmin || currentUser?.role?.hierarchy_level === 2;

  const loadContact = useCallback(async () => {
    if (!id || !currentUser?.organization_id) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      timelineAbortRef.current = false;

      const [
        contactData,
        tagsData,
        customFieldsData,
        departmentsData,
        usersData,
        notesData,
        tasksData,
        fieldValues,
        attachmentCount,
        meetingsResult,
      ] = await Promise.all([
        getContactById(id),
        getTags(currentUser.organization_id),
        getCustomFields(currentUser.organization_id),
        getDepartments(currentUser.organization_id),
        getUsers(),
        getContactNotes(id),
        getContactTasks(id),
        getContactCustomFieldValues(id),
        mediaEnabled ? getAttachmentCount('contacts', id) : Promise.resolve(0),
        getMeetingTranscriptionsByContact(id).catch(() => [] as MeetingTranscription[]),
      ]);

      if (!contactData) {
        setError('Contact not found');
        return;
      }

      setContact(contactData);
      setTags(tagsData);
      setCustomFields(customFieldsData);
      setDepartments(departmentsData);
      setUsers(usersData);
      setNotes(notesData);
      setTasks(tasksData);
      setCustomFieldValues(fieldValues);
      setFilesCount(attachmentCount);
      setMeetings(meetingsResult);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to load contact');
    } finally {
      setIsLoading(false);
    }

    setIsTimelineLoading(true);
    getAggregatedTimeline(id)
      .then((timelineData) => {
        if (!timelineAbortRef.current) {
          setAggregatedTimeline(timelineData);
        }
      })
      .catch(reportBackgroundError('ContactDetail.getAggregatedTimeline'))
      .finally(() => {
        if (!timelineAbortRef.current) {
          setIsTimelineLoading(false);
        }
      });
  }, [id, currentUser?.organization_id, mediaEnabled]);

  useEffect(() => {
    loadContact();
    return () => {
      timelineAbortRef.current = true;
    };
  }, [loadContact]);

  useEffect(() => {
    if (!id || !canViewProjects) return;
    let cancelled = false;
    setIsProjectsLoading(true);
    getProjectsForContact(id)
      .then((data) => {
        if (!cancelled) setProjects(data);
      })
      .catch(reportBackgroundError('ContactDetail.getProjectsForContact'))
      .finally(() => {
        if (!cancelled) setIsProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, canViewProjects]);

  const handleDelete = async () => {
    if (!contact || !currentUser) return;

    if (!confirm('Are you sure you want to delete this contact? This action cannot be undone.')) {
      return;
    }

    try {
      await deleteContact(contact.id, currentUser);
      navigate('/contacts');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to delete contact');
    }
  };

  const handleArchive = async () => {
    if (!contact || !currentUser) return;

    try {
      await archiveContact(contact.id, currentUser);
      loadContact();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to archive contact');
    }
  };

  const handleRestore = async () => {
    if (!contact || !currentUser) return;

    try {
      await restoreContact(contact.id, currentUser);
      loadContact();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to restore contact');
    }
  };

  const handleAddTag = async (tagId: string) => {
    if (!contact || !currentUser) return;

    try {
      await addTagToContact(contact.id, tagId, currentUser);
      loadContact();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to add tag');
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    if (!contact || !currentUser) return;

    try {
      await removeTagFromContact(contact.id, tagId, currentUser);
      loadContact();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(message || 'Failed to remove tag');
    }
  };

  const refreshNotes = async () => {
    if (!id) return;
    const notesData = await getContactNotes(id);
    setNotes(notesData);
    const timelineData = await getAggregatedTimeline(id);
    setAggregatedTimeline(timelineData);
  };

  const refreshTasks = async () => {
    if (!id) return;
    const tasksData = await getContactTasks(id);
    setTasks(tasksData);
    const timelineData = await getAggregatedTimeline(id);
    setAggregatedTimeline(timelineData);
  };

  const refreshMeetings = async () => {
    if (!id) return;
    const meetingsData = await getMeetingTranscriptionsByContact(id);
    setMeetings(meetingsData);
  };

  const formatRelativeTime = (date: string | null): string => {
    if (!date) return 'Never';
    const now = new Date();
    const d = new Date(date);
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh]">
        <AlertCircle className="w-12 h-12 text-hud-plum mb-4" />
        <p className="text-white font-medium">{error || 'Contact not found'}</p>
        <button
          onClick={() => navigate('/contacts')}
          className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
        >
          Back to Contacts
        </button>
      </div>
    );
  }

  const tabs: { id: TabType; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'notes', label: 'Notes', count: notes.length },
    { id: 'tasks', label: 'Tasks', count: tasks.filter((t) => t.status !== 'completed').length },
    { id: 'timeline', label: 'Timeline', count: aggregatedTimeline.length },
    { id: 'meetings', label: 'Meetings', count: meetings.filter((m) => m.recording_url).length },
    ...(canViewProjects ? [{ id: 'projects' as const, label: 'Projects', count: projects.length }] : []),
    ...(paymentsEnabled && canViewPayments && canAccessPayments ? [{ id: 'payments' as const, label: 'Payments' }] : []),
    ...(mediaEnabled && canViewMedia ? [{ id: 'files' as const, label: 'Files', count: filesCount }] : []),
  ];

  const availableTags = tags.filter((tag) => !contact.tags?.some((t) => t.id === tag.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        <button
          onClick={() => navigate('/contacts')}
          className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-white">
              {contact.first_name} {contact.last_name}
            </h1>
            {contact.status === 'archived' && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-hud-rust/10 text-hud-rust">
                Archived
              </span>
            )}
            <LeadScoreBadge score={contact.lead_score || 0} size="md" />
            <BrandBadge brand={contact.brand} size="md" />
          </div>
          {contact.job_title && contact.company && (
            <p className="text-hud-cream-dim mt-1">
              {contact.job_title} at {contact.company}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && contact.status === 'active' && (
            <button
              onClick={() => setIsEditModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
            >
              <Edit2 className="w-4 h-4" />
              Edit
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
            >
              <MoreVertical className="w-5 h-5 text-hud-cream-dim" />
            </button>
            {showActions && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowActions(false)}
                />
                <AnchoredMenu className="w-48 bg-hud-bg-card rounded-lg border border-hud-bg-elev shadow-xl z-20">
                  {contact.status === 'active' ? (
                    <button
                      onClick={() => {
                        setShowActions(false);
                        handleArchive();
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                    >
                      <Archive className="w-4 h-4" />
                      Archive Contact
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setShowActions(false);
                        handleRestore();
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restore Contact
                    </button>
                  )}
                  {canDelete && isAdmin && (
                    <button
                      onClick={() => {
                        setShowActions(false);
                        handleDelete();
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-bg-elev transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete Contact
                    </button>
                  )}
                </AnchoredMenu>
              </>
            )}
          </div>
        </div>
      </div>

      {(contact.phone || contact.email) && (
        <div className="grid grid-cols-2 gap-2 sm:hidden" data-testid="contact-quick-actions">
          {contact.phone && (
            <a
              href={`tel:${contact.phone}`}
              className="flex items-center justify-center gap-2 rounded-xl bg-hud-emerald/15 border border-hud-emerald/30 py-3 text-sm font-medium text-hud-emerald touch-manipulation active:scale-[0.98]"
            >
              <Phone className="w-4 h-4" /> Call
            </a>
          )}
          {contact.email && (
            <a
              href={`mailto:${contact.email}`}
              className="flex items-center justify-center gap-2 rounded-xl bg-hud-gold/10 border border-hud-gold/30 py-3 text-sm font-medium text-hud-gold-soft touch-manipulation active:scale-[0.98]"
            >
              <Mail className="w-4 h-4" /> Email
            </a>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
            <div className="flex items-center justify-center mb-4">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center">
                <span className="text-2xl font-bold text-white">
                  {contact.first_name[0]}
                  {contact.last_name?.[0] || ''}
                </span>
              </div>
            </div>

            <div className="space-y-3">
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-hud-bg-card transition-colors group"
                >
                  <Mail className="w-4 h-4 text-hud-cream-mute group-hover:text-hud-gold-soft" />
                  <span className="text-sm text-hud-cream-soft group-hover:text-white">
                    {contact.email}
                  </span>
                </a>
              )}
              {contact.phone && (
                <a
                  href={`tel:${contact.phone}`}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-hud-bg-card transition-colors group"
                >
                  <Phone className="w-4 h-4 text-hud-cream-mute group-hover:text-hud-gold-soft" />
                  <span className="text-sm text-hud-cream-soft group-hover:text-white">
                    {contact.phone}
                  </span>
                </a>
              )}
              {contact.company && (
                <div className="flex items-center gap-3 p-2">
                  <Building2 className="w-4 h-4 text-hud-cream-mute" />
                  <span className="text-sm text-hud-cream-soft">{contact.company}</span>
                </div>
              )}
              {(contact.city || contact.state || contact.country) && (
                <div className="flex items-center gap-3 p-2">
                  <MapPin className="w-4 h-4 text-hud-cream-mute" />
                  <span className="text-sm text-hud-cream-soft">
                    {[contact.city, contact.state, contact.country].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-3 p-2">
                <TagIcon className="w-4 h-4 text-hud-cream-mute flex-shrink-0" />
                <label htmlFor="contact-brand" className="text-sm text-hud-cream-soft whitespace-nowrap">
                  Client of
                </label>
                <select
                  id="contact-brand"
                  value={contact.brand}
                  onChange={(e) => void handleBrandChange(e.target.value)}
                  disabled={!canEdit || savingBrand}
                  title="Decides which sender this contact's emails come from"
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-sm text-white focus:outline-none focus:ring-2 focus:ring-hud-gold disabled:opacity-60"
                >
                  {BRANDS.map((b) => (
                    <option key={b.slug} value={b.slug}>{b.name}</option>
                  ))}
                </select>
              </div>
              {contact.owner && (
                <div className="flex items-center gap-3 p-2">
                  <UserIcon className="w-4 h-4 text-hud-cream-mute" />
                  <span className="text-sm text-hud-cream-soft">Owner: {contact.owner.name}</span>
                </div>
              )}
              <div className="flex items-center gap-3 p-2">
                <Clock className="w-4 h-4 text-hud-cream-mute" />
                <span className="text-sm text-hud-cream-soft">
                  Last activity: {formatRelativeTime(contact.last_activity_at)}
                </span>
              </div>
              <div className="flex items-center gap-3 p-2">
                <Calendar className="w-4 h-4 text-hud-cream-mute" />
                <span className="text-sm text-hud-cream-soft">
                  Added {new Date(contact.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>

          <ClientPasswordPanel
            contactId={contact.id}
            isAdmin={isSuperAdmin || currentUser?.role?.name === 'Admin'}
          />

          {scoringEnabled && (
            <ScoreWidget
              entityType="contact"
              entityId={contact.id}
              canAdjust={canAdjustScore}
            />
          )}

          {isFeatureEnabled('entity_mentions') && (
            <ReferencesPanel targetType="contact" targetId={contact.id} />
          )}
        </div>

        <div className="lg:col-span-2">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
            <div className="border-b border-hud-bg-card">
              <div className="flex gap-1 p-1 overflow-x-auto">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'bg-hud-bg-card text-white'
                        : 'text-hud-cream-dim hover:text-white hover:bg-hud-bg-card/50'
                    }`}
                  >
                    {tab.label}
                    {tab.count !== undefined && tab.count > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-hud-bg-elev text-xs">
                        {tab.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4">
              {activeTab === 'overview' && (
                <ContactOverviewTab
                  contact={contact}
                  customFields={customFields}
                  customFieldValues={customFieldValues}
                  availableTags={availableTags}
                  canEdit={canEdit}
                  onAddTag={handleAddTag}
                  onRemoveTag={handleRemoveTag}
                />
              )}
              {activeTab === 'notes' && (
                <ContactNotesTab
                  contactId={contact.id}
                  notes={notes}
                  onRefresh={refreshNotes}
                />
              )}
              {activeTab === 'tasks' && (
                <ContactTasksTab
                  contactId={contact.id}
                  tasks={tasks}
                  users={users}
                  onRefresh={refreshTasks}
                />
              )}
              {activeTab === 'timeline' && (
                <VirtualizedTimeline
                  events={aggregatedTimeline}
                  isLoading={isTimelineLoading}
                />
              )}
              {activeTab === 'meetings' && (
                <ContactMeetingsTab
                  contact={contact}
                  meetings={meetings}
                  onRefresh={refreshMeetings}
                />
              )}
              {activeTab === 'projects' && (
                <ContactProjectsTab
                  contactId={contact.id}
                  projects={projects}
                  isLoading={isProjectsLoading}
                  onLinked={(linked) => setProjects((prev) => [linked, ...prev.filter((x) => x.id !== linked.id)])}
                />
              )}
              {activeTab === 'payments' && (
                <ContactPaymentsTab contactId={contact.id} />
              )}
              {activeTab === 'files' && (
                <ContactFilesTab contact={contact} onUpdate={loadContact} />
              )}
            </div>
          </div>
        </div>
      </div>

      {isEditModalOpen && (
        <ContactModal
          contact={contact}
          departments={departments}
          users={users}
          tags={tags}
          onClose={() => setIsEditModalOpen(false)}
          onSuccess={() => {
            setIsEditModalOpen(false);
            loadContact();
          }}
        />
      )}
    </div>
  );
}

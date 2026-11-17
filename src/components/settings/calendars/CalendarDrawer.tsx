import { useState, useEffect, useMemo } from 'react';
import {
  X,
  User as UserIcon,
  Users,
  Plus,
  Trash2,
  RefreshCw,
  LayoutGrid,
  ListOrdered,
  Check,
  ChevronLeft,
  ChevronRight,
  Search,
  Clock,
  Calendar as CalendarIconLucide,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  createCalendar,
  updateCalendar,
  generateSlug,
  addCalendarMember,
  updateCalendarMember,
  removeCalendarMember,
  deleteCalendar,
} from '../../../services/calendars';
import {
  createAppointmentType,
  updateAppointmentType,
  generateAppointmentTypeSlug,
  getDefaultQuestions,
} from '../../../services/appointmentTypes';
import { durationOptions, locationOptions } from './appointmentTypeOptions';
import { getErrorMessage } from '../../../lib/errors';
import type {
  Calendar,
  Department,
  User as UserType,
  CalendarMember,
  AssignmentMode,
  AppointmentType,
  LocationType,
} from '../../../types';
import { Portal } from '../../shared/Portal';

interface CalendarDrawerProps {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  calendar: Calendar | null;
  calendars: Calendar[];
  departments: Department[];
  users: UserType[];
}

type StepId = 'type' | 'basics' | 'team' | 'appointment-types';

interface StepDef {
  id: StepId;
  label: string;
  description: string;
}

const STEPS: StepDef[] = [
  { id: 'type', label: 'Type', description: 'How appointments are routed' },
  { id: 'basics', label: 'Basics', description: 'Name and booking URL' },
  { id: 'team', label: 'Team', description: 'Who takes the bookings' },
  {
    id: 'appointment-types',
    label: 'Appointment Type',
    description: 'What this calendar books',
  },
];

interface CalendarTypeOption {
  id: 'one_on_one' | 'round_robin' | 'collective' | 'priority';
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof UserIcon;
  type: 'user' | 'team';
  assignmentMode: AssignmentMode;
}

const TYPE_OPTIONS: CalendarTypeOption[] = [
  {
    id: 'one_on_one',
    label: 'One-on-One',
    shortLabel: 'One-on-One',
    description:
      'A single host owns the calendar. Every booking goes to them.',
    icon: UserIcon,
    type: 'user',
    assignmentMode: 'round_robin',
  },
  {
    id: 'round_robin',
    label: 'Round Robin',
    shortLabel: 'Round Robin',
    description:
      'Bookings rotate evenly across team members so workload stays balanced.',
    icon: RefreshCw,
    type: 'team',
    assignmentMode: 'round_robin',
  },
  {
    id: 'collective',
    label: 'Collective Booking',
    shortLabel: 'Collective',
    description:
      'Everyone on the team must be free. Useful for panel interviews and group consults.',
    icon: LayoutGrid,
    type: 'team',
    assignmentMode: 'collective',
  },
  {
    id: 'priority',
    label: 'Priority-Based',
    shortLabel: 'Priority',
    description:
      'Bookings go to the highest-priority member who is free. Set each member\'s priority below.',
    icon: ListOrdered,
    type: 'team',
    assignmentMode: 'priority',
  },
];

function deriveTypeId(
  type: 'user' | 'team',
  mode: AssignmentMode
): CalendarTypeOption['id'] {
  if (type === 'user') return 'one_on_one';
  if (mode === 'collective') return 'collective';
  if (mode === 'priority') return 'priority';
  return 'round_robin';
}

interface FormState {
  name: string;
  slug: string;
  typeId: CalendarTypeOption['id'];
  department_id: string;
  owner_user_id: string;
  description: string;
  // Self-service booking policy. Deadlines kept as strings for clean empty-input handling.
  allow_reschedule: boolean;
  allow_cancel: boolean;
  reschedule_deadline_hours: string;
  cancel_deadline_hours: string;
}

/** Appointment type drafted inline in the last step; created with the calendar on submit. */
interface NewTypeDraft {
  name: string;
  duration_minutes: number;
  location_type: LocationType;
}

/** selectedTypeId value that points at the inline draft instead of an existing type. */
const NEW_TYPE_ID = '__new__';

const EMPTY_NEW_TYPE: NewTypeDraft = { name: '', duration_minutes: 30, location_type: 'google_meet' };

const EMPTY_FORM: FormState = {
  name: '',
  slug: '',
  typeId: 'one_on_one',
  department_id: '',
  owner_user_id: '',
  description: '',
  allow_reschedule: true,
  allow_cancel: true,
  reschedule_deadline_hours: '',
  cancel_deadline_hours: '',
};

export function CalendarDrawer({
  open,
  onClose,
  onSave,
  calendar,
  calendars,
  departments,
  users,
}: CalendarDrawerProps) {
  const { user } = useAuth();
  const isEditing = !!calendar;

  const userRole = user?.role?.name;
  const canManageTeamCalendars =
    userRole === 'SuperAdmin' ||
    userRole === 'Admin' ||
    user?.permissions?.includes('calendars.manage_all');

  const [currentStep, setCurrentStep] = useState<StepId>('type');
  const [formData, setFormData] = useState<FormState>(EMPTY_FORM);
  const [members, setMembers] = useState<(CalendarMember & { isNew?: boolean })[]>(
    []
  );
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  const [typeSearch, setTypeSearch] = useState('');
  // Inline "+ New appointment type": the open mini-form and the confirmed draft.
  const [newTypeForm, setNewTypeForm] = useState<NewTypeDraft | null>(null);
  const [newTypeError, setNewTypeError] = useState('');
  const [newTypeDraft, setNewTypeDraft] = useState<NewTypeDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const initiallyLinkedTypeId = useMemo(() => {
    if (!calendar) return null;
    return calendar.appointment_types?.[0]?.id || null;
  }, [calendar]);

  useEffect(() => {
    if (!open) return;

    if (calendar) {
      const typeId = deriveTypeId(
        calendar.type,
        calendar.settings?.assignment_mode || 'round_robin'
      );
      setFormData({
        name: calendar.name,
        slug: calendar.slug,
        typeId,
        department_id: calendar.department_id || '',
        owner_user_id: calendar.owner_user_id || '',
        description: calendar.description || '',
        allow_reschedule: calendar.allow_reschedule ?? true,
        allow_cancel: calendar.allow_cancel ?? true,
        reschedule_deadline_hours:
          calendar.reschedule_deadline_hours != null ? String(calendar.reschedule_deadline_hours) : '',
        cancel_deadline_hours:
          calendar.cancel_deadline_hours != null ? String(calendar.cancel_deadline_hours) : '',
      });
      setMembers(calendar.members || []);
      setSelectedTypeId(initiallyLinkedTypeId);
      setCurrentStep('basics');
    } else {
      setFormData({
        ...EMPTY_FORM,
        owner_user_id: user?.id || '',
        typeId: canManageTeamCalendars ? 'one_on_one' : 'one_on_one',
      });
      setMembers([]);
      setSelectedTypeId(null);
      setCurrentStep('type');
    }
    setError('');
    setMemberSearch('');
    setTypeSearch('');
    setNewTypeForm(null);
    setNewTypeError('');
    setNewTypeDraft(null);
  }, [open, calendar, user, canManageTeamCalendars, initiallyLinkedTypeId]);

  const selectedType = TYPE_OPTIONS.find((t) => t.id === formData.typeId)!;
  const isCollective = selectedType.assignmentMode === 'collective';
  const isPriority = selectedType.assignmentMode === 'priority';
  const isTeamType = selectedType.type === 'team';

  const orgAppointmentTypes = useMemo(() => {
    const types: AppointmentType[] = [];
    for (const cal of calendars) {
      for (const t of cal.appointment_types || []) {
        types.push({ ...t, calendar: cal });
      }
    }
    return types.sort((a, b) => a.name.localeCompare(b.name));
  }, [calendars]);

  const filteredAppointmentTypes = useMemo(() => {
    const q = typeSearch.trim().toLowerCase();
    if (!q) return orgAppointmentTypes;
    return orgAppointmentTypes.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.calendar?.name.toLowerCase().includes(q)
    );
  }, [orgAppointmentTypes, typeSearch]);

  const availableUsers = useMemo(
    () =>
      users.filter(
        (u) => u.status === 'active' && !members.find((m) => m.user_id === u.id)
      ),
    [users, members]
  );

  const filteredAvailableUsers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return availableUsers;
    return availableUsers.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q)
    );
  }, [availableUsers, memberSearch]);

  const handleNameChange = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      name,
      slug: isEditing ? prev.slug : generateSlug(name),
    }));
  };

  const handleSelectType = (option: CalendarTypeOption) => {
    if (option.type === 'team' && !canManageTeamCalendars) return;
    setFormData((prev) => ({
      ...prev,
      typeId: option.id,
      owner_user_id: option.type === 'user' ? user?.id || '' : '',
    }));
  };

  const handleAddMember = (userId: string) => {
    if (!userId) return;
    if (members.find((m) => m.user_id === userId)) return;
    const selected = users.find((u) => u.id === userId);
    if (!selected) return;
    setMembers((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        calendar_id: calendar?.id || '',
        user_id: userId,
        weight: 1,
        priority: 5,
        active: true,
        created_at: new Date().toISOString(),
        user: selected,
        isNew: true,
      },
    ]);
    setMemberSearch('');
  };

  const handleUpdateMember = (
    memberId: string,
    updates: Partial<Pick<CalendarMember, 'weight' | 'priority' | 'active'>>
  ) => {
    setMembers((prev) =>
      prev.map((m) => (m.id === memberId ? { ...m, ...updates } : m))
    );
  };

  const handleRemoveMember = (memberId: string) => {
    setMembers((prev) => prev.filter((m) => m.id !== memberId));
  };

  const handleSelectAppointmentType = (typeId: string) => {
    setSelectedTypeId((prev) => (prev === typeId ? null : typeId));
  };

  const openNewTypeForm = () => {
    setNewTypeError('');
    setNewTypeForm({ ...(newTypeDraft ?? EMPTY_NEW_TYPE), name: newTypeDraft?.name ?? typeSearch.trim() });
  };

  // Same rules as the Appointment Type drawer: a name that yields a URL slug, a listed duration.
  const handleConfirmNewType = () => {
    if (!newTypeForm) return;
    const name = newTypeForm.name.trim();
    if (!name) {
      setNewTypeError('Name is required');
      return;
    }
    if (!generateAppointmentTypeSlug(name)) {
      setNewTypeError('Name needs at least one letter or number (it becomes the booking URL)');
      return;
    }
    setNewTypeDraft({ ...newTypeForm, name });
    setSelectedTypeId(NEW_TYPE_ID);
    setNewTypeForm(null);
    setNewTypeError('');
  };

  const validateStep = (step: StepId): string | null => {
    if (step === 'type') {
      if (selectedType.type === 'team' && !canManageTeamCalendars) {
        return 'You do not have permission to create team calendars';
      }
      return null;
    }
    if (step === 'basics') {
      if (!formData.name.trim()) return 'Calendar name is required';
      if (!formData.slug.trim()) return 'URL slug is required';
      if (!/^[a-z0-9-]+$/.test(formData.slug))
        return 'Slug can only contain lowercase letters, numbers, and dashes';
      return null;
    }
    if (step === 'team') {
      if (selectedType.type === 'user' && !formData.owner_user_id) {
        return 'Pick an owner for this calendar';
      }
      if (selectedType.type === 'team' && members.length === 0) {
        return 'Add at least one team member';
      }
      return null;
    }
    return null;
  };

  const goToStep = (step: StepId) => {
    setError('');
    setCurrentStep(step);
  };

  const handleNext = () => {
    const err = validateStep(currentStep);
    if (err) {
      setError(err);
      return;
    }
    setError('');
    const idx = STEPS.findIndex((s) => s.id === currentStep);
    if (idx < STEPS.length - 1) setCurrentStep(STEPS[idx + 1].id);
  };

  const handleBack = () => {
    setError('');
    const idx = STEPS.findIndex((s) => s.id === currentStep);
    if (idx > 0) setCurrentStep(STEPS[idx - 1].id);
  };

  const handleSubmit = async () => {
    if (!user) return;

    for (const step of STEPS) {
      const err = validateStep(step.id);
      if (err) {
        setError(err);
        setCurrentStep(step.id);
        return;
      }
    }

    setError('');
    setSaving(true);

    // A calendar created by this submit is removed again if its new appointment type fails.
    let createdCalendarId: string | null = null;
    try {
      let calendarId = calendar?.id;

      if (isEditing && calendar) {
        await updateCalendar(
          calendar.id,
          {
            name: formData.name,
            slug: formData.slug,
            department_id: formData.department_id || null,
            description: formData.description.trim() || null,
            settings: { assignment_mode: selectedType.assignmentMode },
            allow_reschedule: formData.allow_reschedule,
            allow_cancel: formData.allow_cancel,
            reschedule_deadline_hours: formData.reschedule_deadline_hours.trim()
              ? Math.max(0, parseInt(formData.reschedule_deadline_hours, 10) || 0)
              : null,
            cancel_deadline_hours: formData.cancel_deadline_hours.trim()
              ? Math.max(0, parseInt(formData.cancel_deadline_hours, 10) || 0)
              : null,
          },
          user
        );

        const originalMembers = calendar.members || [];
        for (const member of members) {
          if (member.isNew) {
            await addCalendarMember(calendar.id, member.user_id, {
              weight: member.weight,
              priority: member.priority,
            });
          } else {
            const original = originalMembers.find((m) => m.id === member.id);
            if (
              original &&
              (original.weight !== member.weight ||
                original.priority !== member.priority ||
                original.active !== member.active)
            ) {
              await updateCalendarMember(member.id, {
                weight: member.weight,
                priority: member.priority,
                active: member.active,
              });
            }
          }
        }

        for (const original of originalMembers) {
          if (!members.find((m) => m.id === original.id)) {
            await removeCalendarMember(original.id);
          }
        }
      } else {
        const newCalendar = await createCalendar(
          user.organization_id,
          {
            type: selectedType.type,
            name: formData.name,
            slug: formData.slug,
            department_id: formData.department_id || null,
            owner_user_id:
              selectedType.type === 'user' ? formData.owner_user_id : null,
            description: formData.description.trim() || null,
            settings: {
              assignment_mode: selectedType.assignmentMode,
            },
          },
          user
        );
        calendarId = newCalendar.id;
        createdCalendarId = newCalendar.id;

        if (selectedType.type === 'team') {
          for (const member of members) {
            await addCalendarMember(calendarId, member.user_id, {
              weight: member.weight,
              priority: member.priority,
            });
          }
        }
      }

      if (calendarId && selectedTypeId === NEW_TYPE_ID && newTypeDraft) {
        // Appointment types belong to a calendar, so the draft is created only now that the
        // calendar exists, with the same defaults as the Appointment Type drawer.
        await createAppointmentType(
          user.organization_id,
          {
            calendar_id: calendarId,
            name: newTypeDraft.name,
            slug: generateAppointmentTypeSlug(newTypeDraft.name),
            duration_minutes: newTypeDraft.duration_minutes,
            location_type: newTypeDraft.location_type,
            location_value: { phone_number: '', address: '', custom_link: '', instructions: '' },
            generate_google_meet: true,
            reminder_hours_before: [24],
            questions: getDefaultQuestions(),
          },
          user
        );
      } else if (calendarId && selectedTypeId && selectedTypeId !== initiallyLinkedTypeId) {
        await updateAppointmentType(
          selectedTypeId,
          { calendar_id: calendarId },
          user
        );
      }

      onSave();
    } catch (err) {
      if (createdCalendarId) {
        await deleteCalendar(createdCalendarId, user).catch((cleanupErr) =>
          console.error('Failed to remove the half-created calendar:', cleanupErr)
        );
      }
      setError(getErrorMessage(err, 'Failed to save calendar'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);
  const isFinalStep = stepIndex === STEPS.length - 1;

  const renderStepNav = () => (
    <div className="px-6 py-4 border-b border-hud-bg-elev bg-hud-bg-mid/50">
      <ol className="flex items-center gap-2">
        {STEPS.map((step, idx) => {
          const isActive = step.id === currentStep;
          const isComplete = idx < stepIndex;
          const isClickable =
            isEditing || isComplete || step.id === currentStep;
          return (
            <li key={step.id} className="flex items-center gap-2 flex-1">
              <button
                type="button"
                disabled={!isClickable}
                onClick={() => isClickable && goToStep(step.id)}
                className={`flex items-center gap-2 text-left transition-colors ${
                  isClickable ? 'cursor-pointer' : 'cursor-default'
                }`}
              >
                <span
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                    isActive
                      ? 'bg-hud-gold text-hud-bg-deep'
                      : isComplete
                      ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/40'
                      : 'bg-hud-bg-card text-hud-cream-mute border border-hud-bg-elev'
                  }`}
                >
                  {isComplete ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                </span>
                <span
                  className={`text-sm font-medium hidden sm:inline ${
                    isActive
                      ? 'text-white'
                      : isComplete
                      ? 'text-hud-cream-soft'
                      : 'text-hud-cream-mute'
                  }`}
                >
                  {step.label}
                </span>
              </button>
              {idx < STEPS.length - 1 && (
                <span
                  className={`flex-1 h-px ${
                    idx < stepIndex ? 'bg-hud-gold/40' : 'bg-hud-bg-elev'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );

  const renderTypeStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-white">
          What kind of calendar is this?
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          You can change settings later, but the routing type is fixed once
          appointments start coming in.
        </p>
      </div>

      <div className="grid gap-3">
        {TYPE_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = formData.typeId === option.id;
          const disabled = option.type === 'team' && !canManageTeamCalendars;
          const lockedInEdit = isEditing && !isSelected;

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => !disabled && !lockedInEdit && handleSelectType(option)}
              disabled={disabled || lockedInEdit}
              className={`p-4 rounded-xl border-2 transition-all flex items-start gap-4 text-left ${
                isSelected
                  ? 'border-hud-gold bg-hud-gold/10'
                  : 'border-hud-bg-elev bg-hud-bg-card hover:border-hud-cream-mute'
              } ${disabled || lockedInEdit ? 'opacity-50 cursor-not-allowed hover:border-hud-bg-elev' : ''}`}
            >
              <div
                className={`w-12 h-12 rounded-lg flex items-center justify-center shrink-0 ${
                  isSelected
                    ? 'bg-hud-gold/20'
                    : 'bg-hud-bg-elev/50'
                }`}
              >
                <Icon
                  className={`w-6 h-6 ${
                    isSelected ? 'text-hud-gold-soft' : 'text-hud-cream-dim'
                  }`}
                />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h4
                    className={`font-semibold ${
                      isSelected ? 'text-white' : 'text-hud-cream-soft'
                    }`}
                  >
                    {option.label}
                  </h4>
                  {isSelected && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-hud-gold">
                      <Check className="w-3 h-3 text-white" />
                    </span>
                  )}
                </div>
                <p className="text-sm text-hud-cream-dim mt-1">
                  {option.description}
                </p>
                {disabled && (
                  <p className="text-xs text-hud-rust mt-2">
                    Requires admin permissions
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {isEditing && (
        <p className="text-xs text-hud-cream-mute flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          Calendar type is locked once created. Create a new calendar to switch routing.
        </p>
      )}
    </div>
  );

  const renderBasicsStep = () => (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-white">
          Name your calendar
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          Clients see this on the booking page.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-2">
          Calendar Name
        </label>
        <input
          type="text"
          value={formData.name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder="e.g. Sales Discovery Call"
          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-2">
          Booking URL
        </label>
        <div className="flex items-stretch rounded-lg border border-hud-bg-elev bg-hud-bg-card overflow-hidden focus-within:ring-2 focus-within:ring-hud-gold">
          <span className="px-3 py-2 bg-hud-bg-card/50 border-r border-hud-bg-elev text-hud-cream-mute text-sm font-mono flex items-center">
            {typeof window !== 'undefined' ? window.location.host : 'app'}
            /book/
          </span>
          <input
            type="text"
            value={formData.slug}
            onChange={(e) =>
              setFormData({
                ...formData,
                slug: e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9-]/g, '-')
                  .replace(/-+/g, '-')
                  .replace(/^-|-$/g, ''),
              })
            }
            placeholder="my-calendar"
            className="flex-1 px-3 py-2 bg-transparent text-white focus:outline-none font-mono text-sm"
          />
        </div>
        <p className="text-xs text-hud-cream-mute mt-1.5">
          Lowercase letters, numbers and dashes only.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-2">
          Description <span className="text-hud-cream-mute font-normal">(optional)</span>
        </label>
        <textarea
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          rows={2}
          placeholder="A short note about what this calendar is for."
          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-2">
          Department <span className="text-hud-cream-mute font-normal">(optional)</span>
        </label>
        <select
          value={formData.department_id}
          onChange={(e) =>
            setFormData({ ...formData, department_id: e.target.value })
          }
          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
        >
          <option value="">No department</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>
              {dept.name}
            </option>
          ))}
        </select>
      </div>

      {isEditing && (
        <div className="border-t border-hud-bg-elev pt-5">
          <h3 className="text-sm font-medium text-white mb-1">Booking rules</h3>
          <p className="text-xs text-hud-cream-mute mb-4">
            Control whether guests can reschedule or cancel their own booking, and how close to the
            start time they're allowed to.
          </p>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <label className="text-sm text-hud-cream-dim">Allow guests to reschedule</label>
                <p className="text-xs text-hud-cream-mute">Turn off to require contacting you to move a booking.</p>
              </div>
              <button
                type="button"
                onClick={() => setFormData((p) => ({ ...p, allow_reschedule: !p.allow_reschedule }))}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${formData.allow_reschedule ? 'bg-hud-gold' : 'bg-hud-bg-elev'}`}
                role="switch"
                aria-checked={formData.allow_reschedule}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${formData.allow_reschedule ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            {formData.allow_reschedule && (
              <div className="pl-1">
                <label className="block text-xs text-hud-cream-dim mb-1">Reschedule cutoff</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={formData.reschedule_deadline_hours}
                    onChange={(e) => setFormData((p) => ({ ...p, reschedule_deadline_hours: e.target.value }))}
                    placeholder="No cutoff"
                    className="w-28 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">hours before start (blank = anytime)</span>
                </div>
              </div>
            )}

            <div className="flex items-start justify-between gap-4">
              <div>
                <label className="text-sm text-hud-cream-dim">Allow guests to cancel</label>
                <p className="text-xs text-hud-cream-mute">Turn off to require contacting you to cancel.</p>
              </div>
              <button
                type="button"
                onClick={() => setFormData((p) => ({ ...p, allow_cancel: !p.allow_cancel }))}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${formData.allow_cancel ? 'bg-hud-gold' : 'bg-hud-bg-elev'}`}
                role="switch"
                aria-checked={formData.allow_cancel}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${formData.allow_cancel ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            {formData.allow_cancel && (
              <div className="pl-1">
                <label className="block text-xs text-hud-cream-dim mb-1">Cancel cutoff</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={formData.cancel_deadline_hours}
                    onChange={(e) => setFormData((p) => ({ ...p, cancel_deadline_hours: e.target.value }))}
                    placeholder="No cutoff"
                    className="w-28 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  />
                  <span className="text-xs text-hud-cream-mute">hours before start (blank = anytime)</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const renderTeamStep = () => {
    if (!isTeamType) {
      return (
        <div className="space-y-5">
          <div>
            <h3 className="text-base font-semibold text-white">
              Who owns this calendar?
            </h3>
            <p className="text-sm text-hud-cream-dim mt-1">
              All bookings on this calendar will be assigned to this person.
            </p>
          </div>

          {isEditing ? (
            <div className="px-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-sm font-semibold text-white">
                {(users.find((u) => u.id === formData.owner_user_id)?.name || 'U')
                  .charAt(0)
                  .toUpperCase()}
              </div>
              <div className="flex-1">
                <p className="text-white font-medium text-sm">
                  {users.find((u) => u.id === formData.owner_user_id)?.name ||
                    'Unknown'}
                </p>
                <p className="text-xs text-hud-cream-mute">
                  Owner cannot be changed after creation
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {users
                .filter((u) => u.status === 'active')
                .map((u) => {
                  const isSelected = formData.owner_user_id === u.id;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() =>
                        setFormData({ ...formData, owner_user_id: u.id })
                      }
                      className={`w-full p-3 rounded-lg border-2 transition-all flex items-center gap-3 text-left ${
                        isSelected
                          ? 'border-hud-gold bg-hud-gold/10'
                          : 'border-hud-bg-elev bg-hud-bg-card hover:border-hud-cream-mute'
                      }`}
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-sm font-semibold text-white">
                        {(u.name || 'U').charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`font-medium text-sm truncate ${
                            isSelected ? 'text-white' : 'text-hud-cream-soft'
                          }`}
                        >
                          {u.name}
                        </p>
                        <p className="text-xs text-hud-cream-mute truncate">
                          {u.email}
                        </p>
                      </div>
                      {isSelected && (
                        <Check className="w-4 h-4 text-hud-gold-soft shrink-0" />
                      )}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-base font-semibold text-white">
            Who's on this team?
          </h3>
          <p className="text-sm text-hud-cream-dim mt-1">
            {selectedType.assignmentMode === 'collective'
              ? "Bookings only show times when every member is free."
              : 'Bookings will rotate across these members. Adjust weights to bias the rotation.'}
          </p>
        </div>

        {availableUsers.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Add members
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
              <input
                type="text"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search teammates..."
                className="w-full pl-10 pr-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
            </div>
            {memberSearch && filteredAvailableUsers.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto border border-hud-bg-elev rounded-lg bg-hud-bg-card divide-y divide-hud-bg-elev">
                {filteredAvailableUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => handleAddMember(u.id)}
                    className="w-full px-3 py-2 flex items-center gap-3 hover:bg-hud-bg-elev text-left"
                  >
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-xs font-semibold text-white">
                      {(u.name || 'U').charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm truncate">{u.name}</p>
                      <p className="text-xs text-hud-cream-mute truncate">
                        {u.email}
                      </p>
                    </div>
                    <Plus className="w-4 h-4 text-hud-cream-dim" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {members.length > 0 ? (
          <div className="space-y-2">
            {members.map((member) => (
              <div
                key={member.id}
                className="p-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-xs font-semibold text-white shrink-0">
                    {(member.user?.name || 'U').charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {member.user?.name || 'Unknown user'}
                    </p>
                    <p className="text-xs text-hud-cream-mute truncate">
                      {member.user?.email}
                    </p>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={member.active}
                      onChange={(e) =>
                        handleUpdateMember(member.id, {
                          active: e.target.checked,
                        })
                      }
                      className="w-3.5 h-3.5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold"
                    />
                    <span className="text-xs text-hud-cream-dim">Active</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleRemoveMember(member.id)}
                    className="p-1 text-hud-cream-mute hover:text-hud-plum transition-colors"
                    aria-label="Remove member"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {!isCollective && !isPriority && (
                  <div className="mt-3 pl-11">
                    <label className="flex items-center gap-3">
                      <span className="text-xs text-hud-cream-dim w-16">
                        Weight
                      </span>
                      <input
                        type="range"
                        min="1"
                        max="10"
                        value={member.weight}
                        onChange={(e) =>
                          handleUpdateMember(member.id, {
                            weight: parseInt(e.target.value) || 1,
                          })
                        }
                        className="flex-1 accent-hud-gold"
                      />
                      <span className="text-xs text-white font-mono w-6 text-right">
                        {member.weight}
                      </span>
                    </label>
                  </div>
                )}

                {isPriority && (
                  <div className="mt-3 pl-11">
                    <label className="flex items-center gap-3">
                      <span className="text-xs text-hud-cream-dim w-16">
                        Priority
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={member.priority}
                        onChange={(e) =>
                          handleUpdateMember(member.id, {
                            priority: parseInt(e.target.value) || 1,
                          })
                        }
                        className="w-20 px-2 py-1 bg-hud-bg-card border border-hud-bg-elev rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
                      />
                      <span className="text-xs text-hud-cream-mute">lower number = booked first</span>
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 border-2 border-dashed border-hud-bg-elev rounded-lg">
            <Users className="w-8 h-8 text-hud-cream-mute mx-auto mb-2" />
            <p className="text-sm text-hud-cream-dim">No team members yet</p>
            <p className="text-xs text-hud-cream-mute mt-1">
              Search above to add the first one.
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderAppointmentTypesStep = () => (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-white">
          What does this calendar book?
        </h3>
        <p className="text-sm text-hud-cream-dim mt-1">
          Pick the appointment type clients see when they land on this
          calendar's booking page. They won't be asked to choose — they go
          straight to picking a time.
        </p>
      </div>

      {orgAppointmentTypes.length === 0 && !newTypeDraft && !newTypeForm ? (
        <div className="text-center py-10 border-2 border-dashed border-hud-bg-elev rounded-lg">
          <Clock className="w-8 h-8 text-hud-cream-mute mx-auto mb-2" />
          <p className="text-sm text-hud-cream-soft font-medium">
            No appointment types yet
          </p>
          <p className="text-xs text-hud-cream-mute mt-1 max-w-xs mx-auto">
            Create one here; set intake questions and other details later in
            the Appointment Types tab.
          </p>
          <button
            type="button"
            onClick={openNewTypeForm}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-hud-gold/40 text-hud-gold-soft text-sm font-medium hover:bg-hud-gold/10 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New appointment type
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
            <input
              type="text"
              value={typeSearch}
              onChange={(e) => setTypeSearch(e.target.value)}
              placeholder="Search appointment types..."
              className="w-full pl-10 pr-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
          </div>

          <div
            role="radiogroup"
            aria-label="Appointment type"
            className="space-y-2 max-h-[420px] overflow-y-auto pr-1"
          >
            {filteredAppointmentTypes.map((type) => {
              const isSelected = selectedTypeId === type.id;
              const currentCalendar = type.calendar;
              const isOnAnotherCalendar =
                currentCalendar && currentCalendar.id !== calendar?.id;
              const wasInitiallyLinked = initiallyLinkedTypeId === type.id;
              return (
                <button
                  key={type.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => handleSelectAppointmentType(type.id)}
                  className={`w-full flex items-start gap-3 p-3 rounded-lg border-2 text-left transition-all ${
                    isSelected
                      ? 'border-hud-gold bg-hud-gold/10'
                      : 'border-hud-bg-elev bg-hud-bg-card hover:border-hud-cream-mute'
                  }`}
                >
                  <span
                    className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      isSelected
                        ? 'border-hud-gold'
                        : 'border-hud-cream-mute'
                    }`}
                  >
                    {isSelected && (
                      <span className="w-2 h-2 rounded-full bg-hud-gold" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p
                        className={`font-medium text-sm ${
                          isSelected ? 'text-white' : 'text-hud-cream-soft'
                        }`}
                      >
                        {type.name}
                      </p>
                      {!type.active && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-hud-bg-elev text-hud-cream-dim">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-hud-cream-mute">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {type.duration_minutes} min
                      </span>
                      {currentCalendar && (
                        <span className="flex items-center gap-1">
                          <CalendarIconLucide className="w-3 h-3" />
                          {currentCalendar.name}
                        </span>
                      )}
                    </div>
                    {isSelected &&
                      isOnAnotherCalendar &&
                      !wasInitiallyLinked && (
                        <p className="text-xs text-hud-rust mt-1.5 flex items-center gap-1">
                          <ArrowRight className="w-3 h-3" />
                          Will move from {currentCalendar?.name} to this
                          calendar
                        </p>
                      )}
                  </div>
                </button>
              );
            })}
            {newTypeDraft && (
              <button
                type="button"
                role="radio"
                aria-checked={selectedTypeId === NEW_TYPE_ID}
                onClick={() => handleSelectAppointmentType(NEW_TYPE_ID)}
                className={`w-full flex items-start gap-3 p-3 rounded-lg border-2 text-left transition-all ${
                  selectedTypeId === NEW_TYPE_ID
                    ? 'border-hud-gold bg-hud-gold/10'
                    : 'border-hud-bg-elev bg-hud-bg-card hover:border-hud-cream-mute'
                }`}
              >
                <span
                  className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selectedTypeId === NEW_TYPE_ID ? 'border-hud-gold' : 'border-hud-cream-mute'
                  }`}
                >
                  {selectedTypeId === NEW_TYPE_ID && <span className="w-2 h-2 rounded-full bg-hud-gold" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm text-white">{newTypeDraft.name}</p>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-hud-gold/15 text-hud-gold-soft">
                      New
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-hud-cream-mute">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {newTypeDraft.duration_minutes} min
                    </span>
                    <span>
                      {locationOptions.find((o) => o.value === newTypeDraft.location_type)?.label}
                    </span>
                  </div>
                  <p className="text-xs text-hud-cream-dim mt-1.5">
                    Created with this calendar when you {isEditing ? 'save' : 'create it'}.
                  </p>
                </div>
              </button>
            )}
            {filteredAppointmentTypes.length === 0 && typeSearch.trim() && (
              <p className="text-center text-sm text-hud-cream-mute py-4">
                No appointment types match "{typeSearch}"
              </p>
            )}
          </div>

          {newTypeForm ? (
            <div className="p-4 rounded-lg border border-hud-gold/40 bg-hud-bg-card space-y-3">
              <p className="text-sm font-medium text-white">New appointment type</p>
              <div>
                <label className="block text-xs font-medium text-hud-cream-dim mb-1">Name *</label>
                <input
                  type="text"
                  autoFocus
                  value={newTypeForm.name}
                  onChange={(e) => setNewTypeForm({ ...newTypeForm, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleConfirmNewType();
                    }
                  }}
                  placeholder="e.g. 30-minute consultation"
                  className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-hud-cream-dim mb-1">Duration</label>
                  <select
                    value={newTypeForm.duration_minutes}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, duration_minutes: parseInt(e.target.value, 10) })}
                    className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    {durationOptions.map((d) => (
                      <option key={d} value={d}>
                        {d} minutes
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-hud-cream-dim mb-1">Location</label>
                  <select
                    value={newTypeForm.location_type}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, location_type: e.target.value as LocationType })}
                    className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                  >
                    {locationOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {newTypeError && <p className="text-xs text-hud-plum">{newTypeError}</p>}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewTypeForm(null);
                    setNewTypeError('');
                  }}
                  className="px-3 py-1.5 text-sm text-hud-cream-soft hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmNewType}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white text-sm font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all"
                >
                  <Check className="w-4 h-4" />
                  {newTypeDraft ? 'Update' : 'Add and select'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={openNewTypeForm}
              className="w-full flex items-center justify-center gap-1.5 p-2.5 rounded-lg border-2 border-dashed border-hud-bg-elev text-sm font-medium text-hud-gold-soft hover:border-hud-gold/40 hover:bg-hud-gold/5 transition-colors"
            >
              <Plus className="w-4 h-4" />
              {newTypeDraft
                ? 'Edit new appointment type'
                : filteredAppointmentTypes.length === 0 && typeSearch.trim()
                  ? `New appointment type "${typeSearch.trim()}"`
                  : 'New appointment type'}
            </button>
          )}

          <p className="text-xs text-hud-cream-mute">
            {selectedTypeId
              ? 'Clients booking on this calendar will go straight to picking a time.'
              : 'Pick one type so this calendar has something bookable.'}
          </p>
        </>
      )}
    </div>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case 'type':
        return renderTypeStep();
      case 'basics':
        return renderBasicsStep();
      case 'team':
        return renderTeamStep();
      case 'appointment-types':
        return renderAppointmentTypesStep();
    }
  };

  return (
    <>
      {/* Backdrop and panel share one Portal so the panel stays above its backdrop. */}
      <Portal>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-3xl bg-hud-bg-mid border-l border-hud-bg-elev z-50 flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {isEditing ? 'Edit Calendar' : 'Create Calendar'}
            </h2>
            <p className="text-xs text-hud-cream-mute mt-0.5">
              {STEPS[stepIndex].description}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-hud-cream-dim hover:text-white rounded"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {renderStepNav()}

        <div className="flex-1 overflow-y-auto">
          <div className="p-6">
            {error && (
              <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/30 rounded-lg text-hud-plum text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {renderStepContent()}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-hud-bg-elev flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={stepIndex === 0 ? onClose : handleBack}
            disabled={saving}
            className="inline-flex items-center gap-1 px-4 py-2 text-hud-cream-soft hover:text-white transition-colors disabled:opacity-50"
          >
            {stepIndex === 0 ? (
              'Cancel'
            ) : (
              <>
                <ChevronLeft className="w-4 h-4" />
                Back
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            {isEditing && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className="px-4 py-2 text-hud-gold-soft hover:text-hud-gold-soft text-sm font-medium transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            )}
            {!isFinalStep ? (
              <button
                type="button"
                onClick={handleNext}
                disabled={saving}
                className="inline-flex items-center gap-1 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50"
              >
                Continue
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Saving...
                  </>
                ) : isEditing ? (
                  'Save Changes'
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Create Calendar
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      </Portal>
    </>
  );
}

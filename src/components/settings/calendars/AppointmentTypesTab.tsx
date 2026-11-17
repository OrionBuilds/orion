import { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Search,
  Clock,
  MoreVertical,
  Edit2,
  Copy,
  Trash2,
  ExternalLink,
  Phone,
  Video,
  MapPin,
  Link as LinkIcon,
  Check,
  X,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getCalendars } from '../../../services/calendars';
import { getDepartments } from '../../../services/departments';
import { deleteAppointmentType } from '../../../services/appointmentTypes';
import type { Calendar, Department, AppointmentType, LocationType } from '../../../types';
import { AppointmentTypeDrawer } from './AppointmentTypeDrawer';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

const locationIcons: Record<LocationType, typeof Phone> = {
  phone: Phone,
  google_meet: Video,
  zoom: Video,
  in_person: MapPin,
  custom: LinkIcon,
};

const locationLabels: Record<LocationType, string> = {
  phone: 'Phone Call',
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  in_person: 'In Person',
  custom: 'Custom',
};

export function AppointmentTypesTab() {
  const { user } = useAuth();
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCalendarId, setFilterCalendarId] = useState('');
  const [filterDepartmentId, setFilterDepartmentId] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  // The row menu must render position:fixed anchored to its button — the table sits
  // inside overflow-x-auto/overflow-hidden, which clips an absolutely-positioned
  // dropdown (same fix CalendarsTab already uses).
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const menuButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingType, setEditingType] = useState<AppointmentType | null>(null);
  const [editingCalendar, setEditingCalendar] = useState<Calendar | null>(null);

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    if (!user?.organization_id) return;

    try {
      setLoading(true);
      const [calendarsData, departmentsData] = await Promise.all([
        getCalendars(user.organization_id),
        getDepartments(user.organization_id),
      ]);
      setCalendars(calendarsData);
      setDepartments(departmentsData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const allAppointmentTypes = calendars.flatMap((calendar) =>
    (calendar.appointment_types || []).map((type) => ({
      ...type,
      calendar,
    }))
  );

  const filteredTypes = allAppointmentTypes.filter((type) => {
    if (searchQuery && !type.name.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (filterCalendarId && type.calendar_id !== filterCalendarId) {
      return false;
    }
    if (filterDepartmentId && type.calendar.department_id !== filterDepartmentId) {
      return false;
    }
    if (filterStatus === 'active' && !type.active) {
      return false;
    }
    if (filterStatus === 'inactive' && type.active) {
      return false;
    }
    return true;
  });

  const handleCreateType = () => {
    setEditingType(null);
    setEditingCalendar(null);
    setDrawerOpen(true);
  };

  const handleEditType = (type: AppointmentType & { calendar: Calendar }) => {
    setEditingType(type);
    setEditingCalendar(type.calendar);
    setDrawerOpen(true);
    setActiveMenu(null);
  };

  const handleCopyLink = (type: AppointmentType & { calendar: Calendar }) => {
    const bookingUrl = `${window.location.origin}/book/${type.calendar.slug}/${type.slug}`;
    navigator.clipboard.writeText(bookingUrl);
    setActiveMenu(null);
  };

  const handlePreview = (type: AppointmentType & { calendar: Calendar }) => {
    const bookingUrl = `${window.location.origin}/book/${type.calendar.slug}/${type.slug}`;
    window.open(bookingUrl, '_blank');
    setActiveMenu(null);
  };

  const handleDeleteType = async (type: AppointmentType & { calendar: Calendar }) => {
    setActiveMenu(null);
    setMenuPosition(null);
    if (!user) return;
    const ok = window.confirm(
      `Delete the appointment type "${type.name}"? This can't be undone and its booking link will stop working.`
    );
    if (!ok) return;
    try {
      await deleteAppointmentType(type.id, user);
      await loadData();
    } catch (err) {
      console.error('Failed to delete appointment type:', err);
      window.alert('Could not delete this appointment type. Please try again.');
    }
  };

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    setEditingType(null);
    setEditingCalendar(null);
  };

  const handleDrawerSave = () => {
    loadData();
    handleDrawerClose();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-hud-gold border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (calendars.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 bg-hud-bg-card rounded-full flex items-center justify-center mb-4">
          <Clock className="w-8 h-8 text-hud-cream-mute" />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">No calendars available</h3>
        <p className="text-hud-cream-dim mb-6 max-w-md">
          Create a calendar first before adding appointment types.
        </p>
      </div>
    );
  }

  if (allAppointmentTypes.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 bg-hud-bg-card rounded-full flex items-center justify-center mb-4">
            <Clock className="w-8 h-8 text-hud-cream-mute" />
          </div>
          <h3 className="text-lg font-medium text-white mb-2">No appointment types</h3>
          <p className="text-hud-cream-dim mb-6 max-w-md">
            Create appointment types to define what people can book on your calendars.
          </p>
          <button
            onClick={handleCreateType}
            className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Appointment Type
          </button>
        </div>

        <AppointmentTypeDrawer
          open={drawerOpen}
          onClose={handleDrawerClose}
          onSave={handleDrawerSave}
          appointmentType={editingType}
          calendar={editingCalendar}
          calendars={calendars}
        />
      </>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
          <div className="flex flex-wrap gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
              <input
                type="text"
                placeholder="Search appointment types..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent w-64"
              />
            </div>

            <select
              value={filterCalendarId}
              onChange={(e) => setFilterCalendarId(e.target.value)}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All Calendars</option>
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {cal.name}
                </option>
              ))}
            </select>

            <select
              value={filterDepartmentId}
              onChange={(e) => setFilterDepartmentId(e.target.value)}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All Departments</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                </option>
              ))}
            </select>

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          <button
            onClick={handleCreateType}
            className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg font-medium hover:from-hud-gold-deep hover:to-hud-teal transition-all flex items-center gap-2 whitespace-nowrap self-start shrink-0"
          >
            <Plus className="w-4 h-4" />
            Create Appointment Type
          </button>
        </div>

        <div className="bg-hud-bg-card/50 rounded-xl border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-hud-bg-elev">
                <th className="text-left px-4 py-3 text-hud-cream-dim font-medium text-sm">Name</th>
                <th className="text-left px-4 py-3 text-hud-cream-dim font-medium text-sm">Calendar</th>
                <th className="text-left px-4 py-3 text-hud-cream-dim font-medium text-sm">Duration</th>
                <th className="text-left px-4 py-3 text-hud-cream-dim font-medium text-sm">Location</th>
                <th className="text-left px-4 py-3 text-hud-cream-dim font-medium text-sm">Status</th>
                <th className="text-right px-4 py-3 text-hud-cream-dim font-medium text-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTypes.map((type) => {
                const LocationIcon = locationIcons[type.location_type] || LinkIcon;

                return (
                  <tr key={type.id} className="border-b border-hud-bg-elev/50 hover:bg-hud-bg-elev/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-hud-gold/20 rounded-lg flex items-center justify-center">
                          <Clock className="w-4 h-4 text-hud-gold-soft" />
                        </div>
                        <span className="text-white font-medium">{type.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-hud-cream-soft">{type.calendar.name}</td>
                    <td className="px-4 py-3 text-hud-cream-soft">{type.duration_minutes} min</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 text-hud-cream-soft">
                        <LocationIcon className="w-4 h-4" />
                        <span>{locationLabels[type.location_type]}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                          type.active
                            ? 'bg-hud-emerald/20 text-hud-emerald'
                            : 'bg-hud-cream-mute/20 text-hud-cream-dim'
                        }`}
                      >
                        {type.active ? (
                          <>
                            <Check className="w-3 h-3" />
                            Active
                          </>
                        ) : (
                          <>
                            <X className="w-3 h-3" />
                            Inactive
                          </>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <div className="relative">
                          <button
                            ref={(el) => { menuButtonRefs.current[type.id] = el; }}
                            onClick={() => {
                              if (activeMenu === type.id) {
                                setActiveMenu(null);
                                setMenuPosition(null);
                              } else {
                                const btn = menuButtonRefs.current[type.id];
                                if (btn) {
                                  const rect = btn.getBoundingClientRect();
                                  setMenuPosition({
                                    top: rect.bottom + window.scrollY + 4,
                                    right: window.innerWidth - rect.right,
                                  });
                                }
                                setActiveMenu(type.id);
                              }
                            }}
                            className="p-1 text-hud-cream-dim hover:text-white rounded"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {activeMenu === type.id && menuPosition && (
                            <>
                              <div
                                className="fixed inset-0 z-40"
                                onClick={() => { setActiveMenu(null); setMenuPosition(null); }}
                              />
                              <AnchoredMenu
                                className="w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50 py-1"
                              >
                                <button
                                  onClick={() => handleEditType(type)}
                                  className="w-full px-4 py-2 text-left text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2"
                                >
                                  <Edit2 className="w-4 h-4" />
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleCopyLink(type)}
                                  className="w-full px-4 py-2 text-left text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2"
                                >
                                  <Copy className="w-4 h-4" />
                                  Copy Booking URL
                                </button>
                                <button
                                  onClick={() => handlePreview(type)}
                                  className="w-full px-4 py-2 text-left text-hud-cream-soft hover:bg-hud-bg-elev flex items-center gap-2"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                  Preview
                                </button>
                                <button
                                  onClick={() => handleDeleteType(type)}
                                  className="w-full px-4 py-2 text-left text-hud-plum hover:bg-hud-bg-elev flex items-center gap-2"
                                >
                                  <Trash2 className="w-4 h-4" />
                                  Delete
                                </button>
                              </AnchoredMenu>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {filteredTypes.length === 0 && (
            <div className="text-center py-8 text-hud-cream-dim">
              No appointment types match your filters
            </div>
          )}
        </div>
      </div>

      <AppointmentTypeDrawer
        open={drawerOpen}
        onClose={handleDrawerClose}
        onSave={handleDrawerSave}
        appointmentType={editingType}
        calendar={editingCalendar}
        calendars={calendars}
      />
    </>
  );
}

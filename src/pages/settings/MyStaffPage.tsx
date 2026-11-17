import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useInTabbedModule } from '../../hooks/useInTabbedModule';
import {
  getUsers,
  getUsersByDepartment,
  getStaffStats,
  bulkEnableUsers,
  bulkDisableUsers,
  bulkAssignDepartment,
  exportStaffList,
  generateCSV,
} from '../../services/users';
import { getDepartments } from '../../services/departments';
import { getRoles } from '../../services/roles';
import { getAgentLastActiveMap } from '../../services/agentTasks';
import {
  Search,
  Filter,
  Loader2,
  Users as UsersIcon,
  UserPlus,
  Building2,
  UserCheck,
  UserX,
  Mail,
  Download,
} from 'lucide-react';
import { StaffTable } from '../../components/settings/staff/StaffTable';
import { BulkActionsToolbar } from '../../components/settings/staff/BulkActionsToolbar';
import { InviteUserDrawer } from '../../components/settings/staff/InviteUserDrawer';
import { UserDetailDrawer } from '../../components/settings/staff/UserDetailDrawer';
import { DepartmentsModal } from '../../components/settings/staff/DepartmentsModal';
import type { User, Department, Role, UserStatus } from '../../types';

type StatusFilter = 'all' | UserStatus;

export function MyStaffPage() {
  const { user, isSuperAdmin, hasPermission } = useAuth();
  const [staffMembers, setStaffMembers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [departmentFilter, setDepartmentFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const [showInviteDrawer, setShowInviteDrawer] = useState(false);
  const [showDepartmentsModal, setShowDepartmentsModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [stats, setStats] = useState({ total: 0, active: 0, invited: 0, disabled: 0 });
  const [agentLastActive, setAgentLastActive] = useState<Record<string, string>>({});

  const canInvite = hasPermission('staff.invite') || isSuperAdmin;
  const canManageDepartments = hasPermission('departments.manage') || isSuperAdmin;
  const inTabbedModule = useInTabbedModule();
  const canDisable = hasPermission('staff.disable') || isSuperAdmin;
  const isManager = user?.role?.name === 'Manager';

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    if (!user?.organization_id) return;

    try {
      setIsLoading(true);

      const [depsData, rolesData, statsData, agentActivity] = await Promise.all([
        getDepartments(user.organization_id),
        getRoles(),
        getStaffStats(user.organization_id),
        // Agents never sign in via the browser, so last_sign_in_at is always null for them.
        getAgentLastActiveMap(user.organization_id).catch(() => ({})),
      ]);

      let usersData: User[];
      if (isManager && user.department_id) {
        usersData = await getUsersByDepartment(user.organization_id, user.department_id);
      } else {
        usersData = await getUsers(user.organization_id);
      }

      setStaffMembers(usersData);
      setDepartments(depsData);
      setRoles(rolesData);
      setStats(statsData);
      setAgentLastActive(agentActivity);
      setSelectedIds([]);

      setSelectedMember((prev) => {
        if (!prev) return null;
        const updated = usersData.find((u) => u.id === prev.id);
        return updated || null;
      });
    } catch (error) {
      console.error('Failed to load staff data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredStaff = staffMembers.filter((member) => {
    const matchesSearch =
      !searchQuery ||
      member.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      member.email.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || member.status === statusFilter;

    const matchesDepartment =
      departmentFilter === 'all' || member.department_id === departmentFilter;

    const matchesRole = roleFilter === 'all' || member.role_id === roleFilter;

    return matchesSearch && matchesStatus && matchesDepartment && matchesRole;
  });

  const selectedUsers = staffMembers.filter((m) => selectedIds.includes(m.id));

  const handleBulkEnable = async () => {
    if (!user) return;
    await bulkEnableUsers(selectedIds, user);
    await loadData();
  };

  const handleBulkDisable = async () => {
    if (!user) return;
    await bulkDisableUsers(selectedIds, user);
    await loadData();
  };

  const handleBulkAssignDepartment = async (departmentId: string | null) => {
    if (!user) return;
    await bulkAssignDepartment(selectedIds, departmentId, user);
    await loadData();
  };

  const handleExport = async () => {
    if (!user?.organization_id) return;

    try {
      const rows = await exportStaffList(user.organization_id);
      const csv = generateCSV(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `staff-export-${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Failed to export staff:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50dvh]">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl">
      <div className={`flex flex-col sm:flex-row sm:items-center gap-4 mb-6 ${inTabbedModule ? 'sm:justify-end' : 'sm:justify-between'}`}>
        {!inTabbedModule && (
          <div>
            <h2 className="text-xl font-semibold text-white">My Staff</h2>
            <p className="text-hud-cream-dim mt-1">Manage users and permissions</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev transition-colors font-medium"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
          {canManageDepartments && (
            <button
              onClick={() => setShowDepartmentsModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev transition-colors font-medium"
            >
              <Building2 className="w-4 h-4" />
              Departments
            </button>
          )}
          {canInvite && (
            <button
              onClick={() => setShowInviteDrawer(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors font-medium"
            >
              <UserPlus className="w-4 h-4" />
              Invite User
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <UsersIcon className="w-4 h-4 text-hud-cream-dim" />
            <span className="text-sm text-hud-cream-dim">Total</span>
          </div>
          <p className="text-2xl font-semibold text-white">{stats.total}</p>
        </div>
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <UserCheck className="w-4 h-4 text-hud-emerald" />
            <span className="text-sm text-hud-cream-dim">Active</span>
          </div>
          <p className="text-2xl font-semibold text-hud-emerald">{stats.active}</p>
        </div>
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="w-4 h-4 text-hud-rust" />
            <span className="text-sm text-hud-cream-dim">Invited</span>
          </div>
          <p className="text-2xl font-semibold text-hud-rust">{stats.invited}</p>
        </div>
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <UserX className="w-4 h-4 text-hud-plum" />
            <span className="text-sm text-hud-cream-dim">Disabled</span>
          </div>
          <p className="text-2xl font-semibold text-hud-plum">{stats.disabled}</p>
        </div>
      </div>

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        <div className="p-4 border-b border-hud-bg-card">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-hud-cream-dim" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                showFilters
                  ? 'bg-hud-gold/10 text-hud-gold-soft border border-hud-gold/20'
                  : 'bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filters
            </button>
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-hud-bg-card">
              <div>
                <label className="block text-xs font-medium text-hud-cream-dim mb-1">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="invited">Invited</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>

              {!isManager && (
                <div>
                  <label className="block text-xs font-medium text-hud-cream-dim mb-1">
                    Department
                  </label>
                  <select
                    value={departmentFilter}
                    onChange={(e) => setDepartmentFilter(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                  >
                    <option value="all">All Departments</option>
                    {departments.map((dept) => (
                      <option key={dept.id} value={dept.id}>
                        {dept.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-hud-cream-dim mb-1">Role</label>
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
                >
                  <option value="all">All Roles</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <BulkActionsToolbar
          selectedCount={selectedIds.length}
          selectedUsers={selectedUsers}
          departments={departments}
          onClearSelection={() => setSelectedIds([])}
          onBulkEnable={handleBulkEnable}
          onBulkDisable={handleBulkDisable}
          onBulkAssignDepartment={handleBulkAssignDepartment}
          onExport={handleExport}
          canDisable={canDisable}
        />

        <StaffTable
          staff={filteredStaff}
          departments={departments}
          roles={roles}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onRowClick={(member) => setSelectedMember(member)}
          currentUserId={user?.id}
          agentLastActive={agentLastActive}
        />

        {filteredStaff.length > 0 && (
          <div className="p-4 border-t border-hud-bg-card">
            <p className="text-sm text-hud-cream-mute">
              Showing {filteredStaff.length} of {staffMembers.length} users
            </p>
          </div>
        )}
      </div>

      <InviteUserDrawer
        isOpen={showInviteDrawer}
        onClose={() => setShowInviteDrawer(false)}
        onSuccess={loadData}
        departments={departments}
        roles={roles}
      />

      <UserDetailDrawer
        isOpen={!!selectedMember}
        onClose={() => setSelectedMember(null)}
        member={selectedMember}
        departments={departments}
        roles={roles}
        onUpdate={loadData}
      />

      {showDepartmentsModal && (
        <DepartmentsModal onClose={() => setShowDepartmentsModal(false)} onUpdate={loadData} />
      )}
    </div>
  );
}

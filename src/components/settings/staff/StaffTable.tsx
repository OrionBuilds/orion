import { useCallback, useRef } from 'react';
import { Table, THead, TH } from '../../ui/Table';
import { Users as UsersIcon, UserCheck, UserX, Mail, Calendar, Bot } from 'lucide-react';
import { RoleBadge } from './RoleBadge';
import type { User, Department, Role } from '../../../types';

interface StaffTableProps {
  staff: User[];
  departments: Department[];
  roles: Role[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onRowClick: (member: User) => void;
  currentUserId?: string;
  /** agent_user_id -> last agent-task activity. Agents connect over MCP and never sign in
   *  through the browser, so last_sign_in_at is always null for them. */
  agentLastActive?: Record<string, string>;
}

export function StaffTable({
  staff,
  departments,
  roles,
  selectedIds,
  onSelectionChange,
  onRowClick,
  currentUserId,
  agentLastActive,
}: StaffTableProps) {
  const lastSelectedIndex = useRef<number | null>(null);

  const getDepartmentName = (departmentId: string | null) => {
    if (!departmentId) return 'No Department';
    const dept = departments.find((d) => d.id === departmentId);
    return dept?.name || 'Unknown';
  };

  const getRoleName = (roleId: string) => {
    const role = roles.find((r) => r.id === roleId);
    return role?.name || 'Unknown';
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'active':
        return {
          color: 'bg-hud-emerald/10 text-hud-emerald border-hud-emerald/20',
          icon: UserCheck,
          label: 'Active',
        };
      case 'disabled':
        return {
          color: 'bg-hud-plum/10 text-hud-plum border-hud-plum/20',
          icon: UserX,
          label: 'Disabled',
        };
      case 'invited':
        return {
          color: 'bg-hud-rust/10 text-hud-rust border-hud-rust/20',
          icon: Mail,
          label: 'Invited',
        };
      default:
        return {
          color: 'bg-hud-cream-mute/10 text-hud-cream-dim border-hud-cream-mute/20',
          icon: UsersIcon,
          label: status,
        };
    }
  };

  const formatLastActive = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      return `${Math.floor(diffMins / 60)}h ago`;
    }
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  /** Agents report activity through agent_task_runs, not browser sign-ins. */
  const getLastActive = (member: User) => {
    const agentRun = agentLastActive?.[member.id];
    if (agentRun) return { label: formatLastActive(agentRun), isAgent: true };
    return { label: formatLastActive(member.last_sign_in_at), isAgent: false };
  };

  const formatJoinedDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const isAllSelected = staff.length > 0 && selectedIds.length === staff.length;
  const isSomeSelected = selectedIds.length > 0 && selectedIds.length < staff.length;

  const handleSelectAll = () => {
    if (isAllSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(staff.map((m) => m.id));
    }
  };

  const handleRowSelect = useCallback(
    (member: User, index: number, event: React.MouseEvent) => {
      event.stopPropagation();

      const isSelected = selectedIds.includes(member.id);

      if (event.shiftKey && lastSelectedIndex.current !== null) {
        const start = Math.min(lastSelectedIndex.current, index);
        const end = Math.max(lastSelectedIndex.current, index);
        const rangeIds = staff.slice(start, end + 1).map((m) => m.id);
        const newSelection = new Set([...selectedIds, ...rangeIds]);
        onSelectionChange(Array.from(newSelection));
      } else {
        if (isSelected) {
          onSelectionChange(selectedIds.filter((id) => id !== member.id));
        } else {
          onSelectionChange([...selectedIds, member.id]);
        }
        lastSelectedIndex.current = index;
      }
    },
    [selectedIds, staff, onSelectionChange]
  );

  if (staff.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <UsersIcon className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
        <p className="text-hud-cream-dim">No staff members found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TH className="w-10">
            <input
              type="checkbox"
              checked={isAllSelected}
              ref={(el) => {
                if (el) el.indeterminate = isSomeSelected;
              }}
              onChange={handleSelectAll}
              className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-0 focus:ring-offset-hud-bg-mid"
            />
          </TH>
          <TH>Name</TH>
          <TH className="hidden md:table-cell">Email</TH>
          <TH>Role</TH>
          <TH className="hidden lg:table-cell">Department</TH>
          <TH>Status</TH>
          <TH className="hidden xl:table-cell">Last Active</TH>
          <TH className="hidden 2xl:table-cell">Joined Date</TH>
        </THead>
        <tbody className="divide-y divide-hud-bg-card">
          {staff.map((member, index) => {
            const statusConfig = getStatusConfig(member.status);
            const StatusIcon = statusConfig.icon;
            const isCurrentUser = member.id === currentUserId;
            const isSelected = selectedIds.includes(member.id);

            return (
              <tr
                key={member.id}
                onClick={() => onRowClick(member)}
                className={`transition-colors cursor-pointer ${
                  isSelected ? 'bg-hud-gold/10' : 'hover:bg-hud-bg-elev'
                }`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onClick={(e) => handleRowSelect(member, index, e)}
                    onChange={() => {}}
                    className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-0 focus:ring-offset-hud-bg-mid"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center text-white font-semibold flex-shrink-0">
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium truncate">{member.name}</p>
                        {isCurrentUser && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-hud-gold/10 text-hud-gold-soft border border-hud-gold/20">
                            You
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-hud-cream-mute truncate md:hidden">{member.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  <p className="text-hud-cream-soft truncate max-w-[200px]">{member.email}</p>
                </td>
                <td className="px-4 py-3">
                  <RoleBadge roleName={getRoleName(member.role_id)} />
                </td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  <span className="text-sm text-hud-cream-dim">
                    {getDepartmentName(member.department_id)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${statusConfig.color}`}
                  >
                    <StatusIcon className="w-3 h-3" />
                    {statusConfig.label}
                  </span>
                </td>
                <td className="px-4 py-3 hidden xl:table-cell">
                  {(() => {
                    const { label, isAgent } = getLastActive(member);
                    return isAgent ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-sm text-hud-gold-soft"
                        title="Last scheduled agent run"
                      >
                        <Bot className="w-3.5 h-3.5" />
                        {label}
                      </span>
                    ) : (
                      <span className="text-sm text-hud-cream-mute">{label}</span>
                    );
                  })()}
                </td>
                <td className="px-4 py-3 hidden 2xl:table-cell">
                  <div className="flex items-center gap-1.5 text-sm text-hud-cream-mute">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatJoinedDate(member.created_at)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

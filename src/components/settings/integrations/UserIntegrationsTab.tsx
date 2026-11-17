import { useState, useEffect } from 'react';
import { User, CheckCircle, XCircle, Calendar, Mail, Loader2, Clock } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { getUserIntegrations } from '../../../services/integrations';
import { supabase } from '../../../lib/supabase';
import type { IntegrationConnection, User as UserType } from '../../../types';
import { formatDateShort } from '../../../utils/formatters';

interface UserWithConnections {
  user: UserType;
  connections: IntegrationConnection[];
}

export function UserIntegrationsTab() {
  const { user: currentUser, hasPermission } = useAuth();
  const [usersWithConnections, setUsersWithConnections] = useState<UserWithConnections[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [users, setUsers] = useState<UserType[]>([]);

  const isAdmin = hasPermission('integrations.manage');

  useEffect(() => {
    loadData();
  }, [selectedUserId]);

  const loadData = async () => {
    try {
      setLoading(true);

      if (isAdmin) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, name, email, avatar_url, department:departments(id, name)')
          .eq('status', 'active')
          .order('name');

        // partial column select of users (id/name/email/avatar_url are all this component reads);
        // supabase-js types the to-one department FK join as an array; runtime shape is a single object
        setUsers((usersData || []) as unknown as UserType[]);

        const connections = await getUserIntegrations(selectedUserId || undefined);

        const grouped = (usersData || []).map((u) => ({
          // same partial-row shape as above; cast documented there
          user: u as unknown as UserType,
          connections: connections.filter((c) => c.user_id === u.id),
        }));

        setUsersWithConnections(grouped.filter((g) => g.connections.length > 0 || g.user.id === selectedUserId));
      } else {
        const myConnections = await getUserIntegrations(currentUser?.id);
        if (currentUser) {
          setUsersWithConnections([
            {
              user: currentUser as UserType,
              connections: myConnections,
            },
          ]);
        }
      }
    } catch (error) {
      console.error('Failed to load user integrations:', error);
    } finally {
      setLoading(false);
    }
  };

  const getIntegrationIcon = (key: string) => {
    if (key.includes('calendar')) return Calendar;
    if (key.includes('email') || key.includes('gmail')) return Mail;
    return User;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-hud-cream-soft">Filter by User:</label>
          <select
            value={selectedUserId || ''}
            onChange={(e) => setSelectedUserId(e.target.value || null)}
            className="rounded-lg border border-hud-bg-elev bg-hud-bg-card py-2 pl-3 pr-8 text-sm text-white focus:border-hud-gold focus:outline-none focus:ring-1 focus:ring-hud-gold"
          >
            <option value="">All Users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </div>
      )}

      {usersWithConnections.length === 0 ? (
        <div className="rounded-lg border border-hud-bg-elev bg-hud-bg-card p-12 text-center">
          <User className="mx-auto h-12 w-12 text-hud-cream-mute" />
          <h3 className="mt-4 text-lg font-medium text-white">No User Integrations</h3>
          <p className="mt-2 text-sm text-hud-cream-dim">
            User-level integrations like personal calendars will appear here once connected.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {usersWithConnections.map(({ user, connections }) => (
            <div key={user.id} className="rounded-lg border border-hud-bg-elev bg-hud-bg-card overflow-hidden">
              <div className="border-b border-hud-bg-elev bg-hud-bg-card/50 px-6 py-4">
                <div className="flex items-center gap-3">
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt={user.name || ''}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-hud-bg-elev text-hud-cream-dim">
                      <User className="h-5 w-5" />
                    </div>
                  )}
                  <div>
                    <div className="font-medium text-white">{user.name || 'Unknown'}</div>
                    <div className="text-sm text-hud-cream-dim">{user.email}</div>
                  </div>
                </div>
              </div>
              <div className="divide-y divide-hud-bg-elev/50">
                {connections.length === 0 ? (
                  <div className="px-6 py-4 text-sm text-hud-cream-mute">
                    No personal integrations connected
                  </div>
                ) : (
                  connections.map((conn) => {
                    const Icon = getIntegrationIcon((conn as any).integrations?.key || '');
                    return (
                      <div
                        key={conn.id}
                        className="flex items-center justify-between px-6 py-4 transition-colors hover:bg-hud-bg-card/50"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-hud-bg-elev">
                            <Icon className="h-4 w-4 text-hud-cream-dim" />
                          </div>
                          <div>
                            <div className="font-medium text-white">
                              {(conn as any).integrations?.name || 'Unknown'}
                            </div>
                            <div className="text-sm text-hud-cream-mute">
                              {conn.account_info?.email || conn.account_info?.name || '-'}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="flex items-center gap-2 text-sm text-hud-cream-mute">
                            <Clock className="h-4 w-4" />
                            <span>Connected {formatDateShort(conn.connected_at, { fallback: 'Unknown' })}</span>
                          </div>
                          {conn.status === 'connected' ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-hud-emerald/10 px-2.5 py-1 text-xs font-medium text-hud-emerald">
                              <CheckCircle className="h-3 w-3" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-hud-plum/10 px-2.5 py-1 text-xs font-medium text-hud-plum">
                              <XCircle className="h-3 w-3" />
                              {conn.status}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { X, Search, Loader2, MessageCircle } from 'lucide-react';
import { getOrganizationUsers } from '../../services/teamMessaging';
import { useAuth } from '../../contexts/AuthContext';
import { Portal } from '../shared/Portal';

interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  department_id: string | null;
  status: string;
}

interface DirectMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectUser: (userId: string) => void;
}

export function DirectMessageModal({
  isOpen,
  onClose,
  onSelectUser,
}: DirectMessageModalProps) {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<User[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadUsers();
    }
  }, [isOpen]);

  useEffect(() => {
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      setFilteredUsers(
        users.filter(
          (user) =>
            user.name.toLowerCase().includes(query) ||
            user.email.toLowerCase().includes(query)
        )
      );
    } else {
      setFilteredUsers(users);
    }
  }, [searchQuery, users]);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const data = await getOrganizationUsers(currentUser?.id);
      setUsers(data);
      setFilteredUsers(data);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectUser = (userId: string) => {
    onSelectUser(userId);
    onClose();
    setSearchQuery('');
  };

  if (!isOpen) return null;

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl shadow-2xl w-full max-w-md max-h-[600px] flex flex-col">
        <div className="p-4 border-b border-hud-bg-elev flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">New Message</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-hud-bg-elev text-hud-cream-dim hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4 border-b border-hud-bg-elev">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search users..."
              className="w-full pl-9 pr-4 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <Loader2 className="w-8 h-8 text-hud-gold animate-spin mx-auto mb-2" />
                <p className="text-sm text-hud-cream-dim">Loading users...</p>
              </div>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="w-12 h-12 rounded-xl bg-hud-bg-elev flex items-center justify-center mx-auto mb-3">
                  <MessageCircle className="w-6 h-6 text-hud-cream-mute" />
                </div>
                <p className="text-sm text-hud-cream-dim">
                  {searchQuery ? 'No users found' : 'No users available'}
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-hud-bg-elev">
              {filteredUsers.map((user) => (
                <button
                  key={user.id}
                  onClick={() => handleSelectUser(user.id)}
                  className="w-full p-4 hover:bg-hud-bg-elev/50 transition-colors text-left flex items-center gap-3"
                >
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt={user.name}
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-hud-gold to-blue-600 flex items-center justify-center">
                      <span className="text-white text-sm font-medium">
                        {user.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-white truncate">
                      {user.name}
                    </h4>
                    <p className="text-xs text-hud-cream-dim truncate">{user.email}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  );
}

import { useState, useEffect } from 'react';
import { X, Search, Users, Loader2, Check } from 'lucide-react';
import { getOrganizationUsers, createGroupChannel } from '../../services/teamMessaging';
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

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGroupCreated: (channelId: string) => void;
}

export function CreateGroupModal({
  isOpen,
  onClose,
  onGroupCreated,
}: CreateGroupModalProps) {
  const { user: currentUser } = useAuth();
  const [groupName, setGroupName] = useState('');
  const [description, setDescription] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<User[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      setGroupName('');
      setDescription('');
      setSelectedUserIds(new Set());
      setSearchQuery('');
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

  const toggleUser = (userId: string) => {
    const newSelected = new Set(selectedUserIds);
    if (newSelected.has(userId)) {
      newSelected.delete(userId);
    } else {
      newSelected.add(userId);
    }
    setSelectedUserIds(newSelected);
  };

  const handleCreate = async () => {
    if (!groupName.trim() || selectedUserIds.size === 0) return;

    try {
      setCreating(true);
      const channel = await createGroupChannel(
        groupName.trim(),
        description.trim() || null,
        Array.from(selectedUserIds)
      );
      onGroupCreated(channel.id);
      onClose();
    } catch (error) {
      console.error('Failed to create group:', error);
      alert('Failed to create group. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const selectedUsers = users.filter((u) => selectedUserIds.has(u.id));

  if (!isOpen) return null;

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-card rounded-xl shadow-2xl w-full max-w-2xl max-h-[700px] flex flex-col">
        <div className="p-4 border-b border-hud-bg-elev flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Create Group</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-hud-bg-elev text-hud-cream-dim hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4 border-b border-hud-bg-elev space-y-3">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
              Group Name *
            </label>
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="e.g., Marketing Team"
              className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              maxLength={50}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this group about?"
              className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              maxLength={100}
            />
          </div>

          {selectedUsers.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Selected Members ({selectedUsers.length})
              </label>
              <div className="flex flex-wrap gap-2">
                {selectedUsers.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-2 px-3 py-1.5 bg-hud-bg-elev rounded-full"
                  >
                    {user.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt={user.name}
                        className="w-5 h-5 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-gradient-to-br from-hud-gold to-blue-600 flex items-center justify-center">
                        <span className="text-white text-[10px] font-medium">
                          {user.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <span className="text-xs text-white">{user.name}</span>
                    <button
                      onClick={() => toggleUser(user.id)}
                      className="ml-1 text-hud-cream-dim hover:text-white transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search users to add..."
              className="w-full pl-9 pr-4 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
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
                  <Users className="w-6 h-6 text-hud-cream-mute" />
                </div>
                <p className="text-sm text-hud-cream-dim">
                  {searchQuery ? 'No users found' : 'No users available'}
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-hud-bg-elev">
              {filteredUsers.map((user) => {
                const isSelected = selectedUserIds.has(user.id);
                return (
                  <button
                    key={user.id}
                    onClick={() => toggleUser(user.id)}
                    className={`w-full p-4 hover:bg-hud-bg-elev/50 transition-colors text-left flex items-center gap-3 ${
                      isSelected ? 'bg-hud-bg-elev/30' : ''
                    }`}
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

                    {isSelected && (
                      <div className="flex-shrink-0">
                        <div className="w-5 h-5 rounded-full bg-hud-gold-deep flex items-center justify-center">
                          <Check size={14} className="text-white" />
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-hud-bg-elev flex items-center justify-between">
          <p className="text-sm text-hud-cream-dim">
            {selectedUserIds.size > 0
              ? `${selectedUserIds.size} member${selectedUserIds.size !== 1 ? 's' : ''} selected`
              : 'Select at least one member'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute text-white rounded-lg transition-colors"
              disabled={creating}
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!groupName.trim() || selectedUserIds.size === 0 || creating}
              className="px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold-deep text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {creating && <Loader2 size={16} className="animate-spin" />}
              Create Group
            </button>
          </div>
        </div>
      </div>
    </div></Portal>
  );
}

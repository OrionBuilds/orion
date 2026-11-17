import { useState } from 'react';
import { X, UserCheck, Loader2, Search } from 'lucide-react';
import type { User } from '../../types';
import { Portal } from '../shared/Portal';

interface BulkAssignOwnerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAssign: (ownerId: string | null) => Promise<void>;
  users: User[];
  selectedCount: number;
}

export function BulkAssignOwnerModal({
  isOpen,
  onClose,
  onAssign,
  users,
  selectedCount,
}: BulkAssignOwnerModalProps) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const filteredUsers = users.filter(
    (user) =>
      user.status === 'active' &&
      (user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        user.email.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleSubmit = async () => {
    setIsLoading(true);
    try {
      await onAssign(selectedUserId);
      onClose();
    } catch (error) {
      console.error('Failed to assign owner:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} /></Portal>
      <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-hud-gold/10 flex items-center justify-center">
                <UserCheck className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Assign Owner</h2>
                <p className="text-sm text-hud-cream-dim">{selectedCount} contacts selected</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors">
              <X className="w-5 h-5 text-hud-cream-dim" />
            </button>
          </div>

          <div className="p-4">
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
            </div>

            <div className="max-h-64 overflow-y-auto space-y-1">
              <button
                type="button"
                onClick={() => setSelectedUserId(null)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${
                  selectedUserId === null
                    ? 'bg-hud-gold/10 border border-hud-gold/30'
                    : 'hover:bg-hud-bg-card border border-transparent'
                }`}
              >
                <div className="w-8 h-8 rounded-full bg-hud-bg-elev flex items-center justify-center">
                  <span className="text-sm text-hud-cream-dim">-</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Unassigned</p>
                  <p className="text-xs text-hud-cream-mute">Remove owner assignment</p>
                </div>
              </button>

              {filteredUsers.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors ${
                    selectedUserId === user.id
                      ? 'bg-hud-gold/10 border border-hud-gold/30'
                      : 'hover:bg-hud-bg-card border border-transparent'
                  }`}
                >
                  {user.avatar_url ? (
                    <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal flex items-center justify-center">
                      <span className="text-sm font-medium text-white">
                        {user.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-medium text-white">{user.name}</p>
                    <p className="text-xs text-hud-cream-mute">{user.email}</p>
                  </div>
                </button>
              ))}

              {filteredUsers.length === 0 && (
                <div className="text-center py-4">
                  <p className="text-sm text-hud-cream-mute">No users found</p>
                </div>
              )}
            </div>
          </div>

          <div className="p-4 border-t border-hud-bg-card flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isLoading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-gold text-hud-bg-deep font-medium hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Assigning...
                </>
              ) : (
                'Assign Owner'
              )}
            </button>
          </div>
        </div>
      </div></Portal>
    </>
  );
}

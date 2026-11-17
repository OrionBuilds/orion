import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { deleteCalendar } from '../../../services/calendars';
import type { Calendar } from '../../../types';
import { Portal } from '../../shared/Portal';

interface DeleteCalendarModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  calendar: Calendar | null;
}

export function DeleteCalendarModal({
  open,
  onClose,
  onConfirm,
  calendar,
}: DeleteCalendarModalProps) {
  const { user } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  if (!open || !calendar) return null;

  const handleDelete = async () => {
    if (!user) return;

    setError('');
    setDeleting(true);

    try {
      await deleteCalendar(calendar.id, user);
      onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete calendar');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Portal><div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} /></Portal>
      <Portal><div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div
          className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-hud-plum/20 rounded-lg flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-hud-plum" />
              </div>
              <h2 className="text-lg font-semibold text-white">Delete Calendar</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-hud-cream-dim hover:text-white rounded"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6 space-y-4">
            {error && (
              <div className="p-3 bg-hud-plum/20 border border-hud-plum/30 rounded-lg text-hud-plum text-sm">
                {error}
              </div>
            )}

            <p className="text-hud-cream-soft">
              Are you sure you want to delete the calendar{' '}
              <span className="text-white font-semibold">"{calendar.name}"</span>?
            </p>
            <p className="text-hud-cream-dim text-sm">
              This action cannot be undone.
            </p>
          </div>

          <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
            <button
              onClick={onClose}
              disabled={deleting}
              className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors disabled:opacity-50"
            >
              No, Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-4 py-2 bg-hud-plum text-white rounded-lg font-medium hover:bg-hud-plum transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {deleting && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              {deleting ? 'Deleting...' : 'Yes, Delete'}
            </button>
          </div>
        </div>
      </div></Portal>
    </>
  );
}

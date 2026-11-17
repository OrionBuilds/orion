import { useState } from 'react';
import { X, UserPlus, Layers, Trophy, XCircle, Download, ChevronDown } from 'lucide-react';
import type { User, PipelineStage } from '../../types';

interface BulkActionsToolbarProps {
  selectedCount: number;
  users: User[];
  stages: PipelineStage[];
  onClearSelection: () => void;
  onAssignOwner: (userId: string | null) => Promise<void>;
  onChangeStage: (stageId: string) => Promise<void>;
  onMarkWon: () => Promise<void>;
  onMarkLost: () => void;
  onExport: () => void;
  canClose: boolean;
  canMove: boolean;
}

export function BulkActionsToolbar({
  selectedCount,
  users,
  stages,
  onClearSelection,
  onAssignOwner,
  onChangeStage,
  onMarkWon,
  onMarkLost,
  onExport,
  canClose,
  canMove
}: BulkActionsToolbarProps) {
  const [showOwnerDropdown, setShowOwnerDropdown] = useState(false);
  const [showStageDropdown, setShowStageDropdown] = useState(false);
  const [processing, setProcessing] = useState(false);

  const handleAssignOwner = async (userId: string | null) => {
    setProcessing(true);
    try {
      await onAssignOwner(userId);
    } finally {
      setProcessing(false);
      setShowOwnerDropdown(false);
    }
  };

  const handleChangeStage = async (stageId: string) => {
    setProcessing(true);
    try {
      await onChangeStage(stageId);
    } finally {
      setProcessing(false);
      setShowStageDropdown(false);
    }
  };

  const handleMarkWon = async () => {
    setProcessing(true);
    try {
      await onMarkWon();
    } finally {
      setProcessing(false);
    }
  };

  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
      <div className="flex items-center gap-2 px-4 py-3 bg-hud-bg-card border border-hud-cream-mute rounded-xl shadow-xl">
        <div className="flex items-center gap-2 pr-3 border-r border-hud-cream-mute">
          <span className="text-sm text-white font-medium">{selectedCount} selected</span>
          <button
            onClick={onClearSelection}
            className="p-1 hover:bg-hud-bg-elev rounded"
            title="Clear selection"
          >
            <X className="w-4 h-4 text-hud-cream-dim" />
          </button>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowOwnerDropdown(!showOwnerDropdown)}
            disabled={processing}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded disabled:opacity-50"
          >
            <UserPlus className="w-4 h-4" />
            Assign
            <ChevronDown className="w-3 h-3" />
          </button>
          {showOwnerDropdown && (
            <div className="absolute bottom-full mb-1 left-0 w-48 bg-hud-bg-elev border border-hud-cream-mute rounded-lg shadow-xl overflow-hidden">
              <button
                onClick={() => handleAssignOwner(null)}
                className="w-full px-3 py-2 text-left text-sm text-hud-cream-soft hover:bg-hud-cream-mute"
              >
                Unassign
              </button>
              <div className="border-t border-hud-cream-mute" />
              {users.map(user => (
                <button
                  key={user.id}
                  onClick={() => handleAssignOwner(user.id)}
                  className="w-full px-3 py-2 text-left text-sm text-white hover:bg-hud-cream-mute"
                >
                  {user.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {canMove && (
          <div className="relative">
            <button
              onClick={() => setShowStageDropdown(!showStageDropdown)}
              disabled={processing}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded disabled:opacity-50"
            >
              <Layers className="w-4 h-4" />
              Move Stage
              <ChevronDown className="w-3 h-3" />
            </button>
            {showStageDropdown && (
              <div className="absolute bottom-full mb-1 left-0 w-48 bg-hud-bg-elev border border-hud-cream-mute rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto">
                {stages.map(stage => (
                  <button
                    key={stage.id}
                    onClick={() => handleChangeStage(stage.id)}
                    className="w-full px-3 py-2 text-left text-sm text-white hover:bg-hud-cream-mute"
                  >
                    {stage.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {canClose && (
          <>
            <button
              onClick={handleMarkWon}
              disabled={processing}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-hud-emerald hover:bg-hud-emerald/20 rounded disabled:opacity-50"
            >
              <Trophy className="w-4 h-4" />
              Mark Won
            </button>

            <button
              onClick={onMarkLost}
              disabled={processing}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-hud-plum hover:bg-hud-plum/20 rounded disabled:opacity-50"
            >
              <XCircle className="w-4 h-4" />
              Mark Lost
            </button>
          </>
        )}

        <div className="w-px h-6 bg-hud-cream-mute" />

        <button
          onClick={onExport}
          disabled={processing}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-hud-cream-soft hover:bg-hud-bg-elev rounded disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          Export
        </button>
      </div>
    </div>
  );
}

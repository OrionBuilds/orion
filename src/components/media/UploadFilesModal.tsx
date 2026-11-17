import { useState, useRef, useCallback } from 'react';
import { X, Upload, File, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { uploadFileToDrive } from '../../services/googleDrive';
import { useFilesProvider } from '../../hooks/useFilesProvider';
import { PROVIDER_LABELS } from '../../services/connectedProvider';
import { Portal } from '../shared/Portal';

interface UploadFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
  parentId: string;
  driveId?: string;
  onUploadComplete: () => void;
}

interface UploadItem {
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

export default function UploadFilesModal({
  isOpen,
  onClose,
  parentId,
  driveId,
  onUploadComplete,
}: UploadFilesModalProps) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const { provider: primary } = useFilesProvider();
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newItems: UploadItem[] = Array.from(files).map((file) => ({
      file,
      status: 'pending' as const,
    }));
    setItems((prev) => [...prev, ...newItems]);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handleUploadAll = async () => {
    setUploading(true);
    const updated = [...items];

    for (let i = 0; i < updated.length; i++) {
      if (updated[i].status !== 'pending') continue;
      updated[i] = { ...updated[i], status: 'uploading' };
      setItems([...updated]);

      try {
        await uploadFileToDrive(updated[i].file, parentId, driveId);
        updated[i] = { ...updated[i], status: 'done' };
      } catch (err) {
        updated[i] = { ...updated[i], status: 'error', error: (err as Error).message };
      }
      setItems([...updated]);
    }

    setUploading(false);
    onUploadComplete();
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClose = () => {
    if (!uploading) {
      setItems([]);
      onClose();
    }
  };

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const doneCount = items.filter((i) => i.status === 'done').length;

  if (!isOpen) return null;

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative bg-hud-bg-card rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden border border-hud-bg-elev">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-hud-gold/10 flex items-center justify-center">
              <Upload className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <h3 className="text-base font-semibold text-white">Upload Files</h3>
          </div>
          <button onClick={handleClose} disabled={uploading} className="p-1.5 hover:bg-hud-bg-elev rounded-lg transition-colors disabled:opacity-50">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-6">
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
              dragOver
                ? 'border-hud-gold bg-hud-gold/5'
                : 'border-hud-cream-mute hover:border-hud-cream-mute bg-hud-bg-mid/50'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <Upload className="w-10 h-10 text-hud-cream-mute mx-auto mb-3" />
            <p className="text-sm text-hud-cream-dim mb-1">
              Drag and drop files here, or{' '}
              <button
                onClick={() => inputRef.current?.click()}
                className="text-hud-gold-soft font-medium hover:text-hud-gold-soft"
              >
                browse
              </button>
            </p>
            <p className="text-xs text-hud-cream-mute">Files will be uploaded to {primary ? PROVIDER_LABELS[primary].files : 'your file storage'}</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {items.length > 0 && (
            <div className="mt-4 max-h-60 overflow-y-auto space-y-2">
              {items.map((item, index) => (
                <div
                  key={`${item.file.name}-${index}`}
                  className="flex items-center gap-3 px-3 py-2.5 bg-hud-bg-mid/50 rounded-lg border border-hud-bg-elev"
                >
                  <File className="w-4 h-4 text-hud-cream-mute flex-shrink-0" />
                  <span className="text-sm text-hud-cream-soft truncate flex-1">{item.file.name}</span>
                  {item.status === 'uploading' && <Loader2 className="w-4 h-4 text-hud-gold-soft animate-spin flex-shrink-0" />}
                  {item.status === 'done' && <CheckCircle className="w-4 h-4 text-hud-emerald flex-shrink-0" />}
                  {item.status === 'error' && (
                    <span title={item.error}><AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" /></span>
                  )}
                  {item.status === 'pending' && !uploading && (
                    <button onClick={() => removeItem(index)} className="p-0.5 hover:bg-hud-bg-elev rounded">
                      <X className="w-3.5 h-3.5 text-hud-cream-mute" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-hud-bg-elev bg-hud-bg-mid/30">
            <p className="text-sm text-hud-cream-dim">
              {uploading
                ? `Uploading... ${doneCount}/${items.length}`
                : `${pendingCount} file${pendingCount !== 1 ? 's' : ''} ready`}
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleClose}
                disabled={uploading}
                className="px-4 py-2 text-sm font-medium text-hud-cream-soft hover:bg-hud-bg-elev rounded-lg transition-colors disabled:opacity-50"
              >
                {doneCount === items.length && items.length > 0 ? 'Done' : 'Cancel'}
              </button>
              {pendingCount > 0 && (
                <button
                  onClick={handleUploadAll}
                  disabled={uploading}
                  className="px-4 py-2 text-sm font-medium text-white hover:text-hud-bg-deep bg-hud-gold-deep hover:bg-hud-gold rounded-lg transition-colors disabled:opacity-50"
                >
                  {uploading ? 'Uploading...' : `Upload ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div></Portal>
  );
}

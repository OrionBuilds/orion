/**
 * Pick one folder for a project from Google Drive (My Drive or a shared drive) or Microsoft
 * (the SharePoint library or the user's OneDrive), through the caller's own connection.
 * Browsing lists sub-folders only; "Use this folder" takes the folder currently open.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, FolderOpen, Loader2, X } from 'lucide-react';
import { Portal } from '../shared/Portal';
import { getErrorMessage } from '../../lib/errors';
import { getFilesProviderPreference, getMyProviderState, pickProvider, PROVIDER_LABELS, type WorkspaceProvider } from '../../services/connectedProvider';
import { listPickerDrives, listPickerFolders, type GoogleDriveFileInfo, type PickerDrive } from '../../services/googleDrive';
import type { PickedFolder } from '../../services/projectConnections';

interface Crumb { id: string; name: string; url: string | null }

export function ProjectFolderPicker({ onClose, onPick }: { onClose: () => void; onPick: (f: PickedFolder) => void }) {
  const [connected, setConnected] = useState<WorkspaceProvider[] | null>(null);
  const [provider, setProvider] = useState<WorkspaceProvider | null>(null);
  const [drives, setDrives] = useState<PickerDrive[]>([]);
  const [drive, setDrive] = useState<PickerDrive | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<GoogleDriveFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMyProviderState()
      .then((s) => {
        setConnected(s.connected);
        // Start on the drive the user works in (their saved choice), not just the resolver's default.
        setProvider(pickProvider(s.connected, { prefer: getFilesProviderPreference(), orgDefault: s.orgDefault }));
      })
      .catch((e) => setError(getErrorMessage(e)));
  }, []);

  useEffect(() => {
    if (!provider) return;
    setDrives([]);
    setDrive(null);
    setLoading(true);
    setError(null);
    listPickerDrives(provider)
      .then((d) => {
        setDrives(d);
        setDrive(d[0] ?? null);
      })
      .catch((e) => setError(getErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [provider]);

  useEffect(() => {
    setPath(drive ? [{ id: drive.rootId, name: drive.name, url: null }] : []);
  }, [drive]);

  const current = path[path.length - 1];
  useEffect(() => {
    if (!provider || !drive || !current) return;
    let live = true;
    setLoading(true);
    setError(null);
    listPickerFolders(provider, drive.id, current.id)
      .then((f) => live && setFolders(f))
      .catch((e) => live && setError(getErrorMessage(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [provider, drive, current]);

  const atRoot = path.length <= 1;
  const use = () => {
    if (!provider || !drive || !current || atRoot) return;
    onPick({
      provider,
      driveId: drive.id,
      id: current.id,
      name: path.map((c) => c.name).join(' / '),
      url: current.url,
    });
  };

  return (
    <Portal>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div
          className="bg-hud-bg-card border border-hud-bg-elev rounded-xl w-full max-w-lg max-h-[80dvh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
            <h2 className="text-white font-semibold">Choose the project folder</h2>
            <button onClick={onClose} className="p-1 text-hud-cream-dim hover:text-white" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-3 space-y-3 border-b border-hud-bg-elev">
            {connected && connected.length === 0 ? (
              <p className="text-sm text-hud-cream-soft">
                Connect Google Workspace or Microsoft 365 first in{' '}
                <a href="/settings/profile?tab=connected-accounts" className="text-hud-gold-soft underline">
                  Connected accounts
                </a>
                .
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(['google', 'microsoft'] as WorkspaceProvider[]).map((p) => (
                  <button
                    key={p}
                    disabled={!connected?.includes(p)}
                    onClick={() => setProvider(p)}
                    title={connected?.includes(p) ? undefined : `Connect ${PROVIDER_LABELS[p].suite} in Connected accounts`}
                    className={`px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-40 ${
                      provider === p ? 'border-hud-gold text-white bg-hud-gold/10' : 'border-hud-bg-elev text-hud-cream-soft hover:text-white'
                    }`}
                  >
                    {p === 'google' ? 'Google Drive' : 'SharePoint / OneDrive'}
                  </button>
                ))}
                {drives.length > 1 && (
                  <select
                    value={drive?.id ?? ''}
                    onChange={(e) => setDrive(drives.find((d) => (d.id ?? '') === e.target.value) ?? null)}
                    className="ml-auto bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-xs text-white px-2 py-1.5"
                    aria-label="Drive"
                  >
                    {drives.map((d) => (
                      <option key={d.id ?? 'my-drive'} value={d.id ?? ''}>{d.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {path.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-xs text-hud-cream-dim">
                {path.map((c, i) => (
                  <span key={`${c.id}-${i}`} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="w-3 h-3" />}
                    <button onClick={() => setPath(path.slice(0, i + 1))} className="hover:text-white truncate max-w-[10rem]">
                      {c.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[12rem]">
            {error && <p className="px-3 py-2 text-sm text-hud-plum">{error}</p>}
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-hud-cream-dim" />
              </div>
            ) : (
              !error &&
              current &&
              (folders.length === 0 ? (
                <p className="px-3 py-6 text-sm text-hud-cream-mute text-center">No sub-folders here.</p>
              ) : (
                folders.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setPath([...path, { id: f.id, name: f.name, url: f.webViewLink ?? null }])}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white text-left"
                  >
                    <FolderOpen className="w-4 h-4 text-hud-gold-soft flex-none" />
                    <span className="truncate">{f.name}</span>
                    <ChevronRight className="w-3.5 h-3.5 ml-auto text-hud-cream-mute flex-none" />
                  </button>
                ))
              ))
            )}
          </div>

          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-hud-bg-elev">
            <p className="text-xs text-hud-cream-mute truncate">{atRoot ? 'Open the folder to use' : current?.name}</p>
            <button
              onClick={use}
              disabled={atRoot}
              className="px-3 py-2 rounded-lg text-sm bg-hud-gold-deep text-white disabled:opacity-40"
            >
              Use this folder
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Search,
  Paperclip,
  File,
  FileText,
  FileImage,
  FileSpreadsheet,
  Folder,
  Check,
  CheckCircle,
  AlertCircle,
  ChevronRight,
  HardDrive,
  Users,
  Loader2,
  Upload,
} from 'lucide-react';
import type { FileAttachmentEntityType } from '../../types';
import type { GoogleDriveFileInfo, SharedDriveInfo } from '../../services/googleDrive';
import {
  listDriveFilesViaApi,
  listSharedWithMeViaApi,
  listSharedDrives,
  searchDriveFilesViaApi,
  getConnectionStatus,
  getFilesProvider,
  getFileTypeCategory,
  isFolder,
  uploadFileToDrive,
} from '../../services/googleDrive';
import { PROVIDER_LABELS, type WorkspaceProvider } from '../../services/connectedProvider';
import { upsertDriveFile } from '../../services/driveFiles';
import DriveSwitcher from './DriveSwitcher';
import { MicrosoftAccountSelect } from '../shared/MicrosoftAccountSelect';
import { GoogleAccountSelect } from '../shared/GoogleAccountSelect';
import { useFilesProvider } from '../../hooks/useFilesProvider';
import { attachFile } from '../../services/fileAttachments';
import { useAuth } from '../../contexts/AuthContext';
import { formatFileSize } from '../../utils/formatters';
import { Portal } from '../shared/Portal';

interface AttachFileModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityType: FileAttachmentEntityType;
  entityId: string;
  organizationId: string;
  onAttached: () => void;
}

type TabId = 'my-drive' | 'shared' | 'shared-drives';

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface UploadTarget {
  parentId: string;
  label: string;
}

interface UploadItem {
  key: string;
  name: string;
  size: number;
  destination: string;
  status: 'pending' | 'uploading' | 'attaching' | 'done' | 'error';
  error?: string;
}

// drive-api and sharepoint-api buffer the whole upload in edge-function memory (drive-api copies it
// again into a multipart body), so device uploads are capped well below the runtime's memory limit.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// A listing that hasn't answered by now is reported as an error instead of spinning indefinitely.
const LIST_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function getFileIcon(mimeType: string) {
  const category = getFileTypeCategory(mimeType);
  switch (category) {
    case 'image': return FileImage;
    case 'spreadsheet': return FileSpreadsheet;
    case 'document':
    case 'pdf': return FileText;
    default: return File;
  }
}

function getFileIconColor(mimeType: string): string {
  const category = getFileTypeCategory(mimeType);
  switch (category) {
    case 'image': return 'text-hud-emerald';
    case 'spreadsheet': return 'text-green-400';
    case 'pdf': return 'text-hud-plum';
    case 'document': return 'text-blue-400';
    case 'presentation': return 'text-orange-400';
    case 'video': return 'text-pink-400';
    case 'audio': return 'text-hud-gold-soft';
    default: return 'text-hud-cream-dim';
  }
}

function uploadStatusText(item: UploadItem): string {
  switch (item.status) {
    case 'pending': return 'Waiting...';
    case 'uploading': return `Uploading to ${item.destination}...`;
    case 'attaching': return 'Attaching...';
    case 'done': return `Uploaded to ${item.destination} and attached`;
    case 'error': return item.error || 'Upload failed';
  }
}

export default function AttachFileModal({
  isOpen,
  onClose,
  entityType,
  entityId,
  organizationId,
  onAttached,
}: AttachFileModalProps) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>('my-drive');
  const [files, setFiles] = useState<GoogleDriveFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<Map<string, GoogleDriveFileInfo>>(new Map());
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [driveConnected, setDriveConnected] = useState<boolean | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [provider, setProvider] = useState<WorkspaceProvider | null>(null);
  const { options: driveOptions, select: selectDrive, msAccounts, showAccounts, connectionId: filesConnectionId, selectConnection, googleAccounts, showGoogleAccounts, googleConnectionId, selectGoogleConnection } = useFilesProvider();

  const [sharedDrives, setSharedDrives] = useState<SharedDriveInfo[]>([]);
  const [loadingSharedDrives, setLoadingSharedDrives] = useState(false);
  const [selectedSharedDrive, setSelectedSharedDrive] = useState<SharedDriveInfo | null>(null);

  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bumped by every listing request; a response is applied only if it is still the latest, so a
  // slow, superseded request can neither overwrite the current list nor clear its spinner early.
  const loadSeqRef = useRef(0);

  useEffect(() => {
    if (!isOpen) {
      // The modal stays mounted while closed. Forget the connection now so the open render's
      // effects don't fire a listing with the previous session's provider and folder state.
      loadSeqRef.current++;
      setDriveConnected(null);
      return;
    }
    loadSeqRef.current++;
    setSelectedFiles(new Map());
    setNote('');
    setError(null);
    setSearch('');
    setDebouncedSearch('');
    setBreadcrumbs([]);
    setActiveTab('my-drive');
    setSelectedSharedDrive(null);
    setSharedDrives([]);
    setUploads([]);
    setDragOver(false);
    setDriveConnected(null);
    checkConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset once per open (and when the user loads)
  }, [isOpen, user?.id]);

  // One listing per state change. Tab switches, folder navigation and the open-time reset each
  // change several of these at once; React batches them into a single run.
  useEffect(() => {
    if (driveConnected && isOpen) {
      if (activeTab === 'shared-drives' && !selectedSharedDrive && !debouncedSearch) {
        loadSharedDrivesList();
      } else {
        loadFiles();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the loaders read exactly this state
  }, [activeTab, debouncedSearch, driveConnected, isOpen, breadcrumbs, selectedSharedDrive]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 400);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  const isMicrosoft = provider === 'microsoft';
  const storageLabel = provider ? PROVIDER_LABELS[provider].files : 'file storage';
  // Microsoft's facade browses one library (SharePoint, or the user's OneDrive when none is
  // configured) and has no shared-drives / shared-with-me surfaces, so it gets a single root.
  const rootLabel = isMicrosoft ? PROVIDER_LABELS.microsoft.files : 'My Drive';
  const timeoutMessage = `${storageLabel} took too long to respond. Please try again.`;

  const checkConnection = async () => {
    if (!user) return;
    setCheckingConnection(true);
    try {
      const [filesProvider, status] = await Promise.all([
        getFilesProvider(),
        getConnectionStatus(user.id),
      ]);
      setProvider(filesProvider);
      setDriveConnected(status.connected);
    } catch {
      setDriveConnected(false);
    } finally {
      setCheckingConnection(false);
    }
  };

  // Switching drive: the picked files, folders and listings belong to the other drive, so start clean.
  const switchAccount = (id: string) => {
    if (id === filesConnectionId || !selectConnection(id)) return;
    resetForDriveChange();
  };

  const switchGoogleAccount = (id: string) => {
    if (id === googleConnectionId || !selectGoogleConnection(id)) return;
    resetForDriveChange();
  };

  const switchDrive = (p: WorkspaceProvider) => {
    if (!selectDrive(p)) return;
    resetForDriveChange();
  };

  const resetForDriveChange = () => {
    loadSeqRef.current++;
    setSelectedFiles(new Map());
    setError(null);
    setSearch('');
    setDebouncedSearch('');
    setBreadcrumbs([]);
    setActiveTab('my-drive');
    setSelectedSharedDrive(null);
    setSharedDrives([]);
    setDriveConnected(null);
    checkConnection();
  };

  const loadSharedDrivesList = async () => {
    const seq = ++loadSeqRef.current;
    setLoadingSharedDrives(true);
    setLoading(false);
    setError(null);
    try {
      const drives = await withTimeout(listSharedDrives(), LIST_TIMEOUT_MS, timeoutMessage);
      if (seq !== loadSeqRef.current) return;
      setSharedDrives(drives);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to load shared drives';
      setError(msg);
    } finally {
      if (seq === loadSeqRef.current) setLoadingSharedDrives(false);
    }
  };

  const fetchFileList = (): Promise<{ files: GoogleDriveFileInfo[]; nextPageToken?: string }> => {
    if (debouncedSearch) {
      return searchDriveFilesViaApi(debouncedSearch).then((results) => ({ files: results }));
    }
    if (activeTab === 'my-drive') {
      const folderId = breadcrumbs.length > 0
        ? breadcrumbs[breadcrumbs.length - 1].id
        : 'root';
      return listDriveFilesViaApi(folderId);
    }
    if (activeTab === 'shared-drives' && selectedSharedDrive) {
      const folderId = breadcrumbs.length > 0
        ? breadcrumbs[breadcrumbs.length - 1].id
        : selectedSharedDrive.id;
      return listDriveFilesViaApi(folderId, undefined, selectedSharedDrive.id);
    }
    if (activeTab === 'shared') {
      return listSharedWithMeViaApi();
    }
    return Promise.resolve({ files: [] });
  };

  const loadFiles = async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadingSharedDrives(false);
    setError(null);
    setFiles([]);
    setNextPageToken(undefined);

    try {
      const result = await withTimeout(fetchFileList(), LIST_TIMEOUT_MS, timeoutMessage);
      if (seq !== loadSeqRef.current) return;
      setFiles(result.files);
      setNextPageToken(debouncedSearch ? undefined : result.nextPageToken);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      setError(msg);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  const handleLoadMore = async () => {
    if (!nextPageToken || loadingMore) return;
    const seq = loadSeqRef.current;
    setLoadingMore(true);
    try {
      let result: { files: GoogleDriveFileInfo[]; nextPageToken?: string };
      if (activeTab === 'my-drive') {
        const folderId = breadcrumbs.length > 0
          ? breadcrumbs[breadcrumbs.length - 1].id
          : 'root';
        result = await listDriveFilesViaApi(folderId, nextPageToken);
      } else if (activeTab === 'shared-drives' && selectedSharedDrive) {
        const folderId = breadcrumbs.length > 0
          ? breadcrumbs[breadcrumbs.length - 1].id
          : selectedSharedDrive.id;
        result = await listDriveFilesViaApi(folderId, nextPageToken, selectedSharedDrive.id);
      } else {
        result = await listSharedWithMeViaApi(nextPageToken);
      }
      if (seq !== loadSeqRef.current) return;
      setFiles((prev) => [...prev, ...result.files]);
      setNextPageToken(result.nextPageToken);
    } catch (err) {
      console.error('Failed to load more files:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const navigateToFolder = useCallback((folder: GoogleDriveFileInfo) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSearch('');
    setDebouncedSearch('');
  }, []);

  const navigateToBreadcrumb = useCallback((index: number) => {
    if (index < 0) {
      setBreadcrumbs([]);
    } else {
      setBreadcrumbs((prev) => prev.slice(0, index + 1));
    }
    setSearch('');
    setDebouncedSearch('');
  }, []);

  const handleSelectSharedDrive = (drive: SharedDriveInfo) => {
    setSelectedSharedDrive(drive);
    setBreadcrumbs([]);
    setSearch('');
    setDebouncedSearch('');
  };

  const handleBackToSharedDrivesList = () => {
    setSelectedSharedDrive(null);
    setBreadcrumbs([]);
    setSearch('');
    setDebouncedSearch('');
  };

  const toggleFile = (file: GoogleDriveFileInfo) => {
    if (isFolder(file.mimeType)) {
      navigateToFolder(file);
      return;
    }
    const newSelected = new Map(selectedFiles);
    if (newSelected.has(file.id)) {
      newSelected.delete(file.id);
    } else {
      newSelected.set(file.id, file);
    }
    setSelectedFiles(newSelected);
  };

  /** Records a storage file and links it to the entity (same path for picked and uploaded files). */
  const attachDriveFile = async (file: GoogleDriveFileInfo) => {
    if (!user) throw new Error('Not signed in');
    const driveFile = await upsertDriveFile(user.id, organizationId, file, undefined, provider ?? undefined);
    await attachFile(
      organizationId,
      driveFile.id,
      entityType,
      entityId,
      user.id,
      note || undefined
    );
  };

  const handleAttach = async () => {
    if (selectedFiles.size === 0 || !user) return;

    setAttaching(true);
    setError(null);

    try {
      for (const [, file] of selectedFiles) {
        await attachDriveFile(file);
      }
      onAttached();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to attach files';
      setError(msg);
    } finally {
      setAttaching(false);
    }
  };

  const currentFolder = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1] : null;
  // Uploads land in the folder open in the browser; anywhere without one (Shared Files, the
  // shared-drives list) they go to the root of the user's storage. A shared-drive folder id is
  // enough for drive-api (supportsAllDrives), so no driveId is sent.
  const uploadTarget: UploadTarget =
    activeTab === 'shared-drives' && selectedSharedDrive
      ? { parentId: currentFolder?.id ?? selectedSharedDrive.id, label: currentFolder?.name ?? selectedSharedDrive.name }
      : activeTab === 'my-drive' && currentFolder
        ? { parentId: currentFolder.id, label: currentFolder.name }
        : { parentId: 'root', label: rootLabel };

  const handleDeviceFiles = async (fileList: FileList | File[], target: UploadTarget) => {
    const picked = Array.from(fileList);
    if (picked.length === 0 || !user || uploading) return;

    const batchId = Date.now();
    const items: UploadItem[] = picked.map((file, i) => {
      const tooBig = file.size > MAX_UPLOAD_BYTES;
      return {
        key: `${batchId}-${i}`,
        name: file.name,
        size: file.size,
        destination: target.label,
        status: tooBig ? 'error' : 'pending',
        error: tooBig ? `Larger than the ${formatFileSize(MAX_UPLOAD_BYTES)} upload limit` : undefined,
      };
    });
    const update = (key: string, patch: Partial<UploadItem>) =>
      setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...patch } : u)));

    setUploads((prev) => [...prev, ...items]);
    setError(null);
    setUploading(true);

    let attachedCount = 0;
    let failedCount = items.filter((item) => item.status === 'error').length;

    // Sequential, like the Media upload modal: each file is buffered whole by the edge function.
    for (let i = 0; i < picked.length; i++) {
      const item = items[i];
      if (item.status === 'error') continue;
      try {
        update(item.key, { status: 'uploading' });
        const uploaded = await uploadFileToDrive(picked[i], target.parentId);
        update(item.key, { status: 'attaching' });
        await attachDriveFile(uploaded);
        update(item.key, { status: 'done' });
        attachedCount++;
      } catch (err) {
        update(item.key, { status: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
        failedCount++;
      }
    }

    setUploading(false);
    if (attachedCount > 0) {
      onAttached();
      if (failedCount === 0 && selectedFiles.size === 0) onClose();
    }
  };

  const handleClose = () => {
    if (!uploading) onClose();
  };

  const canDropFiles = !!driveConnected && !checkingConnection && !uploading;

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    // Always claim file drags so a drop never makes the browser navigate to the file.
    e.preventDefault();
    e.dataTransfer.dropEffect = canDropFiles ? 'copy' : 'none';
    if (canDropFiles && !dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragOver(false);
    if (canDropFiles && e.dataTransfer.files.length > 0) {
      handleDeviceFiles(e.dataTransfer.files, uploadTarget);
    }
  };

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setBreadcrumbs([]);
    setSearch('');
    setDebouncedSearch('');
    setSelectedSharedDrive(null);
    setSharedDrives([]);
  };

  if (!isOpen) return null;

  const isSearching = debouncedSearch.length > 0;
  const displayFiles = files.filter((f) => !isSearching || !isFolder(f.mimeType));
  const showingSharedDrivesList = activeTab === 'shared-drives' && !selectedSharedDrive && !isSearching;
  const showTabs = !isSearching && !isMicrosoft;
  const uploadsInFlight = uploads.filter((u) => u.status === 'pending' || u.status === 'uploading' || u.status === 'attaching').length;

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-dvh px-4 pt-4 pb-20 text-center sm:p-0">
        <div
          className="fixed inset-0 bg-black/60 transition-opacity"
          onClick={handleClose}
        />

        <div className="relative inline-block w-full max-w-2xl my-8 overflow-hidden text-left align-middle transition-all transform bg-hud-bg-mid shadow-2xl rounded-xl border border-hud-bg-elev/50">
          <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev/50">
            <h3 className="text-lg font-semibold text-hud-cream">Attach Files</h3>
            <DriveSwitcher options={driveOptions} active={provider} onSelect={switchDrive} className="ml-auto mr-3" />
            {showAccounts && (
              <MicrosoftAccountSelect accounts={msAccounts} value={filesConnectionId} onChange={switchAccount} className="mr-3" />
            )}
            {showGoogleAccounts && (
              <GoogleAccountSelect accounts={googleAccounts} value={googleConnectionId} onChange={switchGoogleAccount} className="mr-3" />
            )}
            <button
              onClick={handleClose}
              disabled={uploading}
              className="p-1.5 hover:bg-hud-bg-card rounded-lg transition-colors disabled:opacity-50"
            >
              <X className="w-5 h-5 text-hud-cream-dim" />
            </button>
          </div>

          <div
            className="relative p-5"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {dragOver && (
              <div className="absolute inset-2 z-10 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-blue-500/60 bg-hud-bg-mid/90 pointer-events-none">
                <Upload className="w-8 h-8 text-blue-400 mb-2" />
                <p className="text-sm font-medium text-hud-cream-soft">Drop to upload and attach</p>
                <p className="text-xs text-hud-cream-mute mt-1">Files go to {uploadTarget.label}</p>
              </div>
            )}

            {checkingConnection ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
              </div>
            ) : !driveConnected ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="w-14 h-14 bg-hud-bg-card rounded-full flex items-center justify-center mb-4">
                  <HardDrive className="w-7 h-7 text-hud-cream-mute" />
                </div>
                <p className="text-hud-cream-soft font-medium mb-1">File storage not connected</p>
                <p className="text-sm text-hud-cream-mute mb-4">
                  Connect Google Workspace or Microsoft 365 in Settings to browse and attach files
                </p>
                <a
                  href="/settings/profile?tab=connected-accounts"
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-400 bg-blue-500/10 rounded-lg hover:bg-blue-500/20 transition-colors"
                >
                  <HardDrive className="w-4 h-4" />
                  Go to Settings
                </a>
              </div>
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                  <input
                    type="text"
                    placeholder={`Search ${storageLabel}...`}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft placeholder-hud-cream-dim focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-colors text-sm"
                  />
                </div>

                <div className={`flex flex-wrap items-center gap-1 ${isSearching ? 'mb-3' : 'mb-4'}`}>
                  {showTabs && (
                    <>
                      <button
                        onClick={() => handleTabChange('my-drive')}
                        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                          activeTab === 'my-drive'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'text-hud-cream-dim hover:bg-hud-bg-card border border-transparent'
                        }`}
                      >
                        <HardDrive className="w-4 h-4" />
                        My Drive
                      </button>
                      <button
                        onClick={() => handleTabChange('shared-drives')}
                        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                          activeTab === 'shared-drives'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'text-hud-cream-dim hover:bg-hud-bg-card border border-transparent'
                        }`}
                      >
                        <Users className="w-4 h-4" />
                        Shared Drives
                      </button>
                      <button
                        onClick={() => handleTabChange('shared')}
                        className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                          activeTab === 'shared'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                            : 'text-hud-cream-dim hover:bg-hud-bg-card border border-transparent'
                        }`}
                      >
                        <Folder className="w-4 h-4" />
                        Shared Files
                      </button>
                    </>
                  )}

                  {isSearching && (
                    <p className="text-xs text-hud-cream-mute">
                      Searching {storageLabel} for "{debouncedSearch}"
                    </p>
                  )}

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title={`Upload files from this device to ${uploadTarget.label} and attach them`}
                    className="ml-auto inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-blue-400 bg-blue-500/10 rounded-lg hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    Upload from device
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files) handleDeviceFiles(e.target.files, uploadTarget);
                      e.target.value = '';
                    }}
                  />
                </div>

                {!isSearching && activeTab === 'my-drive' && (
                  <div className="flex items-center gap-1 mb-3 text-sm overflow-x-auto">
                    <button
                      onClick={() => navigateToBreadcrumb(-1)}
                      className={`flex-shrink-0 px-1.5 py-0.5 rounded transition-colors ${
                        breadcrumbs.length === 0
                          ? 'text-hud-cream-soft font-medium'
                          : 'text-hud-cream-mute hover:text-hud-cream-soft'
                      }`}
                    >
                      {rootLabel}
                    </button>
                    {breadcrumbs.map((crumb, i) => (
                      <div key={crumb.id} className="flex items-center gap-1 flex-shrink-0">
                        <ChevronRight className="w-3.5 h-3.5 text-hud-cream-mute" />
                        <button
                          onClick={() => navigateToBreadcrumb(i)}
                          className={`px-1.5 py-0.5 rounded transition-colors truncate max-w-[140px] ${
                            i === breadcrumbs.length - 1
                              ? 'text-hud-cream-soft font-medium'
                              : 'text-hud-cream-mute hover:text-hud-cream-soft'
                          }`}
                          title={crumb.name}
                        >
                          {crumb.name}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!isSearching && activeTab === 'shared-drives' && selectedSharedDrive && (
                  <div className="flex items-center gap-1 mb-3 text-sm overflow-x-auto">
                    <button
                      onClick={handleBackToSharedDrivesList}
                      className="flex-shrink-0 px-1.5 py-0.5 rounded transition-colors text-hud-cream-mute hover:text-hud-cream-soft"
                    >
                      Shared Drives
                    </button>
                    <ChevronRight className="w-3.5 h-3.5 text-hud-cream-mute flex-shrink-0" />
                    <button
                      onClick={() => navigateToBreadcrumb(-1)}
                      className={`flex-shrink-0 px-1.5 py-0.5 rounded transition-colors truncate max-w-[140px] ${
                        breadcrumbs.length === 0
                          ? 'text-hud-cream-soft font-medium'
                          : 'text-hud-cream-mute hover:text-hud-cream-soft'
                      }`}
                      title={selectedSharedDrive.name}
                    >
                      {selectedSharedDrive.name}
                    </button>
                    {breadcrumbs.map((crumb, i) => (
                      <div key={crumb.id} className="flex items-center gap-1 flex-shrink-0">
                        <ChevronRight className="w-3.5 h-3.5 text-hud-cream-mute" />
                        <button
                          onClick={() => navigateToBreadcrumb(i)}
                          className={`px-1.5 py-0.5 rounded transition-colors truncate max-w-[140px] ${
                            i === breadcrumbs.length - 1
                              ? 'text-hud-cream-soft font-medium'
                              : 'text-hud-cream-mute hover:text-hud-cream-soft'
                          }`}
                          title={crumb.name}
                        >
                          {crumb.name}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {error && (
                  <div className="mb-4 p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-lg flex items-center gap-2 text-hud-plum">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm">{error}</span>
                  </div>
                )}

                {uploads.length > 0 && (
                  <div className="mb-4 border border-hud-bg-elev/50 rounded-lg max-h-40 overflow-y-auto bg-hud-bg-card/50 divide-y divide-hud-bg-elev/40">
                    {uploads.map((item) => (
                      <div key={item.key} className="flex items-center gap-3 px-3.5 py-2">
                        <File className="w-4 h-4 flex-shrink-0 text-hud-cream-mute" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-hud-cream-soft truncate">{item.name}</p>
                          <p
                            className={`text-xs mt-0.5 truncate ${item.status === 'error' ? 'text-hud-plum' : 'text-hud-cream-mute'}`}
                            title={uploadStatusText(item)}
                          >
                            {formatFileSize(item.size)} · {uploadStatusText(item)}
                          </p>
                        </div>
                        {(item.status === 'uploading' || item.status === 'attaching') && (
                          <Loader2 className="w-4 h-4 flex-shrink-0 text-blue-400 animate-spin" />
                        )}
                        {item.status === 'done' && (
                          <CheckCircle className="w-4 h-4 flex-shrink-0 text-hud-emerald" />
                        )}
                        {item.status === 'error' && (
                          <AlertCircle className="w-4 h-4 flex-shrink-0 text-hud-plum" />
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="border border-hud-bg-elev/50 rounded-lg max-h-80 overflow-y-auto bg-hud-bg-card/50">
                  {showingSharedDrivesList ? (
                    loadingSharedDrives ? (
                      <div className="p-10 text-center">
                        <Loader2 className="w-6 h-6 text-blue-400 animate-spin mx-auto" />
                        <p className="text-sm text-hud-cream-mute mt-3">Loading shared drives...</p>
                      </div>
                    ) : sharedDrives.length === 0 ? (
                      <div className="p-10 text-center">
                        <Users className="w-10 h-10 mx-auto text-hud-cream-mute mb-2" />
                        <p className="text-hud-cream-dim font-medium">No shared drives found</p>
                        <p className="text-sm text-hud-cream-mute mt-1">
                          You don't have access to any shared drives
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-hud-bg-elev/40">
                        {sharedDrives.map((drive) => (
                          <div
                            key={drive.id}
                            onClick={() => handleSelectSharedDrive(drive)}
                            className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-hud-bg-elev/40 transition-colors"
                          >
                            <Users className="w-5 h-5 flex-shrink-0 text-blue-400" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-hud-cream-soft truncate">{drive.name}</p>
                              <p className="text-xs text-hud-cream-mute mt-0.5">Shared Drive</p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-hud-cream-mute flex-shrink-0" />
                          </div>
                        ))}
                      </div>
                    )
                  ) : loading ? (
                    <div className="p-10 text-center">
                      <Loader2 className="w-6 h-6 text-blue-400 animate-spin mx-auto" />
                      <p className="text-sm text-hud-cream-mute mt-3">Loading files...</p>
                    </div>
                  ) : displayFiles.length === 0 ? (
                    <div className="p-10 text-center">
                      <Folder className="w-10 h-10 mx-auto text-hud-cream-mute mb-2" />
                      <p className="text-hud-cream-dim font-medium">
                        {isSearching ? 'No results found' : 'No files found'}
                      </p>
                      <p className="text-sm text-hud-cream-mute mt-1">
                        {isSearching
                          ? 'Try a different search term'
                          : activeTab === 'my-drive'
                            ? 'This folder is empty'
                            : activeTab === 'shared-drives'
                              ? 'This drive is empty'
                              : 'No files have been shared with you'
                        }
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-hud-bg-elev/40">
                      {displayFiles.map((file) => {
                        const isFolderItem = isFolder(file.mimeType);
                        const isSelected = selectedFiles.has(file.id);
                        const Icon = isFolderItem ? Folder : getFileIcon(file.mimeType);
                        const iconColor = isFolderItem ? 'text-blue-400' : getFileIconColor(file.mimeType);

                        return (
                          <div
                            key={file.id}
                            onClick={() => toggleFile(file)}
                            className={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors ${
                              isSelected
                                ? 'bg-blue-500/10'
                                : 'hover:bg-hud-bg-elev/40'
                            }`}
                          >
                            {!isFolderItem && (
                              <div
                                className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                                  isSelected
                                    ? 'bg-blue-500 border-blue-500'
                                    : 'border-hud-cream-mute hover:border-hud-cream-mute'
                                }`}
                              >
                                {isSelected && (
                                  <Check className="w-3 h-3 text-white" />
                                )}
                              </div>
                            )}
                            <Icon className={`w-5 h-5 flex-shrink-0 ${iconColor}`} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-hud-cream-soft truncate">
                                {file.name}
                              </p>
                              <div className="flex items-center gap-2 text-xs text-hud-cream-mute mt-0.5">
                                {!isFolderItem && file.size && (
                                  <span>{formatFileSize(parseInt(file.size, 10))}</span>
                                )}
                                {file.modifiedTime && (
                                  <span>
                                    {new Date(file.modifiedTime).toLocaleDateString()}
                                  </span>
                                )}
                                {file.owners?.[0]?.emailAddress && activeTab === 'shared' && (
                                  <span className="truncate">
                                    {file.owners[0].emailAddress}
                                  </span>
                                )}
                              </div>
                            </div>
                            {isFolderItem && (
                              <ChevronRight className="w-4 h-4 text-hud-cream-mute flex-shrink-0" />
                            )}
                          </div>
                        );
                      })}

                      {nextPageToken && !isSearching && (
                        <div className="p-3 text-center">
                          <button
                            onClick={handleLoadMore}
                            disabled={loadingMore}
                            className="inline-flex items-center gap-2 px-4 py-1.5 text-sm text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {loadingMore ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Loading...
                              </>
                            ) : (
                              'Load more'
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add a note (optional)..."
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-hud-cream-soft placeholder-hud-cream-dim focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 text-sm"
                  />
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between px-6 py-4 bg-hud-bg-card/50 border-t border-hud-bg-elev/50">
            <p className="text-sm text-hud-cream-mute">
              {uploading
                ? `Uploading ${uploadsInFlight} file${uploadsInFlight !== 1 ? 's' : ''}...`
                : `${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''} selected`}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleClose}
                disabled={uploading}
                className="px-4 py-2 text-sm font-medium text-hud-cream-dim hover:text-hud-cream-soft hover:bg-hud-bg-elev/50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploads.some((u) => u.status === 'done') && selectedFiles.size === 0 ? 'Done' : 'Cancel'}
              </button>
              <button
                onClick={handleAttach}
                disabled={selectedFiles.size === 0 || attaching || uploading}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {attaching ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Attaching...
                  </>
                ) : (
                  <>
                    <Paperclip className="w-4 h-4" />
                    Attach Files
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div></Portal>
  );
}

import { useState, useEffect } from 'react';
import {
  Paperclip,
  File,
  FileText,
  FileImage,
  FileSpreadsheet,
  ExternalLink,
  Trash2,
  AlertCircle,
  Plus,
  FolderOpen,
  Download,
} from 'lucide-react';
import type { FileAttachmentEntityType } from '../../types';
import { getAttachments, detachFile, type FileAttachmentWithFile } from '../../services/fileAttachments';
import { getFileTypeCategory } from '../../services/googleDrive';
import { isFileAvailable, getFileStatus, driveRowProvider } from '../../services/driveFiles';
import { usePermission } from '../../hooks/usePermission';
import AttachFileModal from './AttachFileModal';
import { formatFileSize } from '../../utils/formatters';
import { getStoredDocumentUrl } from '../../services/proposalSources';

/** Files the OS stores itself (SAM.gov solicitation documents) open via a short-lived signed URL. */
async function openStoredFile(file: { storage_path?: string | null }) {
  const url = await getStoredDocumentUrl(file).catch(() => null);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

interface EntityFilesTabProps {
  entityType: FileAttachmentEntityType;
  entityId: string;
  organizationId: string;
  /** Used in the empty-state copy, e.g. `contact` -> "organized with this contact". */
  entityLabel: string;
  onUpdate: () => void;
}

function getFileIcon(mimeType: string) {
  const category = getFileTypeCategory(mimeType);
  switch (category) {
    case 'image':
      return FileImage;
    case 'spreadsheet':
      return FileSpreadsheet;
    case 'document':
    case 'pdf':
      return FileText;
    default:
      return File;
  }
}

function getFileIconColor(mimeType: string): string {
  const category = getFileTypeCategory(mimeType);
  switch (category) {
    case 'image':
      return 'text-hud-emerald';
    case 'spreadsheet':
      return 'text-green-600';
    case 'pdf':
      return 'text-hud-plum';
    case 'document':
      return 'text-blue-500';
    default:
      return 'text-hud-cream-mute';
  }
}

/**
 * File-storage (Google Drive or SharePoint/OneDrive) attachments grid shared by the contact and opportunity detail tabs.
 */
export default function EntityFilesTab({
  entityType,
  entityId,
  organizationId,
  entityLabel,
  onUpdate,
}: EntityFilesTabProps) {
  const canManage = usePermission('media.manage');
  const [attachments, setAttachments] = useState<FileAttachmentWithFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [detaching, setDetaching] = useState<string | null>(null);

  useEffect(() => {
    loadAttachments();
  }, [entityType, entityId]);

  const loadAttachments = async () => {
    setLoading(true);
    try {
      const data = await getAttachments(entityType, entityId);
      setAttachments(data);
    } catch (err) {
      console.error('Failed to load attachments:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDetach = async (attachmentId: string) => {
    if (!confirm('Are you sure you want to detach this file? The file will remain in your file storage.')) {
      return;
    }

    setDetaching(attachmentId);
    try {
      await detachFile(attachmentId);
      await loadAttachments();
      onUpdate();
    } catch (err) {
      console.error('Failed to detach file:', err);
    } finally {
      setDetaching(null);
    }
  };

  const handleAttached = () => {
    loadAttachments();
    onUpdate();
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-hud-cream-soft rounded w-1/4" />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-hud-cream-soft rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-medium text-hud-bg-mid">Files</h3>
        {canManage && (
          <button
            onClick={() => setShowAttachModal(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Attach File
          </button>
        )}
      </div>

      {attachments.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-hud-cream-mute border-2 border-dashed border-hud-cream-soft rounded-lg">
          <FolderOpen className="w-12 h-12 text-hud-cream-soft mb-3" />
          <p className="text-lg font-medium mb-1">No files attached</p>
          <p className="text-sm text-hud-cream-dim mb-4">
            Attach files from your file storage to keep them organized with this {entityLabel}
          </p>
          {canManage && (
            <button
              onClick={() => setShowAttachModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-md hover:bg-blue-100"
            >
              <Paperclip className="w-4 h-4" />
              Attach Files
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {attachments.map((attachment) => {
            const file = attachment.drive_file;
            const Icon = getFileIcon(file.mime_type);
            const iconColor = getFileIconColor(file.mime_type);
            const available = isFileAvailable(file);
            const status = getFileStatus(file);

            return (
              <div
                key={attachment.id}
                className={`relative group bg-white rounded-lg border border-hud-cream-soft hover:border-hud-cream-soft hover:shadow-sm transition-all ${
                  !available ? 'opacity-60' : ''
                }`}
              >
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        available ? 'bg-hud-bg-elev' : 'bg-hud-cream'
                      }`}
                    >
                      {file.thumbnail_url && available ? (
                        <img
                          src={file.thumbnail_url}
                          alt={file.name}
                          className="w-8 h-8 object-cover rounded"
                        />
                      ) : (
                        <Icon className={`w-5 h-5 ${available ? iconColor : 'text-hud-cream-dim'}`} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4
                        className={`text-sm font-medium truncate ${
                          available ? 'text-hud-bg-mid' : 'text-hud-cream-mute'
                        }`}
                        title={file.name}
                      >
                        {file.name}
                      </h4>
                      <p className="text-xs text-hud-cream-mute mt-0.5">
                        {formatFileSize(file.size_bytes)}
                        {file.provider === 'sam_gov' && <span className="ml-1.5 text-hud-gold-deep">· SAM.gov</span>}
                      </p>
                      {attachment.note && (
                        <p className="text-xs text-hud-cream-dim mt-1 truncate" title={attachment.note}>
                          {attachment.note}
                        </p>
                      )}
                    </div>
                  </div>

                  {!available && (
                    <div className="mt-3 flex items-center gap-1 text-xs text-hud-rust">
                      <AlertCircle className="w-3 h-3" />
                      <span>
                        {status === 'deleted' ? 'File deleted' : 'Access revoked'}
                      </span>
                    </div>
                  )}
                </div>

                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity flex items-center gap-1">
                  {available && file.storage_path && (
                    <button
                      onClick={() => openStoredFile(file)}
                      className="p-1.5 bg-white rounded shadow-sm border border-hud-cream-soft hover:bg-hud-bg-elev"
                      title="Download"
                    >
                      <Download className="w-3.5 h-3.5 text-hud-cream-mute" />
                    </button>
                  )}
                  {available && file.web_view_link && (
                    <a
                      href={file.web_view_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 bg-white rounded shadow-sm border border-hud-cream-soft hover:bg-hud-bg-elev"
                      title={file.provider === 'sam_gov' ? 'Open the notice on SAM.gov' : driveRowProvider(file) === 'microsoft' ? 'Open in SharePoint' : 'Open in Google Drive'}
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-hud-cream-mute" />
                    </a>
                  )}
                  {canManage && (
                    <button
                      onClick={() => handleDetach(attachment.id)}
                      disabled={detaching === attachment.id}
                      className="p-1.5 bg-white rounded shadow-sm border border-hud-cream-soft hover:bg-hud-plum/10 hover:border-hud-plum/25"
                      title="Detach file"
                    >
                      {detaching === attachment.id ? (
                        <div className="w-3.5 h-3.5 border-2 border-hud-cream-soft border-t-hud-cream-mute rounded-full animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5 text-hud-cream-mute hover:text-hud-plum" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AttachFileModal
        isOpen={showAttachModal}
        onClose={() => setShowAttachModal(false)}
        entityType={entityType}
        entityId={entityId}
        organizationId={organizationId}
        onAttached={handleAttached}
      />
    </div>
  );
}

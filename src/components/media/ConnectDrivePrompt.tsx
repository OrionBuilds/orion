import type { ReactNode } from 'react';
import { HardDrive, Shield, FolderSync, Link2, AlertTriangle } from 'lucide-react';

interface ConnectDrivePromptProps {
  onConnect: () => void;
  loading?: boolean;
  error?: string | null;
  /** Optional drive switcher shown above the prompt, so the other drive can be picked from here. */
  switcher?: ReactNode;
}

export default function ConnectDrivePrompt({
  onConnect,
  loading,
  error,
  switcher,
}: ConnectDrivePromptProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-hud-bg-mid p-8">
      <div className="max-w-md w-full text-center">
        {switcher && <div className="flex justify-center mb-6">{switcher}</div>}
        <div className="w-20 h-20 bg-hud-gold/10 rounded-full flex items-center justify-center mx-auto mb-6 border border-hud-gold/20">
          <HardDrive className="w-10 h-10 text-hud-gold-soft" />
        </div>
        <h2 className="text-2xl font-semibold text-white mb-3">
          Connect your file storage
        </h2>

        <p className="text-hud-cream-dim mb-8">
          Connect Google Workspace or Microsoft 365 to browse, organize, and attach files from
          Google Drive or SharePoint/OneDrive directly in the CRM. Your files stay where they are
          &mdash; we just help you organize and attach them to your records.
        </p>

        <div className="grid grid-cols-1 gap-4 mb-8 text-left">
          <div className="flex items-start gap-3 p-4 bg-hud-bg-card rounded-lg border border-hud-bg-elev">
            <FolderSync className="w-5 h-5 text-hud-gold-soft flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-white">Use Your Folder Structure</h3>
              <p className="text-sm text-hud-cream-dim mt-0.5">
                Browse and use your existing folders - no new structure required
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 bg-hud-bg-card rounded-lg border border-hud-bg-elev">
            <Link2 className="w-5 h-5 text-hud-gold-soft flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-white">Attach to Records</h3>
              <p className="text-sm text-hud-cream-dim mt-0.5">
                Link files to contacts, opportunities, and other records for easy access
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 bg-hud-bg-card rounded-lg border border-hud-bg-elev">
            <Shield className="w-5 h-5 text-hud-gold-soft flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-medium text-white">Secure & Private</h3>
              <p className="text-sm text-hud-cream-dim mt-0.5">
                Files remain in your own storage. We only store references, not your actual files.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-hud-rust/10 border border-hud-rust/30 rounded-lg flex items-start gap-3 text-left">
            <AlertTriangle className="w-5 h-5 text-hud-rust flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-hud-rust/40">Unable to connect</p>
              <p className="text-sm text-hud-rust mt-0.5">{error}</p>
            </div>
          </div>
        )}

        <button
          onClick={onConnect}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-hud-gold-deep text-white hover:text-hud-bg-deep font-medium rounded-lg hover:bg-hud-gold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <HardDrive className="w-5 h-5" />
              Connect an account
            </>
          )}
        </button>

        <p className="text-xs text-hud-cream-mute mt-4">
          By connecting, you agree to grant this application access to view and manage files
          in the storage you connect (Google Drive or SharePoint/OneDrive).
        </p>
      </div>
    </div>
  );
}

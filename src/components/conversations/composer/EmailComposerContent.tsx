import { useState, useRef } from 'react';
import { ChevronDown, FileText, Link as LinkIcon, Image as ImageIcon, ClipboardList, X, Loader2, Paperclip } from 'lucide-react';
import { ComposerToolbar } from './ComposerToolbar';
import { ContactEmailAutocomplete } from './ContactEmailAutocomplete';
import { FormSurveyPicker, type PickerItem } from './FormSurveyPicker';
import { EmailSenderSelect, type SendVia } from './EmailSenderSelect';
import { LinkDialog } from './LinkDialog';
import type { EmailAttachment } from '../../../services/emailAttachments';
import { formatFileSize } from '../../../utils/formatters';
import type { MsAccount } from '../../../lib/microsoftAccounts';
import type { GoogleAccount } from '../../../lib/googleAccounts';

interface EmailRecipient {
  email: string;
  name: string;
  contactId?: string;
}

interface EmailComposerContentProps {
  body: string;
  onBodyChange: (body: string) => void;
  subject: string;
  onSubjectChange: (subject: string) => void;
  onSend: () => void;
  onClear: () => void;
  sending: boolean;
  sendDisabled: boolean;
  expanded: boolean;
  fromName: string;
  fromEmail: string;
  sendVia: SendVia;
  onSendViaChange: (v: SendVia) => void;
  gmailConnected: boolean;
  gmailAddress: string | null;
  microsoftConnected?: boolean;
  microsoftAddress?: string | null;
  microsoftAccounts?: MsAccount[];
  microsoftConnectionId?: string | null;
  onMicrosoftConnectionChange?: (connectionId: string) => void;
  googleAccounts?: GoogleAccount[];
  googleConnectionId?: string | null;
  onGoogleConnectionChange?: (connectionId: string) => void;
  sendgridName: string;
  sendgridEmail: string;
  toEmail: string;
  toName: string;
  ccRecipients: EmailRecipient[];
  onCcChange: (recipients: EmailRecipient[]) => void;
  bccRecipients: EmailRecipient[];
  onBccChange: (recipients: EmailRecipient[]) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSnippetClick: () => void;
  canUseSnippets: boolean;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  attachments: EmailAttachment[];
  onAttachFile: (file: File) => void;
  onRemoveAttachment: (index: number) => void;
  canAttach: boolean;
  uploadingAttachment?: boolean;
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function EmailComposerContent({
  body,
  onBodyChange,
  subject,
  onSubjectChange,
  onSend,
  onClear,
  sending,
  sendDisabled,
  expanded,
  sendVia,
  onSendViaChange,
  gmailConnected,
  gmailAddress,
  microsoftConnected,
  microsoftAddress,
  microsoftAccounts,
  microsoftConnectionId,
  onMicrosoftConnectionChange,
  googleAccounts,
  googleConnectionId,
  onGoogleConnectionChange,
  sendgridName,
  sendgridEmail,
  toEmail,
  toName,
  ccRecipients,
  onCcChange,
  bccRecipients,
  onBccChange,
  onKeyDown,
  onSnippetClick,
  canUseSnippets,
  textareaRef,
  attachments,
  onAttachFile,
  onRemoveAttachment,
  canAttach,
  uploadingAttachment,
}: EmailComposerContentProps) {
  const [showCc, setShowCc] = useState(ccRecipients.length > 0);
  const [showBcc, setShowBcc] = useState(bccRecipients.length > 0);
  const [showFormSurveyPicker, setShowFormSurveyPicker] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkInitialText, setLinkInitialText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getTextarea = (): HTMLTextAreaElement | null => {
    if (textareaRef && typeof textareaRef === 'object' && 'current' in textareaRef) {
      return (textareaRef as React.RefObject<HTMLTextAreaElement>).current;
    }
    return null;
  };

  const insertAtCursor = (snippet: string, replaceSelection = false) => {
    const textarea = getTextarea();
    if (textarea) {
      const start = textarea.selectionStart;
      const end = replaceSelection ? textarea.selectionEnd : start;
      onBodyChange(body.substring(0, start) + snippet + body.substring(end));
    } else {
      const sep = body.length > 0 && !/\s$/.test(body) ? ' ' : '';
      onBodyChange(body + sep + snippet);
    }
  };

  const handleInsertFormSurveyLink = (item: PickerItem) => {
    const path = item.kind === 'form' ? 'f' : 's';
    insertAtCursor(`${window.location.origin}/${path}/${item.slug}`, true);
    setShowFormSurveyPicker(false);
  };

  const openLinkDialog = () => {
    const textarea = getTextarea();
    const sel = textarea ? body.substring(textarea.selectionStart, textarea.selectionEnd) : '';
    setLinkInitialText(sel);
    setShowLinkDialog(true);
  };

  const handleInsertLink = (url: string, text: string) => {
    insertAtCursor(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`, true);
    setShowLinkDialog(false);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) Array.from(files).forEach(onAttachFile);
    e.target.value = '';
  };

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

  const toInitial = toName
    ? toName.charAt(0).toUpperCase()
    : toEmail.charAt(0).toUpperCase();

  return (
    <div className="flex flex-col">
      <div className="flex items-center px-4 py-2.5">
        <EmailSenderSelect
          value={sendVia}
          onChange={onSendViaChange}
          gmailConnected={gmailConnected}
          gmailAddress={gmailAddress}
          microsoftConnected={microsoftConnected}
          microsoftAddress={microsoftAddress}
          microsoftAccounts={microsoftAccounts}
          microsoftConnectionId={microsoftConnectionId}
          onMicrosoftConnectionChange={onMicrosoftConnectionChange}
          googleAccounts={googleAccounts}
          googleConnectionId={googleConnectionId}
          onGoogleConnectionChange={onGoogleConnectionChange}
          sendgridName={sendgridName}
          sendgridEmail={sendgridEmail}
          compact
        />
      </div>

      <div className="border-t border-hud-bg-elev" />

      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm text-hud-cream-dim shrink-0">To:</span>
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-hud-gold to-hud-teal text-white flex items-center justify-center text-xs font-medium shrink-0">
            {toInitial}
          </div>
          <span className="text-sm text-white truncate">
            {toEmail}
            <span className="text-hud-cream-mute ml-1">(Primary)</span>
          </span>
          <ChevronDown size={14} className="text-hud-cream-mute shrink-0" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowCc(!showCc)}
            className={`text-sm font-medium transition-colors ${
              showCc ? 'text-hud-gold-soft' : 'text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            CC
          </button>
          <button
            onClick={() => setShowBcc(!showBcc)}
            className={`text-sm font-medium transition-colors ${
              showBcc ? 'text-hud-gold-soft' : 'text-hud-cream-dim hover:text-hud-cream-soft'
            }`}
          >
            BCC
          </button>
        </div>
      </div>

      {showCc && (
        <>
          <div className="border-t border-hud-bg-elev" />
          <ContactEmailAutocomplete
            label="CC"
            recipients={ccRecipients}
            onChange={onCcChange}
          />
        </>
      )}

      {showBcc && (
        <>
          <div className="border-t border-hud-bg-elev" />
          <ContactEmailAutocomplete
            label="BCC"
            recipients={bccRecipients}
            onChange={onBccChange}
          />
        </>
      )}

      <div className="border-t border-hud-bg-elev" />

      <div className="px-4 py-2">
        <input
          type="text"
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          placeholder="Subject:"
          className="w-full text-sm text-white placeholder-hud-cream-dim border-none outline-none bg-transparent"
        />
      </div>

      <div className="border-t border-hud-bg-elev" />

      <div className="px-4 pt-3 pb-2">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write your email..."
          className={`w-full text-sm text-white placeholder-hud-cream-dim resize-y border-none outline-none bg-transparent ${
            expanded ? 'min-h-[200px]' : 'min-h-[100px]'
          }`}
          style={{ maxHeight: expanded ? '400px' : '200px' }}
        />
      </div>

      {(attachments.length > 0 || uploadingAttachment) && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {attachments.map((att, i) => (
            <div
              key={`${att.path}-${i}`}
              className="flex items-center gap-1.5 bg-hud-bg-elev/60 border border-hud-cream-mute rounded-lg pl-2 pr-1 py-1 text-xs text-hud-cream-soft max-w-[220px]"
            >
              <Paperclip size={12} className="text-hud-cream-dim shrink-0" />
              <span className="truncate">{att.filename}</span>
              <span className="text-hud-cream-mute shrink-0">{formatFileSize(att.size)}</span>
              <button
                onClick={() => onRemoveAttachment(i)}
                className="p-0.5 hover:bg-hud-cream-mute rounded shrink-0"
                title="Remove attachment"
              >
                <X size={12} className="text-hud-cream-dim" />
              </button>
            </div>
          ))}
          {uploadingAttachment && (
            <div className="flex items-center gap-1.5 bg-hud-bg-elev/60 border border-hud-cream-mute rounded-lg px-2 py-1 text-xs text-hud-cream-dim">
              <Loader2 size={12} className="animate-spin" />
              Uploading…
            </div>
          )}
        </div>
      )}

      <ComposerToolbar
        leftIcons={
          <>
            {canUseSnippets && (
              <button
                onClick={onSnippetClick}
                className="p-2 text-hud-cream-dim hover:text-white rounded transition-colors"
                title="Insert snippet"
              >
                <FileText size={18} />
              </button>
            )}
            <button
              onClick={openLinkDialog}
              className="p-2 text-hud-cream-dim hover:text-white rounded transition-colors"
              title="Insert link"
            >
              <LinkIcon size={18} />
            </button>
            {canAttach && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-hud-cream-dim hover:text-white rounded transition-colors"
                title="Attach image"
              >
                <ImageIcon size={18} />
              </button>
            )}
            <button
              onClick={() => setShowFormSurveyPicker(true)}
              className="p-2 text-hud-cream-dim hover:text-white rounded transition-colors"
              title="Insert form or survey link"
            >
              <ClipboardList size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFilePick}
            />
          </>
        }
        centerContent={<>{wordCount} word{wordCount !== 1 ? 's' : ''}</>}
        onClear={onClear}
        onSend={onSend}
        sendDisabled={sendDisabled}
        sending={sending}
      />

      <FormSurveyPicker
        open={showFormSurveyPicker}
        onClose={() => setShowFormSurveyPicker(false)}
        onSelect={handleInsertFormSurveyLink}
      />

      {showLinkDialog && (
        <LinkDialog
          initialText={linkInitialText}
          onInsert={handleInsertLink}
          onClose={() => setShowLinkDialog(false)}
        />
      )}
    </div>
  );
}

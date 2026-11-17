/**
 * Document body: sanitized read-only prose, or a native contenteditable surface with a small toolbar.
 * Uncontrolled while editing (the DOM is the source of truth); `loadKey` re-loads `html` into the surface
 * (open, fill a placeholder, restore). Unresolved bold [PLACEHOLDER]s get a display-only data-ph mark that
 * editorHtml() strips before anything is saved.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Bold, Eraser, Heading2, Heading3, Italic, List, Rows3, Trash2 } from 'lucide-react';
import {
  addRowBelow, deleteRow, editorHtml, findMarkNode, findPlaceholderNode, markPlaceholders, rowOf, sanitizeDocHtml, sanitizeEditorHtml,
} from './documentHtml';

export interface DocumentEditorHandle {
  /** Scroll to and flash the nth occurrence of a placeholder prompt. */
  focusPlaceholder: (name: string, nth?: number) => void;
  /** Scroll to and flash an auto-filled value by its data-auto id. */
  focusMark: (id: string) => void;
}

export interface DocumentEditorProps {
  html: string;
  /** Change to re-load `html` into the surface. */
  loadKey: string | number;
  editable: boolean;
  /** Called with sanitized HTML after every edit. */
  onChange?: (html: string) => void;
  minHeight?: string;
}

/** Button styles shared by the CAIO document screens. */
export const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-hud-line-soft px-3 py-1.5 text-sm text-hud-cream-soft transition-colors hover:bg-hud-bg-elev disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hud-gold';
export const BTN_PRIMARY = 'inline-flex items-center gap-1.5 rounded-lg bg-hud-gold px-3 py-1.5 text-sm font-semibold text-hud-bg-deep transition-colors hover:bg-hud-gold-soft disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hud-gold';
export const INPUT = 'w-full rounded-lg border border-hud-line-soft bg-hud-bg-deep/60 px-3 py-1.5 text-sm text-white placeholder:text-hud-cream-mute focus:border-hud-gold focus:outline-none disabled:opacity-60';

export const PROSE_CLASS = [
  'break-words text-sm leading-relaxed text-hud-cream-soft',
  '[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-white',
  '[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-white',
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-white [&_h4]:mt-3 [&_h4]:font-semibold [&_h4]:text-white',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_a]:text-hud-teal [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-hud-gold/50 [&_blockquote]:pl-3 [&_blockquote]:text-hud-cream-dim',
  '[&_code]:rounded [&_code]:bg-hud-bg-card [&_code]:px-1 [&_hr]:my-3 [&_hr]:border-hud-bg-elev',
  '[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-hud-line-soft [&_th]:bg-hud-bg-elev [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:align-top',
  '[&_td]:min-w-[5rem] [&_td]:border [&_td]:border-hud-line-soft [&_td]:px-2 [&_td]:py-1 [&_td]:align-top',
  '[&_strong[data-ph]]:rounded [&_strong[data-ph]]:bg-hud-gold/20 [&_strong[data-ph]]:px-0.5 [&_strong[data-ph]]:text-hud-gold-soft',
  '[&_b[data-ph]]:rounded [&_b[data-ph]]:bg-hud-gold/20 [&_b[data-ph]]:px-0.5 [&_b[data-ph]]:text-hud-gold-soft',
  '[&_[data-flash]]:bg-hud-teal/40 [&_[data-flash]]:ring-2 [&_[data-flash]]:ring-hud-teal',
  // auto-filled values: amber = model-drafted, blue = from a fact or register, grey = from the engagement or computed
  '[&_mark]:rounded [&_mark]:px-0.5 [&_mark]:text-inherit [&_mark]:bg-slate-400/25',
  '[&_mark[data-resolver=llm]]:bg-amber-400/30 [&_mark[data-resolver=fact]]:bg-sky-400/25 [&_mark[data-resolver=register]]:bg-sky-400/25',
  '[&_mark[data-resolver=engagement]]:bg-slate-400/25 [&_mark[data-resolver=computed]]:bg-slate-400/25',
].join(' ');

/** Sanitized, read-only rendering (also used for previews and version history). */
export function ProseView({ html, className = '', showMarks = false }: { html: string; className?: string; showMarks?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    // auto-filled values are highlighted only where asked to; elsewhere they read as plain text
    ref.current.innerHTML = showMarks ? sanitizeEditorHtml(html) : sanitizeDocHtml(html);
    markPlaceholders(ref.current);
  }, [html, showMarks]);
  return <div ref={ref} className={`${PROSE_CLASS} ${className}`} />;
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label}
      // keep the caret in the document while a toolbar button is pressed
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs text-hud-cream-dim transition-colors hover:bg-hud-bg-elev hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-hud-gold">
      {children}
    </button>
  );
}

export const DocumentEditor = forwardRef<DocumentEditorHandle, DocumentEditorProps>(function DocumentEditor(
  { html, loadKey, editable, onChange, minHeight = '24rem' }, ref,
) {
  const surface = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // load (or re-load) the content; typing never goes through here, so the caret is left alone
  useLayoutEffect(() => {
    if (!surface.current) return;
    surface.current.innerHTML = sanitizeEditorHtml(html);
    markPlaceholders(surface.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, editable]);

  useEffect(() => {
    if (editable) { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* not supported */ } }
  }, [editable]);

  const emit = useCallback(() => {
    if (!surface.current) return;
    markPlaceholders(surface.current);
    onChangeRef.current?.(editorHtml(surface.current));
  }, []);

  useImperativeHandle(ref, () => ({
    focusPlaceholder(name, nth = 0) {
      const el = surface.current && findPlaceholderNode(surface.current, name, nth);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 1600);
    },
    focusMark(id) {
      const el = surface.current && findMarkNode(surface.current, id);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.setAttribute('data-flash', '');
      window.setTimeout(() => el.removeAttribute('data-flash'), 1600);
    },
  }), []);

  const exec = (cmd: string, arg?: string) => {
    surface.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  const caretRow = (): HTMLTableRowElement | null => {
    const sel = window.getSelection();
    return surface.current && sel?.anchorNode ? rowOf(sel.anchorNode, surface.current) : null;
  };
  const rowAction = (fn: (tr: HTMLTableRowElement) => unknown) => {
    const tr = caretRow();
    if (!tr) return; // caret is not in a table
    fn(tr);
    emit();
  };

  if (!editable) return <ProseView html={html} showMarks />;

  return (
    <div className="rounded-lg border border-hud-line-soft bg-hud-bg-deep/40">
      <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-lg border-b border-hud-line-soft bg-hud-bg-mid px-1.5 py-1">
        <ToolButton label="Bold" onClick={() => exec('bold')}><Bold className="h-4 w-4" /></ToolButton>
        <ToolButton label="Italic" onClick={() => exec('italic')}><Italic className="h-4 w-4" /></ToolButton>
        <ToolButton label="Heading 2" onClick={() => exec('formatBlock', 'h2')}><Heading2 className="h-4 w-4" /></ToolButton>
        <ToolButton label="Heading 3" onClick={() => exec('formatBlock', 'h3')}><Heading3 className="h-4 w-4" /></ToolButton>
        <ToolButton label="Bullet list" onClick={() => exec('insertUnorderedList')}><List className="h-4 w-4" /></ToolButton>
        <span className="mx-1 h-5 w-px bg-hud-line-soft" aria-hidden="true" />
        <ToolButton label="Add table row below" onClick={() => rowAction(addRowBelow)}><Rows3 className="h-4 w-4" /><span className="hidden sm:inline">Add row</span></ToolButton>
        <ToolButton label="Delete table row" onClick={() => rowAction(deleteRow)}><Trash2 className="h-4 w-4" /><span className="hidden sm:inline">Delete row</span></ToolButton>
        <span className="mx-1 h-5 w-px bg-hud-line-soft" aria-hidden="true" />
        <ToolButton label="Clear formatting" onClick={() => exec('removeFormat')}><Eraser className="h-4 w-4" /></ToolButton>
      </div>
      <div ref={surface} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Document body"
        spellCheck onInput={emit}
        // paste as plain text: pasted markup never reaches the document
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
        style={{ minHeight }}
        className={`${PROSE_CLASS} px-4 py-3 focus:outline-none focus-visible:ring-1 focus-visible:ring-hud-gold/60`} />
    </div>
  );
});
export default DocumentEditor;

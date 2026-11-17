/** Import a register from a CSV (workbook tab export or this module's export): pick, preview, import, then see failed rows. */
import { useMemo, useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { Table, THead, TH, TBody, TR, TD } from '../ui/Table';
import { ErrorBox } from './ui';
import { importRecords, mapCsv, type Engagement, type ImportResult, type RegisterDef } from '../../services/caio';

interface Props {
  engagement: Engagement;
  def: RegisterDef;
  onClose: () => void;
  /** called after an import ran so the table can reload */
  onImported: () => void;
}

export function CsvImportModal({ engagement, def, onClose, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const mapping = useMemo(() => (text === null ? null : mapCsv(def, text)), [def, text]);
  const matched = mapping ? Object.entries(mapping.columns) : [];

  const pick = async (file: File | undefined) => {
    setError(null);
    setResult(null);
    if (!file) return;
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch (e) {
      setText(null);
      setError(e instanceof Error ? e.message : 'Could not read that file');
    }
  };

  const run = async () => {
    if (!mapping || !mapping.rows.length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await importRecords(engagement.org_id, engagement.id, def.register_key, mapping.rows));
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="caio-import-title"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}>
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-xl border border-hud-bg-card bg-hud-bg-mid shadow-xl">
        <div className="flex items-center justify-between border-b border-hud-bg-card px-5 py-4">
          <h2 id="caio-import-title" className="text-lg font-semibold text-white">Import {def.title} from CSV</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-lg p-2 hover:bg-hud-bg-card"><X className="h-5 w-5 text-hud-cream-dim" /></button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm text-hud-cream-soft">
          {error && <ErrorBox message={error} />}

          {!result && (
            <>
              <p className="text-hud-cream-dim">
                Use a CSV exported from the workbook tab or from this register. Columns are matched to this register&apos;s column names; record IDs are issued on import.
              </p>
              <div>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" id="caio-import-file" onChange={(e) => void pick(e.target.files?.[0])} />
                <button type="button" onClick={() => fileRef.current?.click()}
                  className="inline-flex items-center gap-2 rounded-lg border border-hud-line-soft px-3 py-2 hover:bg-hud-bg-card">
                  <Upload className="h-4 w-4" aria-hidden="true" />{fileName ? 'Choose another file' : 'Choose CSV file'}
                </button>
                {fileName && <span className="ml-3 text-hud-cream-dim">{fileName}</span>}
              </div>

              {mapping && (
                <div className="space-y-2 rounded-lg border border-hud-line-soft p-3">
                  <p><span className="font-semibold text-white">{mapping.rows.length}</span> row{mapping.rows.length === 1 ? '' : 's'} to import
                    {mapping.skipped > 0 && <> · {mapping.skipped} skipped (placeholder or explanation rows from the workbook)</>}</p>
                  <p><span className="text-hud-cream-dim">Matched columns ({matched.length}):</span> {matched.length ? matched.map(([h]) => h).join(', ') : 'none'}</p>
                  {mapping.ignored.length > 0 && <p><span className="text-hud-cream-dim">Ignored columns ({mapping.ignored.length}):</span> {mapping.ignored.join(', ')}</p>}
                  {matched.length === 0 && <p className="text-hud-plum">No column in this file matches the {def.title} register, so nothing can be imported.</p>}
                </div>
              )}
            </>
          )}

          {result && (
            <div className="space-y-3">
              <p><span className="font-semibold text-white">{result.created}</span> record{result.created === 1 ? '' : 's'} created
                {result.failed.length > 0 && <>, <span className="font-semibold text-hud-plum">{result.failed.length}</span> failed</>}.</p>
              {result.failed.length > 0 && (
                <Table>
                  <THead><TH>CSV row</TH><TH>Why it failed</TH></THead>
                  <TBody>
                    {result.failed.map((f) => <TR key={f.row}><TD>{f.row}</TD><TD className="whitespace-normal break-words">{f.message}</TD></TR>)}
                  </TBody>
                </Table>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hud-bg-card px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-hud-line-soft px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-card">{result ? 'Done' : 'Cancel'}</button>
          {!result && (
            <button type="button" onClick={run} disabled={busy || !mapping || mapping.rows.length === 0}
              className="rounded-lg bg-hud-gold px-4 py-2 text-sm font-semibold text-hud-bg-deep hover:opacity-90 disabled:opacity-50">
              {busy ? 'Importing…' : `Import ${mapping?.rows.length ?? 0} rows`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
export default CsvImportModal;

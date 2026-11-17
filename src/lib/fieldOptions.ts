import type { PipelineFieldOption } from '../types';

/**
 * Field options are stored either as plain strings (fields made in the OS) or as {label, value}
 * objects (fields seeded or created by forms and agents). Rendering an object as a React child
 * crashes the page, so read options through this.
 */
export function normalizeOptions(options: PipelineFieldOption[] | null | undefined): { label: string; value: string }[] {
  return (options ?? []).map((opt) =>
    typeof opt === 'string' ? { label: opt, value: opt } : { label: String(opt.label ?? opt.value), value: String(opt.value ?? opt.label) }
  );
}

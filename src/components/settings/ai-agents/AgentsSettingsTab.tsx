import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bot, Check, ChevronRight, Cpu, Eye, Gauge, Loader2, Mic, RotateCcw, Save, Shield, BookOpen, FileText, X,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { AGENT_REGISTRY, childrenOf, getAgentDefinition, rootAgents, type AgentDefinition } from '../../../lib/agentRegistry';
import {
  emptyAgentSettings,
  listAgentSettings,
  previewEffectiveSettings,
  resetAgentSettings,
  saveAgentSettings,
  type AgentSettings,
  type AgentStatus,
} from '../../../services/agentSettings';
import * as modelsService from '../../../services/llmModels';
import * as elevenlabsService from '../../../services/elevenlabs';
import * as promptsService from '../../../services/promptTemplates';
import * as knowledgeService from '../../../services/knowledgeCollections';
import type { ElevenLabsVoice, KnowledgeCollection, LLMModel, LLMProviderType, PromptTemplate } from '../../../types';
import { LLM_PROVIDER_LABELS } from '../../../types';

interface AgentsSettingsTabProps {
  isViewOnly: boolean;
}

const STATUS_STYLES: Record<AgentStatus, string> = {
  active: 'bg-hud-emerald/10 text-hud-emerald',
  paused: 'bg-hud-rust/10 text-hud-rust',
  disabled: 'bg-hud-plum/10 text-hud-plum',
};

const inputClass =
  'w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold disabled:opacity-60';

function Section({ icon: Icon, title, hint, children }: { icon: typeof Cpu; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 sm:p-5">
      <div className="flex items-start gap-2 mb-4">
        <Icon className="w-4 h-4 text-hud-gold-soft mt-0.5 shrink-0" />
        <div>
          <h3 className="font-medium text-white text-sm">{title}</h3>
          {hint && <p className="text-xs text-hud-cream-dim mt-0.5">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, help, children, htmlFor }: { label: string; help?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-hud-cream-soft mb-1">{label}</label>
      {children}
      {help && <p className="text-[11px] text-hud-cream-mute mt-1">{help}</p>}
    </div>
  );
}

/** Tri-state boolean: null = inherit. */
function TriState({ id, value, onChange, disabled, inheritLabel }: {
  id: string; value: boolean | null; onChange: (v: boolean | null) => void; disabled: boolean; inheritLabel: string;
}) {
  return (
    <select
      id={id}
      value={value === null ? 'inherit' : value ? 'on' : 'off'}
      onChange={(e) => onChange(e.target.value === 'inherit' ? null : e.target.value === 'on')}
      disabled={disabled}
      className={inputClass}
    >
      <option value="inherit">{inheritLabel}</option>
      <option value="on">Yes</option>
      <option value="off">No</option>
    </select>
  );
}

function ToolChips({ id, value, onChange, suggestions, disabled, placeholder }: {
  id: string; value: string[]; onChange: (v: string[]) => void; suggestions: string[]; disabled: boolean; placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const items = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    if (!items.length) return;
    onChange(Array.from(new Set([...value, ...items])));
    setDraft('');
  };
  const unused = suggestions.filter((s) => !value.includes(s));
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.map((tool) => (
          <span key={tool} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-hud-gold/10 text-hud-gold-soft text-xs font-mono">
            {tool}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((t) => t !== tool))} aria-label={`Remove ${tool}`} className="hover:text-white">
                <X className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-hud-cream-mute">None</span>}
      </div>
      {!disabled && (
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            }
          }}
          onBlur={() => add(draft)}
          placeholder={placeholder}
          className={inputClass}
        />
      )}
      {!disabled && unused.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {unused.map((s) => (
            <button key={s} type="button" onClick={() => onChange([...value, s])}
              className="px-1.5 py-0.5 rounded bg-hud-bg-elev text-hud-cream-dim text-[11px] font-mono hover:text-white">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NumberInput({ id, value, onChange, disabled, placeholder, step = 1 }: {
  id: string; value: number | null; onChange: (v: number | null) => void; disabled: boolean; placeholder: string; step?: number;
}) {
  return (
    <input
      id={id}
      type="number"
      min={0}
      step={step}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      disabled={disabled}
      placeholder={placeholder}
      className={inputClass}
    />
  );
}

function stripForCompare(s: AgentSettings) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, org_id, parent_key, updated_at, ...rest } = s;
  return JSON.stringify(rest);
}

export function AgentsSettingsTab({ isViewOnly }: AgentsSettingsTabProps) {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canEdit = !isViewOnly && hasPermission('ai.settings.manage') && !/Agent$/.test(user?.role?.name ?? '');

  const [rows, setRows] = useState<Map<string, AgentSettings>>(new Map());
  const [models, setModels] = useState<LLMModel[]>([]);
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [selectedKey, setSelectedKey] = useState<string>('clara');
  const [draft, setDraft] = useState<AgentSettings>(emptyAgentSettings('clara'));
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      setLoading(true);
      const [settings, modelRows, voiceRows, templateRows, collectionRows] = await Promise.all([
        listAgentSettings(orgId),
        modelsService.getModels(orgId),
        elevenlabsService.getVoices(orgId).catch(() => [] as ElevenLabsVoice[]),
        promptsService.getTemplates(orgId, { status: 'active' }).catch(() => [] as PromptTemplate[]),
        knowledgeService.getCollections(orgId, { status: 'active' }).catch(() => [] as KnowledgeCollection[]),
      ]);
      setRows(new Map(settings.map((s) => [s.agent_key, s])));
      setModels(modelRows);
      setVoices(voiceRows);
      setTemplates(templateRows);
      setCollections(collectionRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent settings');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setDraft(rows.get(selectedKey) ?? emptyAgentSettings(selectedKey));
    setPreview(null);
    setSaved(false);
  }, [selectedKey, rows]);

  const def = getAgentDefinition(selectedKey) ?? AGENT_REGISTRY[0];
  const parentDef = def.parent ? getAgentDefinition(def.parent) : undefined;
  const parentRow = def.parent ? rows.get(def.parent) : undefined;
  const stored = rows.get(selectedKey);
  const dirty = stripForCompare(draft) !== stripForCompare(stored ?? emptyAgentSettings(selectedKey));

  const selectableModels = useMemo(
    () => models.filter((m) => m.enabled && m.provider?.enabled && m.metadata?.available !== false),
    [models],
  );
  const modelsByProvider = useMemo(() => {
    const groups = new Map<string, LLMModel[]>();
    for (const m of selectableModels) {
      const label = LLM_PROVIDER_LABELS[m.provider?.provider as LLMProviderType] ?? m.provider?.provider ?? 'Other';
      groups.set(label, [...(groups.get(label) ?? []), m]);
    }
    return [...groups.entries()];
  }, [selectableModels]);
  const modelName = (id: string | null | undefined) => {
    if (!id) return null;
    const m = models.find((x) => x.id === id);
    if (!m) return 'a removed model';
    return m.enabled && m.provider?.enabled ? m.display_name : `${m.display_name} (unavailable)`;
  };
  const orgDefaultModel = models.find((m) => m.is_default && m.enabled);
  const enabledVoices = voices.filter((v) => v.enabled);
  const orgDefaultVoice = voices.find((v) => v.is_default);
  const voiceName = (id: string | null | undefined) => (id ? voices.find((v) => v.voice_id === id)?.voice_name ?? id : null);

  const inheritModelLabel = (field: 'primary_model_id' | 'fallback_model_id') => {
    const fromParent = parentRow?.[field];
    if (def.parent && fromParent) return `Inherit from ${parentDef?.name} (${modelName(fromParent)})`;
    if (field === 'primary_model_id') {
      return orgDefaultModel
        ? `Org default (${orgDefaultModel.display_name})`
        : `Built-in default${def.builtInModel ? ` (${def.builtInModel})` : ''}`;
    }
    return def.parent ? `Inherit from ${parentDef?.name} (none)` : 'None';
  };
  const inheritVoiceLabel = () => {
    if (def.parent && parentRow?.voice_id) return `Inherit from ${parentDef?.name} (${voiceName(parentRow.voice_id)})`;
    return orgDefaultVoice ? `Org default (${orgDefaultVoice.voice_name})` : 'Built-in default (agent env)';
  };
  const inheritLabel = def.parent ? `Inherit from ${parentDef?.name}` : 'Org default';

  const update = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSave = async () => {
    if (!orgId || !canEdit) return;
    try {
      setSaving(true);
      setError(null);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, org_id, parent_key, updated_at, ...input } = draft;
      const savedRow = await saveAgentSettings(orgId, user?.id, { ...input, agent_key: selectedKey });
      setRows((prev) => new Map(prev).set(selectedKey, savedRow));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!orgId || !canEdit || !stored) return;
    if (!confirm(`Reset ${def.name} to inherit everything${def.parent ? ` from ${parentDef?.name}` : ' from org defaults'}?`)) return;
    try {
      await resetAgentSettings(orgId, selectedKey);
      setRows((prev) => {
        const next = new Map(prev);
        next.delete(selectedKey);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset');
    }
  };

  const handlePreview = async () => {
    try {
      setPreviewLoading(true);
      setPreview(await previewEffectiveSettings(selectedKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  const selectAgent = (key: string) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setSelectedKey(key);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  const agentButton = (a: AgentDefinition, nested: boolean) => {
    const row = rows.get(a.key);
    const isSelected = a.key === selectedKey;
    const status = row?.status ?? 'active';
    return (
      <button
        key={a.key}
        onClick={() => selectAgent(a.key)}
        aria-current={isSelected ? 'true' : undefined}
        className={`w-full flex items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
          isSelected ? 'bg-hud-gold/15 text-hud-gold-soft' : 'text-hud-cream-soft hover:bg-hud-bg-elev'
        } ${nested ? 'pl-6' : 'font-semibold'}`}
      >
        <span className="truncate">{a.name}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {row && <span className="w-1.5 h-1.5 rounded-full bg-hud-gold" title="Has overrides" />}
          {status !== 'active' && <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_STYLES[status]}`}>{status}</span>}
          {isSelected && <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-hud-plum/10 border border-hud-plum/20 rounded-lg p-3 text-sm text-hud-plum">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Agent selector */}
        <nav aria-label="Agents" className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-2 max-h-72 lg:max-h-[calc(100dvh-14rem)] overflow-y-auto lg:sticky lg:top-4 self-start">
          {rootAgents().map((root) => {
            const children = childrenOf(root.key);
            const groups = Array.from(new Set(children.map((c) => c.group ?? 'Subagents')));
            return (
              <div key={root.key} className="mb-3 last:mb-0">
                {agentButton(root, false)}
                {groups.map((g) => (
                  <div key={g} className="mt-1">
                    <p className="pl-6 pr-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-hud-cream-mute">{g}</p>
                    {children.filter((c) => (c.group ?? 'Subagents') === g).map((c) => agentButton(c, true))}
                  </div>
                ))}
              </div>
            );
          })}
        </nav>

        {/* Settings for the selected agent */}
        <div className="space-y-4 min-w-0">
          <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Bot className="w-5 h-5 text-hud-gold-soft" />
                  <h2 className="text-lg font-semibold text-white">{def.name}</h2>
                  <code className="text-[11px] text-hud-cream-mute bg-hud-bg-mid px-1.5 py-0.5 rounded">{def.key}</code>
                  {parentDef && (
                    <span className="text-xs text-hud-cream-dim">under {parentDef.name}</span>
                  )}
                </div>
                <p className="text-sm text-hud-cream-dim mt-1">{def.description}</p>
                {!stored && (
                  <p className="text-xs text-hud-cream-mute mt-1">
                    No overrides yet: everything is inherited{def.parent ? ` from ${parentDef?.name}` : ' from org defaults and the agent’s built-in config'}.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <label htmlFor="agent-status" className="sr-only">Status</label>
                <select
                  id="agent-status"
                  value={draft.status}
                  onChange={(e) => update('status', e.target.value as AgentStatus)}
                  disabled={!canEdit}
                  className={`px-2 py-1.5 rounded-lg text-xs font-medium border-0 ${STATUS_STYLES[draft.status]}`}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
            </div>
            {def.parent && parentRow && parentRow.status !== 'active' && (
              <p className="text-xs text-hud-rust mt-3">{parentDef?.name} is {parentRow.status}; this subagent is treated as {parentRow.status} too.</p>
            )}
          </div>

          <Section icon={Cpu} title="Model" hint="Primary model and the fallback used when the primary is unavailable. Only enabled models from connected providers are listed.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Primary model" htmlFor="primary-model">
                <select id="primary-model" value={draft.primary_model_id ?? ''} disabled={!canEdit}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    setDraft((d) => ({ ...d, primary_model_id: id, fallback_model_id: d.fallback_model_id === id ? null : d.fallback_model_id }));
                  }} className={inputClass}>
                  <option value="">{inheritModelLabel('primary_model_id')}</option>
                  {modelsByProvider.map(([label, list]) => (
                    <optgroup key={label} label={label}>
                      {list.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                    </optgroup>
                  ))}
                  {draft.primary_model_id && !selectableModels.some((m) => m.id === draft.primary_model_id) && (
                    <option value={draft.primary_model_id}>{modelName(draft.primary_model_id)}</option>
                  )}
                </select>
              </Field>
              <Field label="Fallback model" htmlFor="fallback-model">
                <select id="fallback-model" value={draft.fallback_model_id ?? ''} disabled={!canEdit}
                  onChange={(e) => update('fallback_model_id', e.target.value || null)} className={inputClass}>
                  <option value="">{inheritModelLabel('fallback_model_id')}</option>
                  {modelsByProvider.map(([label, list]) => (
                    <optgroup key={label} label={label}>
                      {list.filter((m) => m.id !== draft.primary_model_id).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                    </optgroup>
                  ))}
                  {draft.fallback_model_id && !selectableModels.some((m) => m.id === draft.fallback_model_id) && (
                    <option value={draft.fallback_model_id}>{modelName(draft.fallback_model_id)}</option>
                  )}
                </select>
              </Field>
            </div>
            {selectableModels.length === 0 && (
              <p className="text-xs text-hud-rust">No enabled models yet. Connect a provider and enable models on the Models tab.</p>
            )}
          </Section>

          <Section icon={Mic} title="Voice" hint={def.usesVoice ? 'ElevenLabs voice used for calls and spoken replies.' : 'Only used if this agent speaks; most subagents reply through their parent.'}>
            {voices.length === 0 ? (
              <p className="text-sm text-hud-cream-dim">
                No ElevenLabs voices synced. Connect ElevenLabs on the <Link to="/settings/ai-agents?tab=voices" className="text-hud-gold-soft underline">Voices</Link> tab.
              </p>
            ) : (
              <Field label="ElevenLabs voice" htmlFor="voice">
                <select id="voice" value={draft.voice_id ?? ''} disabled={!canEdit}
                  onChange={(e) => update('voice_id', e.target.value || null)} className={inputClass}>
                  <option value="">{inheritVoiceLabel()}</option>
                  {enabledVoices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.voice_name}{v.metadata?.accent ? ` · ${v.metadata.accent}` : ''}{v.metadata?.gender ? ` · ${v.metadata.gender}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {draft.voice_id && (() => {
              const v = voices.find((x) => x.voice_id === draft.voice_id);
              return v?.metadata?.preview_url ? (
                <audio controls preload="none" src={v.metadata.preview_url} className="w-full max-w-sm h-9">
                  <track kind="captions" />
                </audio>
              ) : null;
            })()}
          </Section>

          <Section icon={FileText} title="Persona & prompts" hint="Added to this agent’s system prompt. Subagents are always wrapped by their parent’s prompt.">
            <Field label="How to apply the override" htmlFor="persona-mode">
              <select id="persona-mode" value={draft.persona_mode} disabled={!canEdit}
                onChange={(e) => update('persona_mode', e.target.value as 'append' | 'replace')} className={inputClass}>
                <option value="append">Append to the built-in persona / soul file</option>
                <option value="replace">Replace the built-in persona (soul constitution still applies)</option>
              </select>
            </Field>
            <Field label="Persona override" htmlFor="persona" help="Leave empty to use only the persona shipped with the agent.">
              <textarea id="persona" rows={5} value={draft.persona_override ?? ''} disabled={!canEdit}
                onChange={(e) => update('persona_override', e.target.value || null)}
                placeholder="e.g. Keep phone replies under two sentences. Always confirm the caller’s name before booking."
                className={`${inputClass} font-mono text-xs`} />
            </Field>
            <Field label="Prompt templates" help="Active templates from Prompts & Defaults, appended in this order.">
              {templates.length === 0 ? (
                <p className="text-xs text-hud-cream-mute">No active prompt templates.</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {templates.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm text-hud-cream-soft">
                      <input type="checkbox" disabled={!canEdit} checked={draft.prompt_template_ids.includes(t.id)}
                        onChange={(e) => update('prompt_template_ids', e.target.checked
                          ? [...draft.prompt_template_ids, t.id]
                          : draft.prompt_template_ids.filter((x) => x !== t.id))}
                        className="rounded border-hud-cream-mute text-hud-gold focus:ring-hud-gold" />
                      <span className="truncate">{t.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          </Section>

          <Section icon={BookOpen} title="Knowledge sources" hint="Collections this agent can search, on top of (or instead of) the global knowledge.">
            <Field label="Include global knowledge (collections marked “apply to all agents”)" htmlFor="global-knowledge">
              <TriState id="global-knowledge" value={draft.include_global_knowledge} disabled={!canEdit}
                onChange={(v) => update('include_global_knowledge', v)} inheritLabel={def.parent ? inheritLabel : 'Default (yes)'} />
            </Field>
            <Field label="Agent-specific collections">
              {def.parent && (
                <label className="flex items-center gap-2 text-xs text-hud-cream-dim mb-2">
                  <input type="checkbox" disabled={!canEdit} checked={draft.knowledge_collection_ids === null}
                    onChange={(e) => update('knowledge_collection_ids', e.target.checked ? null : [])}
                    className="rounded border-hud-cream-mute text-hud-gold focus:ring-hud-gold" />
                  Use {parentDef?.name}’s collections
                </label>
              )}
              {collections.filter((c) => !c.apply_to_all_agents).length === 0 ? (
                <p className="text-xs text-hud-cream-mute">No agent-specific collections. Add one on the Global Knowledge tab.</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {collections.filter((c) => !c.apply_to_all_agents).map((c) => {
                    const list = draft.knowledge_collection_ids ?? [];
                    return (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-hud-cream-soft">
                        <input type="checkbox" disabled={!canEdit || (def.parent !== null && draft.knowledge_collection_ids === null)}
                          checked={list.includes(c.id)}
                          onChange={(e) => update('knowledge_collection_ids', e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id))}
                          className="rounded border-hud-cream-mute text-hud-gold focus:ring-hud-gold" />
                        <span className="truncate">{c.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </Field>
          </Section>

          <Section icon={Shield} title="Tool permissions" hint="Narrows what the agent’s code already allows (agent-core allowlists). It can never grant a tool the code doesn’t have.">
            <Field label="Allowed tools" htmlFor="allow-mode">
              <select id="allow-mode" value={draft.allowed_tools === null ? 'inherit' : 'only'} disabled={!canEdit}
                onChange={(e) => update('allowed_tools', e.target.value === 'inherit' ? null : (def.defaultTools ?? []))}
                className={inputClass}>
                <option value="inherit">{def.parent ? `Same as ${parentDef?.name} (no extra restriction)` : 'Everything the code allows (no extra restriction)'}</option>
                <option value="only">Only the tools listed below</option>
              </select>
            </Field>
            {draft.allowed_tools !== null && (
              <ToolChips id="allowed-tools" value={draft.allowed_tools} onChange={(v) => update('allowed_tools', v)}
                suggestions={def.defaultTools ?? []} disabled={!canEdit} placeholder="Add a tool name and press Enter (e.g. contacts_list)" />
            )}
            <Field label="Always deny" htmlFor="denied-tools" help="Blocked even if allowed above or by the parent.">
              <ToolChips id="denied-tools" value={draft.denied_tools} onChange={(v) => update('denied_tools', v)}
                suggestions={[]} disabled={!canEdit} placeholder="e.g. contacts_delete, phone_call" />
            </Field>
          </Section>

          <Section icon={Gauge} title="Limits" hint={def.parent ? `Leave blank to use ${parentDef?.name}’s limit. A subagent can’t exceed its parent.` : 'Leave blank to keep the agent’s built-in limit (env vars such as CLARA_DAY_MAX_COST_USD).'}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Field label="Daily budget (USD)" htmlFor="budget">
                <NumberInput id="budget" step={0.5} value={draft.daily_budget_usd} disabled={!canEdit}
                  onChange={(v) => update('daily_budget_usd', v)} placeholder={parentRow?.daily_budget_usd != null ? `${parentRow.daily_budget_usd} (parent)` : 'Built-in'} />
              </Field>
              <Field label="Max tokens per response" htmlFor="max-tokens">
                <NumberInput id="max-tokens" step={256} value={draft.max_tokens} disabled={!canEdit}
                  onChange={(v) => update('max_tokens', v)} placeholder={parentRow?.max_tokens != null ? `${parentRow.max_tokens} (parent)` : 'Built-in'} />
              </Field>
              <Field label="Max model calls per day" htmlFor="max-calls">
                <NumberInput id="max-calls" value={draft.max_calls_per_day} disabled={!canEdit}
                  onChange={(v) => update('max_calls_per_day', v)} placeholder={parentRow?.max_calls_per_day != null ? `${parentRow.max_calls_per_day} (parent)` : 'Built-in'} />
              </Field>
              <Field label="Rate limit (calls / minute)" htmlFor="rate">
                <NumberInput id="rate" value={draft.rate_limit_per_minute} disabled={!canEdit}
                  onChange={(v) => update('rate_limit_per_minute', v)} placeholder={parentRow?.rate_limit_per_minute != null ? `${parentRow.rate_limit_per_minute} (parent)` : 'None'} />
              </Field>
              <Field label="Max tool turns per task" htmlFor="turns">
                <NumberInput id="turns" value={draft.max_turns} disabled={!canEdit}
                  onChange={(v) => update('max_turns', v)} placeholder={parentRow?.max_turns != null ? `${parentRow.max_turns} (parent)` : 'Built-in (6)'} />
              </Field>
              <Field label="Require human approval for outbound actions" htmlFor="approval">
                <TriState id="approval" value={draft.require_approval} disabled={!canEdit}
                  onChange={(v) => update('require_approval', v)} inheritLabel={inheritLabel} />
              </Field>
            </div>
          </Section>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button onClick={handlePreview} disabled={previewLoading || dirty}
              title={dirty ? 'Save first to preview what the agent receives' : undefined}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm text-hud-cream-soft hover:text-white disabled:opacity-50">
              {previewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Preview what {def.name} receives
            </button>
            {canEdit && (
              <div className="flex items-center gap-2 justify-end">
                {saved && <span className="inline-flex items-center gap-1 text-sm text-hud-emerald"><Check className="w-4 h-4" /> Saved</span>}
                {stored && (
                  <button onClick={handleReset} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-hud-cream-soft hover:text-white">
                    <RotateCcw className="w-4 h-4" /> Reset to inherit
                  </button>
                )}
                <button onClick={handleSave} disabled={saving || !dirty}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-hud-gold-deep text-white rounded-lg text-sm disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save {def.name}
                </button>
              </div>
            )}
          </div>

          {preview && (
            <div className="bg-hud-bg-mid border border-hud-bg-elev rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-hud-cream-dim">Response of <code>agent-settings-get</code> for <code>{selectedKey}</code></p>
                <button onClick={() => setPreview(null)} aria-label="Close preview" className="text-hud-cream-mute hover:text-white"><X className="w-4 h-4" /></button>
              </div>
              <pre className="text-[11px] text-hud-cream-soft overflow-x-auto max-h-96">{JSON.stringify(preview, null, 2)}</pre>
            </div>
          )}

          {!canEdit && (
            <p className="text-xs text-hud-cream-mute">You have view-only access. Changing agent settings needs the ai.settings.manage permission.</p>
          )}
        </div>
      </div>
    </div>
  );
}

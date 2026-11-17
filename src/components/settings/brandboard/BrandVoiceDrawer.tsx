import { useState } from 'react';
import { X, Plus, Trash2, RotateCcw, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  createBrandVoice,
  updateBrandVoice,
  generateAISystemPrompt,
  getDefaultPromptTemplate,
} from '../../../services/brandboard';
import type {
  BrandVoiceWithVersion,
  ToneSettings,
  BrandVoiceExamples,
  ToneSliderKey,
  TONE_SLIDER_LABELS,
} from '../../../types';
import { Portal } from '../../shared/Portal';

interface BrandVoiceDrawerProps {
  voice: BrandVoiceWithVersion | null;
  onClose: () => void;
  onSave: () => void;
}

const TONE_LABELS: Record<ToneSliderKey, { low: string; high: string }> = {
  formality: { low: 'Casual', high: 'Formal' },
  friendliness: { low: 'Direct', high: 'Warm' },
  energy: { low: 'Calm', high: 'Energetic' },
  confidence: { low: 'Humble', high: 'Assertive' },
};

export function BrandVoiceDrawer({ voice, onClose, onSave }: BrandVoiceDrawerProps) {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  const [name, setName] = useState(voice?.name || '');
  const [summary, setSummary] = useState(voice?.summary || '');
  const [toneSettings, setToneSettings] = useState<ToneSettings>(
    voice?.latest_version?.tone_settings || {
      formality: 50,
      friendliness: 50,
      energy: 50,
      confidence: 50,
    }
  );
  const [dos, setDos] = useState<string[]>(voice?.latest_version?.dos || []);
  const [donts, setDonts] = useState<string[]>(voice?.latest_version?.donts || []);
  const [vocabularyPreferred, setVocabularyPreferred] = useState<string[]>(
    voice?.latest_version?.vocabulary_preferred || []
  );
  const [vocabularyProhibited, setVocabularyProhibited] = useState<string[]>(
    voice?.latest_version?.vocabulary_prohibited || []
  );
  const [formattingRules, setFormattingRules] = useState(
    voice?.latest_version?.formatting_rules || ''
  );
  const [examples, setExamples] = useState<BrandVoiceExamples>(
    voice?.latest_version?.examples || {}
  );
  const [aiPromptTemplate, setAiPromptTemplate] = useState(
    voice?.latest_version?.ai_prompt_template || getDefaultPromptTemplate()
  );

  const [newDo, setNewDo] = useState('');
  const [newDont, setNewDont] = useState('');
  const [newPreferred, setNewPreferred] = useState('');
  const [newProhibited, setNewProhibited] = useState('');

  const handleToneChange = (key: ToneSliderKey, value: number) => {
    setToneSettings({ ...toneSettings, [key]: value });
  };

  const handleAddDo = () => {
    if (newDo.trim()) {
      setDos([...dos, newDo.trim()]);
      setNewDo('');
    }
  };

  const handleAddDont = () => {
    if (newDont.trim()) {
      setDonts([...donts, newDont.trim()]);
      setNewDont('');
    }
  };

  const handleAddPreferred = () => {
    if (newPreferred.trim()) {
      setVocabularyPreferred([...vocabularyPreferred, newPreferred.trim()]);
      setNewPreferred('');
    }
  };

  const handleAddProhibited = () => {
    if (newProhibited.trim()) {
      setVocabularyProhibited([...vocabularyProhibited, newProhibited.trim()]);
      setNewProhibited('');
    }
  };

  const handleResetTemplate = () => {
    if (window.confirm('Reset to the default AI prompt template?')) {
      setAiPromptTemplate(getDefaultPromptTemplate());
    }
  };

  const getGeneratedPrompt = () => {
    return generateAISystemPrompt(
      {
        tone_settings: toneSettings,
        dos,
        donts,
        vocabulary_preferred: vocabularyPreferred,
        vocabulary_prohibited: vocabularyProhibited,
        formatting_rules: formattingRules,
      },
      aiPromptTemplate
    );
  };

  const handleSave = async () => {
    if (!user?.organization_id || !user.id || !name.trim()) return;

    setSaving(true);
    try {
      const input = {
        name,
        summary: summary || undefined,
        tone_settings: toneSettings,
        dos,
        donts,
        vocabulary_preferred: vocabularyPreferred,
        vocabulary_prohibited: vocabularyProhibited,
        formatting_rules: formattingRules || undefined,
        examples,
        ai_prompt_template: aiPromptTemplate,
      };

      if (voice) {
        await updateBrandVoice(voice.id, input, user.id);
      } else {
        await createBrandVoice(user.organization_id, input, user.id);
      }
      onSave();
    } catch (error) {
      console.error('Failed to save brand voice:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-3xl bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-cream-soft">
          <h2 className="text-lg font-semibold text-hud-bg-mid">
            {voice ? 'Edit Brand Voice' : 'Create Brand Voice'}
          </h2>
          <button onClick={onClose} className="p-2 text-hud-cream-dim hover:text-hud-cream-mute rounded-lg hover:bg-hud-cream">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Professional Voice"
                className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm focus:ring-2 focus:ring-hud-emerald focus:border-hud-emerald"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-bg-elev mb-1">Summary</label>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Brief description of this voice..."
                rows={2}
                className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm focus:ring-2 focus:ring-hud-emerald focus:border-hud-emerald"
              />
            </div>
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <h3 className="text-sm font-medium text-hud-bg-mid mb-4">Tone Settings</h3>
            <div className="space-y-4">
              {(Object.keys(TONE_LABELS) as ToneSliderKey[]).map((key) => (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-hud-bg-elev capitalize">{key}</span>
                    <span className="text-sm text-hud-cream-mute">{toneSettings[key]}%</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-hud-cream-dim w-16">{TONE_LABELS[key].low}</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={toneSettings[key]}
                      onChange={(e) => handleToneChange(key, parseInt(e.target.value))}
                      className="flex-1 h-2 bg-hud-cream-soft rounded-lg appearance-none cursor-pointer accent-hud-emerald-dim"
                    />
                    <span className="text-xs text-hud-cream-dim w-16 text-right">{TONE_LABELS[key].high}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <h3 className="text-sm font-medium text-hud-bg-mid mb-4">Writing Guidelines</h3>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-hud-emerald mb-2">Do's</label>
                <div className="space-y-2 mb-3">
                  {dos.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm bg-hud-emerald/10 px-3 py-2 rounded-lg">
                      <span className="flex-1">{item}</span>
                      <button onClick={() => setDos(dos.filter((_, idx) => idx !== i))} className="text-hud-cream-dim hover:text-hud-plum">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDo}
                    onChange={(e) => setNewDo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddDo()}
                    placeholder="Add a guideline..."
                    className="flex-1 px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  />
                  <button onClick={handleAddDo} className="p-2 bg-hud-emerald/15 text-hud-emerald-dim rounded-lg hover:bg-hud-emerald/25">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-hud-plum mb-2">Don'ts</label>
                <div className="space-y-2 mb-3">
                  {donts.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm bg-hud-plum/10 px-3 py-2 rounded-lg">
                      <span className="flex-1">{item}</span>
                      <button onClick={() => setDonts(donts.filter((_, idx) => idx !== i))} className="text-hud-cream-dim hover:text-hud-plum">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDont}
                    onChange={(e) => setNewDont(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddDont()}
                    placeholder="Add a restriction..."
                    className="flex-1 px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  />
                  <button onClick={handleAddDont} className="p-2 bg-hud-plum/15 text-hud-plum rounded-lg hover:bg-hud-plum/25">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <h3 className="text-sm font-medium text-hud-bg-mid mb-4">Vocabulary</h3>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-blue-700 mb-2">Preferred Phrases</label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {vocabularyPreferred.map((item, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded-lg">
                      {item}
                      <button onClick={() => setVocabularyPreferred(vocabularyPreferred.filter((_, idx) => idx !== i))} className="hover:text-hud-plum">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newPreferred}
                    onChange={(e) => setNewPreferred(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddPreferred()}
                    placeholder="Add phrase..."
                    className="flex-1 px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  />
                  <button onClick={handleAddPreferred} className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-hud-rust mb-2">Avoid These Phrases</label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {vocabularyProhibited.map((item, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-hud-rust/10 text-hud-rust rounded-lg line-through">
                      {item}
                      <button onClick={() => setVocabularyProhibited(vocabularyProhibited.filter((_, idx) => idx !== i))} className="hover:text-hud-plum">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newProhibited}
                    onChange={(e) => setNewProhibited(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddProhibited()}
                    placeholder="Add phrase..."
                    className="flex-1 px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  />
                  <button onClick={handleAddProhibited} className="p-2 bg-hud-rust/15 text-hud-rust rounded-lg hover:bg-hud-rust/25">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <label className="block text-sm font-medium text-hud-bg-elev mb-2">Formatting Rules</label>
            <textarea
              value={formattingRules}
              onChange={(e) => setFormattingRules(e.target.value)}
              placeholder="Punctuation, capitalization, and formatting guidelines..."
              rows={3}
              className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
            />
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <h3 className="text-sm font-medium text-hud-bg-mid mb-4">Example Copy</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-hud-cream-mute mb-1">Email Example</label>
                <textarea
                  value={examples.email || ''}
                  onChange={(e) => setExamples({ ...examples, email: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  placeholder="Sample email copy demonstrating this voice..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-hud-cream-mute mb-1">SMS Example</label>
                <textarea
                  value={examples.sms || ''}
                  onChange={(e) => setExamples({ ...examples, sms: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  placeholder="Sample SMS copy..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-hud-cream-mute mb-1">Social Media Example</label>
                <textarea
                  value={examples.social || ''}
                  onChange={(e) => setExamples({ ...examples, social: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm"
                  placeholder="Sample social post..."
                />
              </div>
            </div>
          </div>

          <div className="border-t border-hud-cream-soft pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium text-hud-bg-mid">AI Prompt Template</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleResetTemplate}
                  className="inline-flex items-center gap-1 text-xs text-hud-cream-mute hover:text-hud-bg-elev"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset to Default
                </button>
                <button
                  onClick={() => setShowPromptPreview(!showPromptPreview)}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                >
                  {showPromptPreview ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  {showPromptPreview ? 'Hide Preview' : 'Preview Output'}
                </button>
              </div>
            </div>
            <p className="text-xs text-hud-cream-mute mb-2">
              Available variables: {'{{company_name}}'}, {'{{formality_description}}'}, {'{{tone_description}}'}, {'{{energy_description}}'}, {'{{confidence_description}}'}, {'{{dos_list}}'}, {'{{donts_list}}'}, {'{{preferred_phrases}}'}, {'{{prohibited_phrases}}'}, {'{{formatting_rules}}'}, {'{{formality_adjective}}'}, {'{{tone_adjectives}}'}
            </p>
            <textarea
              value={aiPromptTemplate}
              onChange={(e) => setAiPromptTemplate(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 border border-hud-cream-soft rounded-lg text-sm font-mono"
            />
          </div>

          {showPromptPreview && (
            <div className="bg-hud-bg-elev rounded-lg border border-hud-cream-soft p-4">
              <h4 className="text-sm font-medium text-hud-cream-soft mb-2">Generated AI System Prompt</h4>
              <pre className="text-xs text-hud-cream-mute whitespace-pre-wrap font-mono bg-white p-3 rounded border border-hud-cream-soft max-h-64 overflow-y-auto">
                {getGeneratedPrompt()}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hud-cream-soft bg-hud-bg-elev">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-hud-bg-elev bg-white border border-hud-cream-soft rounded-lg hover:bg-hud-cream"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm font-medium text-white hover:text-hud-bg-deep bg-hud-emerald-dim rounded-lg hover:bg-hud-emerald disabled:opacity-50"
          >
            {saving ? 'Saving...' : voice ? 'Save Changes' : 'Create Brand Voice'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}

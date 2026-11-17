import { useState, useEffect, useRef } from 'react';
import {
  X,
  Globe,
  HelpCircle,
  Table,
  FileText,
  Upload,
  ArrowLeft,
  Loader2,
  Plus,
  Trash2,
  ChevronRight,
  Check,
  UploadCloud,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  List,
  ListOrdered,
  Link as LinkIcon,
  Code,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import * as agentKnowledgeService from '../../../services/agentKnowledge';
import { getAgents } from '../../../services/aiAgents';
import type {
  AgentKnowledgeSource,
  AgentKnowledgeSourceType,
  AIAgent,
  WebCrawlerSourceConfig,
  FAQSourceConfig,
  TableSourceConfig,
  RichTextSourceConfig,
  FileUploadSourceConfig,
} from '../../../types';
import { formatFileSize } from '../../../utils/formatters';
import { Portal } from '../../shared/Portal';

interface AddKnowledgeSourceModalProps {
  knowledgeSource?: AgentKnowledgeSource | null;
  onClose: () => void;
  onSave: () => void;
}

const SOURCE_TYPES: Array<{
  type: AgentKnowledgeSourceType;
  icon: typeof Globe;
  title: string;
  description: string;
  color: string;
}> = [
  {
    type: 'website',
    icon: Globe,
    title: 'Web Crawler',
    description: 'Crawl and extract content from a website to train your bot.',
    color: 'blue',
  },
  {
    type: 'faq',
    icon: HelpCircle,
    title: 'FAQ',
    description: 'Write question and answer pairs to help your bot answer common questions.',
    color: 'cyan',
  },
  {
    type: 'table',
    icon: Table,
    title: 'Tables',
    description: 'Upload a CSV file to train your bot with product details or other structured data.',
    color: 'emerald',
  },
  {
    type: 'rich_text',
    icon: FileText,
    title: 'Rich Text',
    description: 'Create formatted content with a rich text editor.',
    color: 'amber',
  },
  {
    type: 'file_upload',
    icon: Upload,
    title: 'File Upload',
    description: 'Upload files to your knowledge base to train your AI assistant.',
    color: 'rose',
  },
];

export function AddKnowledgeSourceModal({
  knowledgeSource,
  onClose,
  onSave,
}: AddKnowledgeSourceModalProps) {
  const { user } = useAuth();
  const orgId = user?.organization_id;
  const isEditing = !!knowledgeSource;

  const [selectedType, setSelectedType] = useState<AgentKnowledgeSourceType | null>(
    knowledgeSource?.source_type || null
  );
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    knowledgeSource?.agent_id || ''
  );
  const [sourceName, setSourceName] = useState(knowledgeSource?.source_name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgId) {
      loadAgents();
    }
  }, [orgId]);

  const loadAgents = async () => {
    if (!orgId) return;
    try {
      const data = await getAgents(orgId);
      setAgents(data);
    } catch (err) {
      console.error('Failed to load agents:', err);
    }
  };

  const handleSelectType = (type: AgentKnowledgeSourceType) => {
    setSelectedType(type);
    const sourceConfig = SOURCE_TYPES.find((s) => s.type === type);
    if (sourceConfig && !sourceName) {
      setSourceName(`New ${sourceConfig.title}`);
    }
  };

  const handleBack = () => {
    if (!isEditing) {
      setSelectedType(null);
    }
  };

  const handleSave = async (config: Record<string, unknown>) => {
    if (!orgId || !user || !selectedType || !sourceName.trim()) {
      setError('Please fill in all required fields');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (isEditing && knowledgeSource) {
        await agentKnowledgeService.updateKnowledgeSource(knowledgeSource.id, {
          sourceName: sourceName.trim(),
          sourceConfig: config,
        });

        if (selectedAgentId && selectedAgentId !== knowledgeSource.agent_id) {
          await agentKnowledgeService.linkKnowledgeToAgent(knowledgeSource.id, selectedAgentId);
        } else if (!selectedAgentId && knowledgeSource.agent_id) {
          await agentKnowledgeService.unlinkKnowledgeFromAgent(knowledgeSource.id);
        }
      } else {
        await agentKnowledgeService.createKnowledgeSource(
          orgId,
          {
            agentId: selectedAgentId || undefined,
            sourceType: selectedType,
            sourceName: sourceName.trim(),
            sourceConfig: config,
          },
          user.id
        );
      }

      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save knowledge source');
    } finally {
      setSaving(false);
    }
  };

  const renderSourceForm = () => {
    if (!selectedType) return null;

    const commonProps = {
      sourceName,
      setSourceName,
      agents,
      selectedAgentId,
      setSelectedAgentId,
      existingConfig: knowledgeSource?.source_config || {},
      onSave: handleSave,
      onCancel: onClose,
      saving,
      isEditing,
    };

    switch (selectedType) {
      case 'website':
        return <WebCrawlerForm {...commonProps} />;
      case 'faq':
        return <FAQForm {...commonProps} />;
      case 'table':
        return <TableUploadForm {...commonProps} />;
      case 'rich_text':
        return <RichTextForm {...commonProps} />;
      case 'file_upload':
        return <FileUploadForm {...commonProps} />;
      default:
        return null;
    }
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid border border-hud-bg-elev rounded-xl w-full max-w-3xl max-h-[90dvh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <div className="flex items-center gap-3">
            {selectedType && !isEditing && (
              <button
                onClick={handleBack}
                className="p-1 text-hud-cream-dim hover:text-white rounded transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <div>
              <h2 className="text-lg font-semibold text-white">
                {isEditing ? 'Edit Knowledge Source' : 'Add Knowledge Source'}
              </h2>
              {!selectedType && (
                <p className="text-sm text-hud-cream-dim mt-0.5">
                  Choose a source type to add knowledge to your agents
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-hud-cream-dim hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 bg-hud-plum/10 border border-hud-plum/20 rounded-lg p-3 text-hud-plum text-sm">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          {!selectedType ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SOURCE_TYPES.map((source) => {
                const Icon = source.icon;
                return (
                  <button
                    key={source.type}
                    onClick={() => handleSelectType(source.type)}
                    className="flex items-start gap-4 p-4 bg-hud-bg-card border border-hud-bg-elev rounded-lg hover:border-hud-cream-mute hover:bg-hud-bg-card/80 transition-all text-left group"
                  >
                    <div className={`p-3 bg-${source.color}-500/10 rounded-lg group-hover:bg-${source.color}-500/20 transition-colors`}>
                      <Icon className={`w-6 h-6 text-${source.color}-400`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-white mb-1">{source.title}</h3>
                      <p className="text-sm text-hud-cream-dim line-clamp-2">{source.description}</p>
                    </div>
                    <ChevronRight className="w-5 h-5 text-hud-cream-mute group-hover:text-hud-cream-dim transition-colors mt-1" />
                  </button>
                );
              })}
            </div>
          ) : (
            renderSourceForm()
          )}
        </div>
      </div>
    </div></Portal>
  );
}

interface FormProps {
  sourceName: string;
  setSourceName: (name: string) => void;
  agents: AIAgent[];
  selectedAgentId: string;
  setSelectedAgentId: (id: string) => void;
  existingConfig: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
  isEditing: boolean;
}

function FormHeader({
  sourceName,
  setSourceName,
  agents,
  selectedAgentId,
  setSelectedAgentId,
}: Pick<FormProps, 'sourceName' | 'setSourceName' | 'agents' | 'selectedAgentId' | 'setSelectedAgentId'>) {
  return (
    <div className="space-y-4 mb-6">
      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-1">Name *</label>
        <input
          type="text"
          value={sourceName}
          onChange={(e) => setSourceName(e.target.value)}
          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
          placeholder="Enter knowledge source name"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-hud-cream-soft mb-1">Link to Agent</label>
        <select
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
        >
          <option value="">No agent (shared)</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-hud-cream-mute mt-1">
          Shared sources can be used by any agent
        </p>
      </div>
    </div>
  );
}

function FormFooter({
  onCancel,
  onSubmit,
  saving,
  isEditing,
  disabled,
  submitLabel,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  isEditing: boolean;
  disabled?: boolean;
  submitLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-3 pt-6 mt-6 border-t border-hud-bg-elev">
      <button
        onClick={onCancel}
        className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={onSubmit}
        disabled={saving || disabled}
        className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
        {submitLabel || (isEditing ? 'Save Changes' : 'Create')}
      </button>
    </div>
  );
}

function WebCrawlerForm(props: FormProps) {
  const existingConfig = props.existingConfig as Partial<WebCrawlerSourceConfig>;
  const [url, setUrl] = useState(existingConfig.url || '');
  const [crawlType, setCrawlType] = useState<'exact' | 'domain' | 'sitemap'>(
    existingConfig.crawlType || 'exact'
  );
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedPages, setExtractedPages] = useState<Array<{ url: string; content: string }>>([]);

  const handleExtract = async () => {
    if (!url.trim()) return;

    setIsExtracting(true);
    try {
      const result = await agentKnowledgeService.crawlWebsite(url, crawlType === 'exact' ? 1 : 3);
      if (result.pages) {
        setExtractedPages(result.pages);
      }
    } catch (err) {
      console.error('Crawl failed:', err);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleSubmit = () => {
    const config: WebCrawlerSourceConfig = {
      url: url.trim(),
      crawlType,
      depth: crawlType === 'exact' ? 1 : 3,
    };
    props.onSave(config);
  };

  return (
    <div>
      <FormHeader {...props} />

      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <Globe className="w-6 h-6 text-blue-400" />
        <div>
          <h3 className="font-medium text-white">Web Crawler</h3>
          <p className="text-sm text-hud-cream-dim">Crawl and extract content from a website to train your bot.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-2">Enter Domain</label>
          <div className="flex gap-3">
            <select
              value={crawlType}
              onChange={(e) => setCrawlType(e.target.value as 'exact' | 'domain' | 'sitemap')}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="exact">Exact URL</option>
              <option value="domain">Domain</option>
              <option value="sitemap">Sitemap</option>
            </select>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Enter URL"
              className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
            <button
              onClick={handleExtract}
              disabled={!url.trim() || isExtracting}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isExtracting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              Extract Data
            </button>
          </div>
        </div>

        {extractedPages.length > 0 && (
          <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4">
            <h4 className="text-sm font-medium text-white mb-3">
              Extracted {extractedPages.length} page(s)
            </h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {extractedPages.map((page, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <Check className="w-4 h-4 text-hud-emerald flex-shrink-0" />
                  <span className="text-hud-cream-soft truncate">{page.url}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <FormFooter
        onCancel={props.onCancel}
        onSubmit={handleSubmit}
        saving={props.saving}
        isEditing={props.isEditing}
        disabled={!url.trim()}
      />
    </div>
  );
}

function FAQForm(props: FormProps) {
  const existingConfig = props.existingConfig as Partial<FAQSourceConfig>;
  const [faqs, setFaqs] = useState<Array<{ question: string; answer: string }>>(
    existingConfig.faqs || [{ question: '', answer: '' }]
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const handleQuestionChange = (index: number, value: string) => {
    const updated = [...faqs];
    updated[index].question = value;
    setFaqs(updated);
  };

  const handleAnswerChange = (index: number, value: string) => {
    const updated = [...faqs];
    updated[index].answer = value;
    setFaqs(updated);
  };

  const handleAddFaq = () => {
    setFaqs([...faqs, { question: '', answer: '' }]);
    setActiveIndex(faqs.length);
  };

  const handleRemoveFaq = (index: number) => {
    if (faqs.length <= 1) return;
    const updated = faqs.filter((_, i) => i !== index);
    setFaqs(updated);
    if (activeIndex >= updated.length) {
      setActiveIndex(updated.length - 1);
    }
  };

  const handleSubmit = () => {
    const validFaqs = faqs.filter((f) => f.question.trim() && f.answer.trim());
    if (validFaqs.length === 0) return;

    const config: FAQSourceConfig = { faqs: validFaqs };
    props.onSave(config);
  };

  const currentFaq = faqs[activeIndex];
  const hasValidFaq = faqs.some((f) => f.question.trim() && f.answer.trim());

  return (
    <div>
      <FormHeader {...props} />

      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <HelpCircle className="w-6 h-6 text-hud-gold-soft" />
        <div>
          <h3 className="font-medium text-white">FAQs</h3>
          <p className="text-sm text-hud-cream-dim">Write a question and answer pair to help your bot answer common questions.</p>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="w-48 flex-shrink-0">
          <div className="space-y-1">
            {faqs.map((faq, index) => (
              <button
                key={index}
                onClick={() => setActiveIndex(index)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                  activeIndex === index
                    ? 'bg-hud-bg-elev text-white'
                    : 'text-hud-cream-dim hover:bg-hud-bg-card hover:text-white'
                }`}
              >
                <span className="truncate">
                  {faq.question.trim() || `Q&A ${index + 1}`}
                </span>
                {faqs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveFaq(index);
                    }}
                    className="p-1 text-hud-cream-mute hover:text-hud-plum"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </button>
            ))}
          </div>
          <button
            onClick={handleAddFaq}
            className="w-full flex items-center justify-center gap-2 mt-2 px-3 py-2 border border-dashed border-hud-cream-mute rounded-lg text-sm text-hud-cream-dim hover:border-hud-cream-mute hover:text-white transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Q&A
          </button>
        </div>

        <div className="flex-1 space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="flex items-center justify-center w-6 h-6 bg-hud-gold/10 text-hud-gold-soft rounded-full text-sm font-medium">
                Q
              </span>
              <label className="text-sm font-medium text-hud-cream-soft">Question</label>
            </div>
            <textarea
              value={currentFaq?.question || ''}
              onChange={(e) => handleQuestionChange(activeIndex, e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
              placeholder="Your question goes here"
            />
            <div className="text-right text-xs text-hud-cream-mute mt-1">
              {currentFaq?.question.length || 0}/1000 characters
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="flex items-center justify-center w-6 h-6 bg-hud-emerald/10 text-hud-emerald rounded-full text-sm font-medium">
                A
              </span>
              <label className="text-sm font-medium text-hud-cream-soft">Answer</label>
            </div>
            <textarea
              value={currentFaq?.answer || ''}
              onChange={(e) => handleAnswerChange(activeIndex, e.target.value)}
              maxLength={1000}
              rows={5}
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
              placeholder="Your answer goes here"
            />
            <div className="text-right text-xs text-hud-cream-mute mt-1">
              {currentFaq?.answer.length || 0}/1000 characters
            </div>
          </div>
        </div>
      </div>

      <FormFooter
        onCancel={props.onCancel}
        onSubmit={handleSubmit}
        saving={props.saving}
        isEditing={props.isEditing}
        disabled={!hasValidFaq}
        submitLabel="Save"
      />
    </div>
  );
}

function TableUploadForm(props: FormProps) {
  const existingConfig = props.existingConfig as Partial<TableSourceConfig>;
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState(existingConfig.fileName || '');
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>(
    existingConfig.selectedColumns || []
  );
  const [previewData, setPreviewData] = useState<string[][]>([]);
  const [rowCount, setRowCount] = useState(existingConfig.rowCount || 0);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (selectedFile: File) => {
    setFile(selectedFile);
    setFileName(selectedFile.name.replace('.csv', ''));
    setParsing(true);

    try {
      const text = await selectedFile.text();
      const lines = text.split('\n').filter((line) => line.trim());
      if (lines.length > 0) {
        const headers = parseCSVLine(lines[0]);
        setColumns(headers);
        setSelectedColumns(headers);

        const preview: string[][] = [];
        for (let i = 1; i < Math.min(lines.length, 11); i++) {
          preview.push(parseCSVLine(lines[i]));
        }
        setPreviewData(preview);
        setRowCount(lines.length - 1);
      }
    } catch (err) {
      console.error('Failed to parse CSV:', err);
    } finally {
      setParsing(false);
    }
  };

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile?.name.endsWith('.csv')) {
      handleFileSelect(droppedFile);
    }
  };

  const toggleColumn = (column: string) => {
    setSelectedColumns((prev) =>
      prev.includes(column) ? prev.filter((c) => c !== column) : [...prev, column]
    );
  };

  const handleSubmit = () => {
    const config: TableSourceConfig = {
      fileName,
      selectedColumns,
      rowCount,
      previewData,
    };
    props.onSave(config);
  };

  return (
    <div>
      <FormHeader {...props} />

      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <Table className="w-6 h-6 text-hud-emerald" />
        <div>
          <h3 className="font-medium text-white">Table Upload</h3>
          <p className="text-sm text-hud-cream-dim">Upload a CSV file to train your bot with product details or other structured data.</p>
        </div>
      </div>

      <div className="flex items-center gap-4 mb-6">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                step >= s
                  ? 'bg-hud-gold-deep text-white'
                  : 'bg-hud-bg-elev text-hud-cream-dim'
              }`}
            >
              {step > s ? <Check className="w-4 h-4" /> : s}
            </div>
            <span className={`text-sm ${step >= s ? 'text-white' : 'text-hud-cream-mute'}`}>
              {s === 1 ? 'Upload File' : s === 2 ? 'Column Selection' : 'Summary'}
            </span>
            {s < 3 && <div className="w-8 h-px bg-hud-bg-elev" />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-hud-cream-mute rounded-lg p-8 text-center cursor-pointer hover:border-hud-cream-mute transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
              className="hidden"
            />
            {parsing ? (
              <Loader2 className="w-8 h-8 text-hud-cream-dim mx-auto animate-spin" />
            ) : (
              <UploadCloud className="w-8 h-8 text-hud-cream-dim mx-auto mb-3" />
            )}
            {file ? (
              <div>
                <p className="text-white font-medium">{file.name}</p>
                <p className="text-sm text-hud-cream-dim mt-1">{rowCount} rows detected</p>
              </div>
            ) : (
              <div>
                <p className="text-hud-gold-soft font-medium">Click to upload</p>
                <p className="text-sm text-hud-cream-dim mt-1">or drag and drop</p>
                <p className="text-xs text-hud-cream-mute mt-2">CSV file only (max 50 MB)</p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-1">Name *</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              placeholder="Enter a name for your table source"
            />
          </div>

          <div className="flex justify-end gap-3">
            <button onClick={props.onCancel} className="px-4 py-2 text-hud-cream-soft hover:text-white">
              Cancel
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!file || !fileName.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hud-bg-elev">
                    {columns.map((col, idx) => (
                      <th key={idx} className="px-4 py-3 text-left">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedColumns.includes(col)}
                            onChange={() => toggleColumn(col)}
                            className="rounded border-hud-cream-mute text-hud-gold focus:ring-hud-gold"
                          />
                          <span className="text-hud-cream-soft font-medium">{col}</span>
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.slice(0, 5).map((row, rowIdx) => (
                    <tr key={rowIdx} className="border-b border-hud-bg-elev/50">
                      {row.map((cell, cellIdx) => (
                        <td key={cellIdx} className="px-4 py-2 text-hud-cream-dim truncate max-w-xs">
                          {cell || '-'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {previewData.length > 5 && (
              <div className="px-4 py-2 text-xs text-hud-cream-mute border-t border-hud-bg-elev">
                Showing 5 of {rowCount} rows
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="flex items-center gap-2 px-4 py-2 text-hud-cream-soft hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={selectedColumns.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 space-y-3">
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">Source Name</span>
              <span className="text-white font-medium">{fileName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">File</span>
              <span className="text-white">{file?.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">Total Rows</span>
              <span className="text-white">{rowCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-hud-cream-dim">Selected Columns</span>
              <span className="text-white">{selectedColumns.length} of {columns.length}</span>
            </div>
            <div className="pt-2 border-t border-hud-bg-elev">
              <span className="text-sm text-hud-cream-dim">Columns:</span>
              <div className="flex flex-wrap gap-2 mt-2">
                {selectedColumns.map((col) => (
                  <span
                    key={col}
                    className="px-2 py-1 bg-hud-bg-elev rounded text-sm text-white"
                  >
                    {col}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => setStep(2)}
              className="flex items-center gap-2 px-4 py-2 text-hud-cream-soft hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={props.saving}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50"
            >
              {props.saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {props.isEditing ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RichTextForm(props: FormProps) {
  const existingConfig = props.existingConfig as Partial<RichTextSourceConfig>;
  const [content, setContent] = useState(existingConfig.content || '');
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current && existingConfig.content) {
      editorRef.current.innerHTML = existingConfig.content;
    }
  }, []);

  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const handleInput = () => {
    if (editorRef.current) {
      setContent(editorRef.current.innerHTML);
    }
  };

  const handleSubmit = () => {
    const plainText = editorRef.current?.innerText || '';
    const config: RichTextSourceConfig = {
      content,
      plainText,
    };
    props.onSave(config);
  };

  return (
    <div>
      <FormHeader {...props} />

      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <FileText className="w-6 h-6 text-hud-rust" />
        <div>
          <h3 className="font-medium text-white">Rich Text</h3>
          <p className="text-sm text-hud-cream-dim">Create formatted content with a rich text editor.</p>
        </div>
      </div>

      <div className="border border-hud-bg-elev rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 bg-hud-bg-card border-b border-hud-bg-elev">
          <select
            onChange={(e) => execCommand('formatBlock', e.target.value)}
            className="px-2 py-1 bg-hud-bg-elev border border-hud-cream-mute rounded text-sm text-white"
            defaultValue=""
          >
            <option value="" disabled>Paragraph</option>
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
          </select>

          <div className="w-px h-6 bg-hud-cream-mute mx-2" />

          <button
            onClick={() => execCommand('bold')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Bold"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('italic')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Italic"
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('underline')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Underline"
          >
            <Underline className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('strikeThrough')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Strikethrough"
          >
            <Strikethrough className="w-4 h-4" />
          </button>

          <div className="w-px h-6 bg-hud-cream-mute mx-2" />

          <button
            onClick={() => execCommand('justifyLeft')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Align Left"
          >
            <AlignLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('justifyCenter')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Align Center"
          >
            <AlignCenter className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('justifyRight')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Align Right"
          >
            <AlignRight className="w-4 h-4" />
          </button>

          <div className="w-px h-6 bg-hud-cream-mute mx-2" />

          <button
            onClick={() => execCommand('insertUnorderedList')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Bullet List"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('insertOrderedList')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Numbered List"
          >
            <ListOrdered className="w-4 h-4" />
          </button>

          <div className="w-px h-6 bg-hud-cream-mute mx-2" />

          <button
            onClick={() => {
              const url = prompt('Enter URL:');
              if (url) execCommand('createLink', url);
            }}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Insert Link"
          >
            <LinkIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => execCommand('formatBlock', 'pre')}
            className="p-1.5 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            title="Code Block"
          >
            <Code className="w-4 h-4" />
          </button>
        </div>

        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          className="min-h-[300px] p-4 bg-hud-bg-card/50 text-white focus:outline-none prose prose-invert max-w-none"
          style={{ whiteSpace: 'pre-wrap' }}
        />
      </div>

      <FormFooter
        onCancel={props.onCancel}
        onSubmit={handleSubmit}
        saving={props.saving}
        isEditing={props.isEditing}
        disabled={!content.trim()}
        submitLabel="Save"
      />
    </div>
  );
}

function FileUploadForm(props: FormProps) {
  const existingConfig = props.existingConfig as Partial<FileUploadSourceConfig>;
  const [files, setFiles] = useState<Array<{ file: File; name: string; size: number }>>(
    []
  );
  const [existingFiles] = useState(existingConfig.files || []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return;

    const validFiles = Array.from(selectedFiles).filter((file) =>
      ['.pdf', '.doc', '.docx'].some((ext) => file.name.toLowerCase().endsWith(ext))
    );

    const newFiles = validFiles.map((file) => ({
      file,
      name: file.name,
      size: file.size,
    }));

    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handleFileSelect(e.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };
  const handleSubmit = () => {
    const config: FileUploadSourceConfig = {
      files: [
        ...existingFiles,
        ...files.map((f) => ({
          name: f.name,
          size: f.size,
        })),
      ],
    };
    props.onSave(config);
  };

  const hasFiles = files.length > 0 || existingFiles.length > 0;

  return (
    <div>
      <FormHeader {...props} />

      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <Upload className="w-6 h-6 text-rose-400" />
        <div>
          <h3 className="font-medium text-white">Upload Files</h3>
          <p className="text-sm text-hud-cream-dim">Upload files to your knowledge base to train your AI assistant.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-2">Select Files</label>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-hud-gold/50 rounded-lg p-8 text-center cursor-pointer hover:border-hud-gold bg-hud-gold/5 transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx"
              multiple
              onChange={(e) => handleFileSelect(e.target.files)}
              className="hidden"
            />
            <UploadCloud className="w-8 h-8 text-hud-cream-dim mx-auto mb-3" />
            <p className="text-hud-cream-soft">
              Drop files here or <span className="text-hud-gold-soft">browse</span>
            </p>
            <p className="text-sm text-hud-cream-mute mt-1">Supports PDF, DOC, DOCX</p>
          </div>
        </div>

        {(files.length > 0 || existingFiles.length > 0) && (
          <div className="space-y-2">
            {existingFiles.map((file, idx) => (
              <div
                key={`existing-${idx}`}
                className="flex items-center justify-between px-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-hud-cream-dim" />
                  <div>
                    <p className="text-white text-sm">{file.name}</p>
                    <p className="text-xs text-hud-cream-mute">{formatFileSize(file.size)}</p>
                  </div>
                </div>
                <span className="text-xs text-hud-cream-mute">Existing</span>
              </div>
            ))}
            {files.map((file, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between px-4 py-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-5 h-5 text-hud-cream-dim" />
                  <div>
                    <p className="text-white text-sm">{file.name}</p>
                    <p className="text-xs text-hud-cream-mute">{formatFileSize(file.size)}</p>
                  </div>
                </div>
                <button
                  onClick={() => removeFile(idx)}
                  className="p-1 text-hud-cream-dim hover:text-hud-plum transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <FormFooter
        onCancel={props.onCancel}
        onSubmit={handleSubmit}
        saving={props.saving}
        isEditing={props.isEditing}
        disabled={!hasFiles}
        submitLabel="Upload Files"
      />
    </div>
  );
}

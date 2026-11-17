import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Filter,
  ExternalLink,
  Building2,
  DollarSign,
  Loader2,
  ChevronDown,
  ChevronUp,
  Bell,
  BellOff,
  Plus,
  MapPin,
  Phone,
  Mail,
  FileText,
  Download,
  FileSignature,
  Bookmark,
  History as HistoryIcon,
  Trash2,
  Clock,
  X,
  Play,
} from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import {
  searchOpportunities,
  importToOpportunity,
  type ImportedDocumentsSummary,
  getOpportunityDescription,
  getSavedSearches,
  createSavedSearch,
  deleteSavedSearch,
  toggleSavedSearchAlert,
  getSearchHistory,
  recordSearchHistory,
  clearSearchHistory,
  deleteSearchHistoryEntry,
  type SamGovOpportunity,
  type SamSearchFilters,
  type GovSavedSearch,
  type GovSearchHistoryEntry,
} from '../../services/samGov';
import { SlideInDrawer } from '../../components/ui/SlideInDrawer';

const SET_ASIDE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'SBA', label: 'Small Business (SBA)' },
  { value: '8A', label: '8(a)' },
  { value: 'HZC', label: 'HUBZone' },
  { value: 'SDVOSBC', label: 'Service-Disabled Veteran-Owned' },
  { value: 'WOSB', label: 'Women-Owned Small Business' },
  { value: 'EDWOSB', label: 'Economically Disadvantaged WOSB' },
];

// SAM.gov notice type codes (ptype query param). Comma-separated values
// can be passed to combine types — e.g. "o,k" for Solicitation + Combined.
const NOTICE_TYPE_OPTIONS = [
  { value: '', label: 'Any Type' },
  { value: 'p', label: 'Pre-Solicitation' },
  { value: 'o', label: 'Solicitation' },
  { value: 'k', label: 'Combined Synopsis / Solicitation' },
  { value: 'r', label: 'Sources Sought / RFI' },
  { value: 's', label: 'Special Notice' },
  { value: 'a', label: 'Award Notice' },
  { value: 'u', label: 'Justification (J&A)' },
  { value: 'g', label: 'Sale of Surplus Property' },
  { value: 'i', label: 'Intent to Bundle (DoD)' },
];

const US_STATES = [
  '', 'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
];

const PAGE_SIZE = 25;

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '--';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function defaultDateRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
  };
}

/** Human-readable one-line summary of a saved/history search's filters. */
function summarizeFilters(criteria: SamSearchFilters): string {
  const parts: string[] = [];
  if (criteria.keywords) parts.push(`"${criteria.keywords}"`);
  if (criteria.naicsCode) parts.push(`NAICS: ${criteria.naicsCode}`);
  if (criteria.setAsideType) parts.push(`Set-Aside: ${criteria.setAsideType}`);
  if (criteria.procurementType) parts.push(`Type: ${criteria.procurementType}`);
  if (criteria.state) parts.push(`State: ${criteria.state}`);
  if (criteria.postedFrom || criteria.postedTo) {
    parts.push(`${criteria.postedFrom || '...'} - ${criteria.postedTo || '...'}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'No filters';
}

function hasMeaningfulFilters(f: SamSearchFilters): boolean {
  return !!(f.keywords || f.naicsCode || f.setAsideType || f.procurementType || f.state);
}

type GovTab = 'search' | 'saved' | 'history';

export default function GovContractSearch() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const dates = defaultDateRange();

  const [activeTab, setActiveTab] = useState<GovTab>('search');

  // Search state
  const [keywords, setKeywords] = useState('');
  const [naicsCode, setNaicsCode] = useState('');
  const [setAsideType, setSetAsideType] = useState('');
  const [noticeType, setNoticeType] = useState('');
  const [state, setState] = useState('');
  const [postedFrom, setPostedFrom] = useState(dates.from);
  const [postedTo, setPostedTo] = useState(dates.to);

  // Results state
  const [results, setResults] = useState<SamGovOpportunity[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Detail expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Description cache — lazy-loaded when row expanded
  const [descCache, setDescCache] = useState<Record<string, string>>({});
  const [descLoading, setDescLoading] = useState<Record<string, boolean>>({});
  // Failures are kept out of descCache so re-expanding a row retries the fetch.
  const [descError, setDescError] = useState<Record<string, string>>({});

  // Import state
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // Filters panel toggle (mobile)
  const [showFilters, setShowFilters] = useState(false);

  // Save-search form
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveFreq, setSaveFreq] = useState<'daily' | 'weekly'>('daily');
  const [savingSearch, setSavingSearch] = useState(false);

  // Saved searches
  const [saved, setSaved] = useState<GovSavedSearch[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedDeletingId, setSavedDeletingId] = useState<string | null>(null);

  // History
  const [history, setHistory] = useState<GovSearchHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  /** Expanding a row clears its previous failure so the fetch is retried exactly once per open. */
  function toggleExpanded(noticeId: string) {
    if (expandedId === noticeId) {
      setExpandedId(null);
      return;
    }
    setDescError((prev) => {
      if (!prev[noticeId]) return prev;
      const next = { ...prev };
      delete next[noticeId];
      return next;
    });
    setExpandedId(noticeId);
  }

  // Fetch real description when a row is expanded
  useEffect(() => {
    if (!expandedId) return;
    if (descCache[expandedId] || descLoading[expandedId] || descError[expandedId]) return;
    const opp = results.find((o) => o.noticeId === expandedId);
    if (!opp) return;
    const desc = opp.description || '';
    if (!desc.startsWith('http')) return;

    setDescLoading((prev) => ({ ...prev, [expandedId]: true }));
    getOpportunityDescription(expandedId)
      .then((result) => {
        setDescCache((prev) => ({ ...prev, [expandedId]: result.plainText || 'No description available.' }));
      })
      .catch(() => {
        setDescError((prev) => ({
          ...prev,
          [expandedId]: 'Failed to load description. Collapse and re-open this row to retry.',
        }));
      })
      .finally(() => {
        setDescLoading((prev) => ({ ...prev, [expandedId]: false }));
      });
  }, [expandedId, results, descCache, descLoading, descError]);

  // Lazy-load tab data
  useEffect(() => {
    if (activeTab === 'saved') loadSaved();
    if (activeTab === 'history') loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function loadSaved() {
    setSavedLoading(true);
    try {
      setSaved(await getSavedSearches());
    } catch {
      setSaved([]);
    } finally {
      setSavedLoading(false);
    }
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      setHistory(await getSearchHistory());
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function buildFilters(): SamSearchFilters {
    return {
      keywords: keywords.trim() || undefined,
      naicsCode: naicsCode.trim() || undefined,
      setAsideType: setAsideType || undefined,
      procurementType: noticeType || undefined,
      state: state || undefined,
      postedFrom: postedFrom || undefined,
      postedTo: postedTo || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
  }

  async function handleSearch(newPage = 0, override?: SamSearchFilters) {
    setLoading(true);
    setError(null);
    setPage(newPage);
    try {
      const base = override ?? buildFilters();
      const filters: SamSearchFilters = {
        ...base,
        limit: PAGE_SIZE,
        offset: newPage * PAGE_SIZE,
      };
      const res = await searchOpportunities(filters);
      setResults(res.opportunities || []);
      setTotalRecords(res.totalRecords || 0);
      setHasSearched(true);
      setExpandedId(null);
      // Descriptions are keyed by notice id from the previous result set.
      setDescCache({});
      setDescError({});
      // Record a fresh search (not pagination) to history — best-effort.
      if (newPage === 0 && hasMeaningfulFilters(filters)) {
        recordSearchHistory(filters, res.totalRecords || 0);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
      setTotalRecords(0);
    } finally {
      setLoading(false);
    }
  }

  function applyCriteria(c: SamSearchFilters) {
    setKeywords(c.keywords || '');
    setNaicsCode(c.naicsCode || '');
    setSetAsideType(c.setAsideType || '');
    setNoticeType(c.procurementType || '');
    setState(c.state || '');
    setPostedFrom(c.postedFrom || dates.from);
    setPostedTo(c.postedTo || dates.to);
    setActiveTab('search');
    handleSearch(0, { ...c, limit: PAGE_SIZE, offset: 0 });
  }

  async function handleSaveSearch() {
    if (!saveName.trim()) return;
    setSavingSearch(true);
    try {
      await createSavedSearch(saveName.trim(), buildFilters(), saveFreq);
      setShowSaveForm(false);
      setSaveName('');
      showToast('success', 'Search saved', 'Find it under the Saved tab.');
      if (activeTab === 'saved') loadSaved();
    } catch (err: unknown) {
      showToast('warning', 'Could not save search', err instanceof Error ? err.message : undefined);
    } finally {
      setSavingSearch(false);
    }
  }

  async function handleDeleteSaved(id: string) {
    setSavedDeletingId(id);
    try {
      await deleteSavedSearch(id);
      setSaved((prev) => prev.filter((s) => s.id !== id));
    } catch (err: unknown) {
      showToast('warning', 'Failed to delete', err instanceof Error ? err.message : undefined);
    } finally {
      setSavedDeletingId(null);
    }
  }

  async function handleToggleAlert(id: string, enabled: boolean) {
    try {
      await toggleSavedSearchAlert(id, enabled);
      setSaved((prev) => prev.map((s) => (s.id === id ? { ...s, alert_enabled: enabled } : s)));
    } catch (err: unknown) {
      showToast('warning', 'Failed to update alert', err instanceof Error ? err.message : undefined);
    }
  }

  async function handleDeleteHistory(id: string) {
    try {
      await deleteSearchHistoryEntry(id);
      setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch {
      // ignore
    }
  }

  async function handleClearHistory() {
    if (!confirm('Clear your entire search history?')) return;
    try {
      await clearSearchHistory();
      setHistory([]);
    } catch (err: unknown) {
      showToast('warning', 'Failed to clear history', err instanceof Error ? err.message : undefined);
    }
  }

  /** Tells the user how many solicitation documents came across with the import. */
  function reportDocuments(docs?: ImportedDocumentsSummary) {
    if (!docs || docs.total === 0) return;
    const ready = docs.stored + docs.unchanged;
    const problems = [
      docs.failed ? `${docs.failed} failed` : '',
      docs.pending ? `${docs.pending} still downloading — use Refresh SAM.gov documents in the proposal builder` : '',
      docs.no_text ? `${docs.no_text} scanned (no text)` : '',
    ].filter(Boolean).join(' · ');
    showToast(
      docs.failed || docs.pending ? 'warning' : 'success',
      `${ready} of ${docs.total} solicitation document${docs.total !== 1 ? 's' : ''} attached`,
      problems || undefined,
    );
  }

  async function handleImport(opp: SamGovOpportunity) {
    setImportingId(opp.noticeId);
    setImportSuccess(null);
    try {
      const result = await importToOpportunity(opp);
      reportDocuments(result.documents);
      setImportSuccess(opp.noticeId);
      setTimeout(() => setImportSuccess(null), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingId(null);
    }
  }

  async function handleGenerateResponse(opp: SamGovOpportunity) {
    setImportingId(opp.noticeId);
    try {
      const result = await importToOpportunity(opp);
      reportDocuments(result.documents);
      const params = new URLSearchParams({
        new: 'true',
        opportunity_id: result.opportunityId,
        source: 'sam_gov',
      });
      if (result.contactId) params.set('contact_id', result.contactId);
      navigate(`/proposals?${params.toString()}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to prepare response');
    } finally {
      setImportingId(null);
    }
  }

  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);

  const TABS: { id: GovTab; label: string; icon: typeof Search }[] = [
    { id: 'search', label: 'Search', icon: Search },
    { id: 'saved', label: 'Saved', icon: Bookmark },
    { id: 'history', label: 'History', icon: HistoryIcon },
  ];

  return (
    <div className="min-h-dvh bg-hud-bg-deep text-white">
      {/* Header */}
      <div className="border-b border-hud-bg-card bg-hud-bg-deep/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 pt-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-hud-gold/10 rounded-lg flex items-center justify-center">
              <Building2 className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Government Contracting</h1>
              <p className="text-sm text-hud-cream-dim">Search SAM.gov opportunities</p>
            </div>
          </div>
          {/* Tabs */}
          <div className="flex items-center gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    isActive
                      ? 'border-hud-gold text-white'
                      : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        {activeTab === 'search' && (
          <>
            {/* Search Bar & Filters */}
            <div className="bg-hud-bg-mid border border-hud-bg-card rounded-xl p-4 space-y-4">
              {/* Main search row */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                  <input
                    type="text"
                    placeholder="Search keywords (e.g., cybersecurity, IT consulting)..."
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch(0)}
                    className="w-full pl-10 pr-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-1 focus:ring-hud-gold focus:border-hud-gold"
                  />
                </div>
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className="sm:hidden flex items-center justify-center gap-2 px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft"
                >
                  <Filter className="w-4 h-4" />
                  Filters
                  {showFilters ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => handleSearch(0)}
                  disabled={loading}
                  className="flex items-center justify-center gap-2 px-6 py-2.5 bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50 text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  Search
                </button>
                <button
                  onClick={() => setShowSaveForm((v) => !v)}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-hud-bg-card hover:bg-hud-bg-elev border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft transition-colors"
                  title="Save this search"
                >
                  <Bookmark className="w-4 h-4" />
                  Save search
                </button>
              </div>

              {/* Filter row */}
              <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 ${showFilters ? '' : 'hidden sm:grid'}`}>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">NAICS Code</label>
                  <input
                    type="text"
                    placeholder="e.g., 541512"
                    value={naicsCode}
                    onChange={(e) => setNaicsCode(e.target.value)}
                    maxLength={6}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">Notice Type</label>
                  <select
                    value={noticeType}
                    onChange={(e) => setNoticeType(e.target.value)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  >
                    {NOTICE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">Set-Aside Type</label>
                  <select
                    value={setAsideType}
                    onChange={(e) => setSetAsideType(e.target.value)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  >
                    {SET_ASIDE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">State</label>
                  <select
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  >
                    <option value="">Any State</option>
                    {US_STATES.filter(Boolean).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">Posted From</label>
                  <input
                    type="date"
                    value={postedFrom}
                    onChange={(e) => setPostedFrom(e.target.value)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  />
                </div>
                <div>
                  <label className="block text-xs text-hud-cream-dim mb-1">Posted To</label>
                  <input
                    type="date"
                    value={postedTo}
                    onChange={(e) => setPostedTo(e.target.value)}
                    className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  />
                </div>
              </div>

              {/* Save form */}
              {showSaveForm && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-3 border-t border-hud-bg-card">
                  <input
                    type="text"
                    placeholder="Name this search..."
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveSearch()}
                    autoFocus
                    className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white text-sm placeholder-hud-cream-dim focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  />
                  <select
                    value={saveFreq}
                    onChange={(e) => setSaveFreq(e.target.value as 'daily' | 'weekly')}
                    className="px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-hud-gold"
                  >
                    <option value="daily">Daily alerts</option>
                    <option value="weekly">Weekly alerts</option>
                  </select>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveSearch}
                      disabled={savingSearch || !saveName.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:opacity-50 disabled:cursor-not-allowed text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors"
                    >
                      {savingSearch ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Save
                    </button>
                    <button
                      onClick={() => { setShowSaveForm(false); setSaveName(''); }}
                      className="p-2 text-hud-cream-dim hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="px-4 py-3 bg-hud-plum/10 border border-hud-plum/30 rounded-lg text-hud-plum text-sm">
                {error}
              </div>
            )}

            {/* Import success toast */}
            {importSuccess && (
              <div className="px-4 py-3 bg-hud-emerald/10 border border-hud-emerald/30 rounded-lg text-hud-emerald text-sm">
                Opportunity imported to pipeline successfully.
              </div>
            )}

            {/* Results */}
            {loading && !hasSearched ? (
              <ResultsSkeleton />
            ) : !hasSearched ? (
              <EmptyState />
            ) : results.length === 0 ? (
              <div className="text-center py-16">
                <Search className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
                <h3 className="text-lg font-medium text-hud-cream-soft">No opportunities found</h3>
                <p className="text-sm text-hud-cream-mute mt-1">Try adjusting your search criteria.</p>
              </div>
            ) : (
              <>
                {/* Results header */}
                <div className="flex items-center justify-between">
                  <p className="text-sm text-hud-cream-dim">
                    Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, totalRecords)} of{' '}
                    <span className="text-white font-medium">{totalRecords.toLocaleString()}</span> results
                  </p>
                </div>

                {/* Table */}
                <div className="bg-hud-bg-mid border border-hud-bg-card rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-hud-bg-card text-left">
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Title</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hidden lg:table-cell">Sol #</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hidden md:table-cell">Agency</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hidden xl:table-cell">Type</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hidden xl:table-cell">Set-Aside</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">Deadline</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider hidden md:table-cell">Posted</th>
                          <th className="px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hud-bg-card/50">
                        {results.map((opp) => (
                          <ResultRow
                            key={opp.noticeId}
                            opp={opp}
                            expanded={expandedId === opp.noticeId}
                            onToggle={() => toggleExpanded(opp.noticeId)}
                            onImport={() => handleImport(opp)}
                            onGenerateResponse={() => handleGenerateResponse(opp)}
                            importing={importingId === opp.noticeId}
                            importedSuccess={importSuccess === opp.noticeId}
                            resolvedDescription={descCache[opp.noticeId] ?? descError[opp.noticeId]}
                            descriptionLoading={descLoading[opp.noticeId] || false}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => handleSearch(page - 1)}
                      disabled={page === 0 || loading}
                      className="px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev disabled:opacity-40 disabled:cursor-not-allowed border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft transition-colors"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-hud-cream-dim">
                      Page {page + 1} of {totalPages}
                    </span>
                    <button
                      onClick={() => handleSearch(page + 1)}
                      disabled={page >= totalPages - 1 || loading}
                      className="px-4 py-2 bg-hud-bg-card hover:bg-hud-bg-elev disabled:opacity-40 disabled:cursor-not-allowed border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft transition-colors"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === 'saved' && (
          <SavedTab
            searches={saved}
            loading={savedLoading}
            deletingId={savedDeletingId}
            onRun={(c) => applyCriteria(c)}
            onDelete={handleDeleteSaved}
            onToggleAlert={handleToggleAlert}
          />
        )}

        {activeTab === 'history' && (
          <HistoryTab
            entries={history}
            loading={historyLoading}
            onRun={(c) => applyCriteria(c)}
            onDelete={handleDeleteHistory}
            onClear={handleClearHistory}
          />
        )}
      </div>

      <GovContractDrawer
        opp={expandedId ? results.find(o => o.noticeId === expandedId) || null : null}
        isOpen={!!expandedId}
        onClose={() => setExpandedId(null)}
        onImport={handleImport}
        onGenerateResponse={handleGenerateResponse}
        importing={importingId !== null}
        importedSuccess={importSuccess !== null}
        resolvedDescription={expandedId ? (descCache[expandedId] ?? descError[expandedId]) : undefined}
        descriptionLoading={expandedId ? (descLoading[expandedId] || false) : false}
      />
    </div>
  );
}

// --- Saved & History tabs ---

interface SavedTabProps {
  searches: GovSavedSearch[];
  loading: boolean;
  deletingId: string | null;
  onRun: (criteria: SamSearchFilters) => void;
  onDelete: (id: string) => void;
  onToggleAlert: (id: string, enabled: boolean) => void;
}

function SavedTab({ searches, loading, deletingId, onRun, onDelete, onToggleAlert }: SavedTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-hud-cream-dim">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading saved searches...
      </div>
    );
  }
  if (searches.length === 0) {
    return (
      <div className="text-center py-16">
        <Bookmark className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
        <h3 className="text-lg font-medium text-hud-cream-soft">No saved searches yet</h3>
        <p className="text-sm text-hud-cream-mute mt-1">Run a search and click “Save search” to keep it here.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {searches.map((s) => (
        <div key={s.id} className="bg-hud-bg-mid border border-hud-bg-card rounded-xl p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-white truncate">{s.name}</h3>
              <p className="text-xs text-hud-cream-dim mt-0.5 truncate">{summarizeFilters(s.search_criteria)}</p>
            </div>
            <button
              onClick={() => onDelete(s.id)}
              disabled={deletingId === s.id}
              className="text-hud-cream-mute hover:text-hud-plum transition-colors shrink-0"
              title="Delete"
            >
              {deletingId === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => onToggleAlert(s.id, !s.alert_enabled)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                s.alert_enabled
                  ? 'bg-hud-gold/20 text-hud-gold-soft hover:bg-hud-gold/30'
                  : 'bg-hud-bg-card text-hud-cream-dim hover:bg-hud-bg-elev'
              }`}
            >
              {s.alert_enabled ? <Bell className="w-3 h-3" /> : <BellOff className="w-3 h-3" />}
              {s.alert_enabled ? `Alerts ${s.alert_frequency}` : 'Alerts off'}
            </button>
            <button
              onClick={() => onRun(s.search_criteria)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep text-xs font-medium rounded-lg transition-colors"
            >
              <Play className="w-3 h-3" />
              Run
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface HistoryTabProps {
  entries: GovSearchHistoryEntry[];
  loading: boolean;
  onRun: (criteria: SamSearchFilters) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

function HistoryTab({ entries, loading, onRun, onDelete, onClear }: HistoryTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-hud-cream-dim">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history...
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="text-center py-16">
        <HistoryIcon className="w-12 h-12 text-hud-cream-mute mx-auto mb-3" />
        <h3 className="text-lg font-medium text-hud-cream-soft">No past searches</h3>
        <p className="text-sm text-hud-cream-mute mt-1">Searches you run will appear here so you can re-run them.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-hud-cream-dim">{entries.length} recent search{entries.length !== 1 ? 'es' : ''}</p>
        <button
          onClick={onClear}
          className="flex items-center gap-1.5 text-xs text-hud-cream-dim hover:text-hud-plum transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear history
        </button>
      </div>
      <div className="bg-hud-bg-mid border border-hud-bg-card rounded-xl divide-y divide-hud-bg-card/60">
        {entries.map((h) => (
          <div key={h.id} className="flex items-center gap-3 px-4 py-3 hover:bg-hud-bg-card/40 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white truncate">{summarizeFilters(h.search_criteria)}</p>
              <p className="text-xs text-hud-cream-mute mt-0.5 flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(h.created_at).toLocaleString()}
                </span>
                <span>·</span>
                <span>{h.results_count.toLocaleString()} results</span>
              </p>
            </div>
            <button
              onClick={() => onRun(h.search_criteria)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-hud-bg-card hover:bg-hud-gold-deep hover:text-white border border-hud-bg-elev hover:border-hud-gold text-hud-cream-soft text-xs font-medium rounded-lg transition-colors shrink-0"
            >
              <Play className="w-3 h-3" />
              Run
            </button>
            <button
              onClick={() => onDelete(h.id)}
              className="p-1.5 text-hud-cream-mute hover:text-hud-plum transition-colors shrink-0"
              title="Remove"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Sub-components ---

interface ResultRowProps {
  opp: SamGovOpportunity;
  expanded: boolean;
  onToggle: () => void;
  onImport: () => void;
  onGenerateResponse: () => void;
  importing: boolean;
  importedSuccess: boolean;
  resolvedDescription?: string;
  descriptionLoading: boolean;
}

function ResultRow({ opp, expanded, onToggle, onImport, importing, importedSuccess }: ResultRowProps) {
  const deadlineDate = opp.responseDeadLine ? new Date(opp.responseDeadLine) : null;
  const isPastDeadline = deadlineDate ? deadlineDate < new Date() : false;

  return (
    <>
      <tr
        className="hover:bg-hud-bg-card/50 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronUp className="w-4 h-4 text-hud-cream-mute shrink-0" /> : <ChevronDown className="w-4 h-4 text-hud-cream-mute shrink-0" />}
            <span className="text-white font-medium line-clamp-2">{opp.title}</span>
          </div>
        </td>
        <td className="px-4 py-3 text-hud-cream-dim hidden lg:table-cell whitespace-nowrap">
          {opp.solicitationNumber || '--'}
        </td>
        <td className="px-4 py-3 text-hud-cream-dim hidden md:table-cell">
          <span className="line-clamp-1">{opp.department || opp.subTier || '--'}</span>
        </td>
        <td className="px-4 py-3 hidden xl:table-cell">
          <span className="inline-block px-2 py-0.5 bg-hud-bg-card text-hud-cream-soft text-xs rounded-full">
            {opp.type || opp.baseType || '--'}
          </span>
        </td>
        <td className="px-4 py-3 hidden xl:table-cell">
          {opp.typeOfSetAsideDescription ? (
            <span className="inline-block px-2 py-0.5 bg-hud-gold/10 text-hud-gold-soft text-xs rounded-full whitespace-nowrap">
              {opp.typeOfSetAsideDescription}
            </span>
          ) : (
            <span className="text-hud-cream-mute text-xs">--</span>
          )}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className={isPastDeadline ? 'text-hud-plum' : 'text-hud-cream-soft'}>
            {formatDate(opp.responseDeadLine)}
          </span>
        </td>
        <td className="px-4 py-3 text-hud-cream-dim hidden md:table-cell whitespace-nowrap">
          {formatDate(opp.postedDate)}
        </td>
        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-2">
            {opp.uiLink && (
              <a
                href={opp.uiLink}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-hud-cream-dim hover:text-hud-gold-soft transition-colors"
                title="View on SAM.gov"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={onImport}
              disabled={importing || importedSuccess}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                importedSuccess
                  ? 'bg-hud-emerald/20 text-hud-emerald'
                  : 'bg-hud-gold-deep hover:bg-hud-gold text-white hover:text-hud-bg-deep disabled:opacity-50'
              }`}
            >
              {importing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : importedSuccess ? (
                'Imported'
              ) : (
                <>
                  <Plus className="w-3.5 h-3.5" />
                  Import
                </>
              )}
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

interface GovContractDrawerProps {
  opp: SamGovOpportunity | null;
  isOpen: boolean;
  onClose: () => void;
  onImport: (opp: SamGovOpportunity) => void;
  onGenerateResponse: (opp: SamGovOpportunity) => void;
  importing: boolean;
  importedSuccess: boolean;
  resolvedDescription?: string;
  descriptionLoading: boolean;
}

function GovContractDrawer({ opp, isOpen, onClose, onImport, onGenerateResponse, importing, importedSuccess, resolvedDescription, descriptionLoading }: GovContractDrawerProps) {
  if (!opp) return null;

  return (
    <SlideInDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={opp.title}
      subtitle={opp.solicitationNumber ? `Solicitation #: ${opp.solicitationNumber}` : undefined}
      icon={<FileText className="w-5 h-5" />}
      width="3xl"
      footer={
        <div className="flex justify-end gap-3 w-full">
          <button
            onClick={() => onImport(opp)}
            disabled={importing || importedSuccess}
            className={`flex items-center gap-2 px-6 py-2.5 text-sm font-medium rounded-lg transition-colors ${
              importedSuccess
                ? 'bg-hud-emerald/20 text-hud-emerald'
                : 'bg-hud-bg-card hover:bg-hud-bg-elev border border-hud-bg-elev text-white disabled:opacity-50'
            }`}
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : importedSuccess ? (
              'Imported'
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Import
              </>
            )}
          </button>
          <button
            onClick={() => onGenerateResponse(opp)}
            disabled={importing}
            className="flex items-center gap-2 px-6 py-2.5 bg-hud-emerald-dim hover:bg-hud-emerald text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FileSignature className="w-4 h-4" />
            )}
            Generate Response
          </button>
        </div>
      }
    >
      <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Description */}
        <div className="space-y-4 min-w-0">
          <h4 className="text-sm font-medium text-hud-cream-soft flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Description
          </h4>
          {descriptionLoading ? (
            <div className="flex items-center gap-2 text-sm text-hud-cream-mute">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading description...
            </div>
          ) : (
            <div className="text-sm text-hud-cream-dim whitespace-pre-wrap overflow-x-hidden break-words break-all max-w-full">
              {resolvedDescription || (opp.description?.startsWith('http') ? 'Loading...' : opp.description) || 'No description available.'}
            </div>
          )}

          {/* Resource Links */}
          {opp.resourceLinks && opp.resourceLinks.length > 0 && (
            <div className="pt-4 border-t border-hud-bg-card">
              <h5 className="text-xs font-medium text-hud-cream-dim mb-2">Attachments</h5>
              <div className="flex flex-wrap gap-2">
                {opp.resourceLinks.map((link, i) => (
                  <a
                    key={i}
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-3 py-1.5 bg-hud-bg-card hover:bg-hud-bg-elev border border-hud-bg-elev rounded-lg text-xs text-hud-gold-soft transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Resource {i + 1}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Details sidebar */}
        <div className="space-y-8 min-w-0">
          {/* Classification */}
          <div>
            <h4 className="text-sm font-medium text-hud-cream-soft flex items-center gap-2 mb-3">
              <FileText className="w-4 h-4" />
              Classification
            </h4>
            <div className="grid grid-cols-2 bg-hud-bg-card/30 rounded-xl p-4 gap-4 text-sm border border-hud-bg-card">
              <div>
                <span className="text-xs text-hud-cream-mute block mb-1">NAICS Code</span>
                <p className="text-hud-cream-soft">{opp.naicsCode || '--'}</p>
              </div>
              <div>
                <span className="text-xs text-hud-cream-mute block mb-1">PSC Code</span>
                <p className="text-hud-cream-soft">{opp.classificationCode || '--'}</p>
              </div>
              <div>
                <span className="text-xs text-hud-cream-mute block mb-1">Notice ID</span>
                <p className="text-hud-cream-soft text-xs break-all">{opp.noticeId}</p>
              </div>
              <div>
                <span className="text-xs text-hud-cream-mute block mb-1">Archive Date</span>
                <p className="text-hud-cream-soft">{formatDate(opp.archiveDate)}</p>
              </div>
            </div>
          </div>

          {/* Point of Contact */}
          {opp.pointOfContact && opp.pointOfContact.length > 0 && (
            <div>
              <h5 className="text-sm font-medium text-hud-cream-soft mb-3 flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Point of Contact
              </h5>
              <div className="space-y-2">
                {opp.pointOfContact.map((poc, i) => (
                  <div key={i} className="bg-hud-bg-card/50 border border-hud-bg-card rounded-xl p-4 text-sm space-y-1.5">
                    <p className="text-white font-medium">{poc.fullName}</p>
                    {poc.title && <p className="text-xs text-hud-cream-dim">{poc.title}</p>}
                    {poc.email && (
                      <p className="text-hud-cream-dim flex items-center gap-2 mt-2">
                        <Mail className="w-3.5 h-3.5 text-hud-cream-mute" />
                        <a href={`mailto:${poc.email}`} className="text-hud-gold-soft hover:underline break-all">{poc.email}</a>
                      </p>
                    )}
                    {poc.phone && (
                      <p className="text-hud-cream-dim flex items-center gap-2">
                        <Phone className="w-3.5 h-3.5 text-hud-cream-mute" />{poc.phone}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Place of Performance */}
          {opp.placeOfPerformance && (
            <div>
              <h5 className="text-sm font-medium text-hud-cream-soft mb-3 flex items-center gap-2">
                <MapPin className="w-4 h-4" />
                Place of Performance
              </h5>
              <div className="bg-hud-bg-card/30 rounded-xl p-4 border border-hud-bg-card">
                <p className="text-sm text-hud-cream-soft">
                  {[
                    opp.placeOfPerformance.city?.name,
                    opp.placeOfPerformance.state?.code,
                    opp.placeOfPerformance.zip,
                    opp.placeOfPerformance.country?.code !== 'USA' ? opp.placeOfPerformance.country?.code : null,
                  ].filter(Boolean).join(', ') || '--'}
                </p>
              </div>
            </div>
          )}

          {/* Award Info */}
          {opp.award && (
            <div>
              <h5 className="text-sm font-medium text-hud-cream-soft mb-3 flex items-center gap-2">
                <DollarSign className="w-4 h-4" />
                Award Information
              </h5>
              <div className="bg-hud-bg-card/30 rounded-xl p-4 text-sm space-y-2 border border-hud-bg-card">
                {opp.award.amount && <p className="text-hud-emerald font-medium">${Number(opp.award.amount).toLocaleString()}</p>}
                {opp.award.date && <p className="text-hud-cream-dim">Awarded: {formatDate(opp.award.date)}</p>}
                {opp.award.number && <p className="text-hud-cream-dim">Contract #: {opp.award.number}</p>}
                {opp.award.awardee && (
                  <p className="text-hud-cream-soft mt-2">
                    {opp.award.awardee.name}
                    {opp.award.awardee.location && (
                      <span className="text-hud-cream-mute ml-1 block mt-1">
                        ({opp.award.awardee.location.city}, {opp.award.awardee.location.state})
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </SlideInDrawer>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-20">
      <div className="w-20 h-20 bg-hud-bg-card rounded-2xl flex items-center justify-center mx-auto mb-5">
        <Building2 className="w-10 h-10 text-hud-gold-soft/60" />
      </div>
      <h3 className="text-xl font-semibold text-white mb-2">Search SAM.gov Opportunities</h3>
      <p className="text-sm text-hud-cream-dim max-w-md mx-auto mb-1">
        Find federal government contracts, grants, and solicitations from SAM.gov.
      </p>
      <p className="text-sm text-hud-cream-mute max-w-md mx-auto">
        Enter keywords or use filters above to start searching.
      </p>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="bg-hud-bg-mid border border-hud-bg-card rounded-xl overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4 border-b border-hud-bg-card last:border-b-0">
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-hud-bg-card rounded w-3/4 animate-pulse" />
              <div className="h-3 bg-hud-bg-card rounded w-1/2 animate-pulse" />
            </div>
            <div className="hidden md:block h-3 bg-hud-bg-card rounded w-24 animate-pulse" />
            <div className="h-3 bg-hud-bg-card rounded w-20 animate-pulse" />
            <div className="h-8 bg-hud-bg-card rounded w-16 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  MoreHorizontal,
  Copy,
  Trash2,
  Eye,
  Code,
  ExternalLink,
  ArrowLeft,
  ClipboardList,
  Globe,
  Archive,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getSurveys,
  createSurvey,
  duplicateSurvey,
  publishSurvey,
  unpublishSurvey,
  archiveSurvey,
  deleteSurvey,
  generateSurveyEmbedCode,
  getSurveyPublicUrl,
} from '../../services/surveys';
import type { Survey, SurveyStatus } from '../../types';
import { AnchoredMenu } from '../../components/shared/AnchoredMenu';

export function MarketingSurveys() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<SurveyStatus | 'all'>('all');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [showEmbedModal, setShowEmbedModal] = useState<Survey | null>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function openMenu(surveyId: string) {
    const btn = triggerRefs.current[surveyId];
    if (btn) {
      const rect = btn.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setActiveMenu(surveyId);
  }

  function closeMenu() {
    setActiveMenu(null);
    setMenuPos(null);
  }

  useEffect(() => {
    loadSurveys();
  }, [user?.organization_id, statusFilter, searchQuery]);

  useEffect(() => {
    if (!activeMenu) return;
    function handleClose() {
      closeMenu();
    }
    window.addEventListener('scroll', handleClose, true);
    window.addEventListener('resize', handleClose);
    return () => {
      window.removeEventListener('scroll', handleClose, true);
      window.removeEventListener('resize', handleClose);
    };
  }, [activeMenu]);

  async function loadSurveys() {
    if (!user?.organization_id) return;

    try {
      setLoading(true);
      const data = await getSurveys(user.organization_id, {
        status: statusFilter !== 'all' ? [statusFilter] : undefined,
        search: searchQuery || undefined,
      });
      setSurveys(data);
    } catch (error) {
      console.error('Failed to load surveys:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateSurvey() {
    if (!user?.organization_id) return;

    try {
      const survey = await createSurvey(
        user.organization_id,
        user.id,
        'New Survey'
      );
      navigate(`/marketing/surveys/${survey.id}/edit`);
    } catch (error) {
      console.error('Failed to create survey:', error);
    }
  }

  async function handleDuplicate(survey: Survey) {
    if (!user) return;

    try {
      const duplicate = await duplicateSurvey(survey.id, user.id);
      navigate(`/marketing/surveys/${duplicate.id}/edit`);
    } catch (error) {
      console.error('Failed to duplicate survey:', error);
    }
  }

  async function handlePublish(survey: Survey) {
    try {
      await publishSurvey(survey.id);
      loadSurveys();
    } catch (error) {
      console.error('Failed to publish survey:', error);
    }
  }

  async function handleUnpublish(survey: Survey) {
    try {
      await unpublishSurvey(survey.id);
      loadSurveys();
    } catch (error) {
      console.error('Failed to unpublish survey:', error);
    }
  }

  async function handleArchive(survey: Survey) {
    try {
      await archiveSurvey(survey.id);
      loadSurveys();
    } catch (error) {
      console.error('Failed to archive survey:', error);
    }
  }

  async function handleDelete(survey: Survey) {
    if (!confirm('Are you sure you want to delete this survey?')) return;

    try {
      await deleteSurvey(survey.id);
      loadSurveys();
    } catch (error) {
      console.error('Failed to delete survey:', error);
    }
  }

  function getStatusBadge(status: SurveyStatus) {
    switch (status) {
      case 'published':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
            <Globe className="w-3 h-3 mr-1" />
            Published
          </span>
        );
      case 'draft':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-hud-bg-elev text-hud-cream-soft">
            <ClipboardList className="w-3 h-3 mr-1" />
            Draft
          </span>
        );
      case 'archived':
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
            <Archive className="w-3 h-3 mr-1" />
            Archived
          </span>
        );
    }
  }

  const baseUrl = window.location.origin;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/marketing"
            className="p-2 hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-hud-cream-dim" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-white">Surveys</h1>
            <p className="text-sm text-hud-cream-dim">
              Create multi-step surveys with scoring
            </p>
          </div>
        </div>
        <button
          onClick={handleCreateSurvey}
          className="flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim text-white hover:text-hud-bg-deep rounded-lg hover:bg-hud-emerald transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Survey
        </button>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
          <input
            type="text"
            placeholder="Search surveys..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-hud-emerald focus:border-transparent"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SurveyStatus | 'all')}
          className="px-4 py-2 border border-hud-bg-elev rounded-lg focus:outline-none focus:ring-2 focus:ring-hud-emerald"
        >
          <option value="all">All Status</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading ? (
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="p-4 border-b border-hud-bg-elev last:border-b-0 animate-pulse"
            >
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 bg-hud-bg-elev rounded-lg" />
                <div className="flex-1">
                  <div className="h-5 w-48 bg-hud-bg-elev rounded mb-2" />
                  <div className="h-4 w-32 bg-hud-bg-elev rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : surveys.length === 0 ? (
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-12 text-center">
          <ClipboardList className="w-12 h-12 text-hud-cream-soft mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">
            No surveys yet
          </h3>
          <p className="text-hud-cream-dim mb-4">
            Create your first survey to start gathering feedback
          </p>
          <button
            onClick={handleCreateSurvey}
            className="inline-flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim text-white hover:text-hud-bg-deep rounded-lg hover:bg-hud-emerald transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create Survey
          </button>
        </div>
      ) : (
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-hud-bg-card/50 border-b border-hud-bg-elev">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Survey
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Updated
                </th>
                <th className="text-right px-4 py-3 text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-bg-elev">
              {surveys.map((survey) => (
                <tr key={survey.id} className="hover:bg-hud-bg-elev/50">
                  <td className="px-4 py-4">
                    <Link
                      to={`/marketing/surveys/${survey.id}/edit`}
                      className="flex items-center gap-3"
                    >
                      <div className="p-2 bg-hud-emerald/15 rounded-lg">
                        <ClipboardList className="w-5 h-5 text-hud-emerald-dim" />
                      </div>
                      <div>
                        <div className="font-medium text-white">
                          {survey.name}
                        </div>
                        {survey.description && (
                          <div className="text-sm text-hud-cream-dim truncate max-w-xs">
                            {survey.description}
                          </div>
                        )}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-4">{getStatusBadge(survey.status)}</td>
                  <td className="px-4 py-4 text-sm text-hud-cream-dim">
                    {new Date(survey.updated_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {survey.status === 'published' && survey.public_slug && (
                        <>
                          <a
                            href={getSurveyPublicUrl(survey.public_slug, baseUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-2 text-hud-cream-mute hover:text-hud-cream-mute hover:bg-hud-bg-elev rounded-lg"
                            title="View Survey"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                          <button
                            onClick={() => setShowEmbedModal(survey)}
                            className="p-2 text-hud-cream-mute hover:text-hud-cream-mute hover:bg-hud-bg-elev rounded-lg"
                            title="Get Embed Code"
                          >
                            <Code className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      <button
                        ref={(el) => {
                          triggerRefs.current[survey.id] = el;
                        }}
                        onClick={() =>
                          activeMenu === survey.id ? closeMenu() : openMenu(survey.id)
                        }
                        className="p-2 text-hud-cream-mute hover:text-hud-cream-mute hover:bg-hud-bg-elev rounded-lg"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {activeMenu === survey.id && menuPos &&
                        createPortal(
                          <>
                            <div
                              className="fixed inset-0 z-40"
                              onClick={closeMenu}
                            />
                            <AnchoredMenu
                              className="w-48 bg-hud-bg-card rounded-lg shadow-lg border border-hud-bg-elev z-50"
                            >
                              <Link
                                to={`/marketing/surveys/${survey.id}/edit`}
                                className="flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50"
                              >
                                <Eye className="w-4 h-4" />
                                Edit Survey
                              </Link>
                              <button
                                onClick={() => {
                                  handleDuplicate(survey);
                                  closeMenu();
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50"
                              >
                                <Copy className="w-4 h-4" />
                                Duplicate
                              </button>
                              {survey.status === 'draft' && (
                                <button
                                  onClick={() => {
                                    handlePublish(survey);
                                    closeMenu();
                                  }}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-emerald hover:bg-hud-emerald/10"
                                >
                                  <Globe className="w-4 h-4" />
                                  Publish
                                </button>
                              )}
                              {survey.status === 'published' && (
                                <button
                                  onClick={() => {
                                    handleUnpublish(survey);
                                    closeMenu();
                                  }}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-rust hover:bg-hud-rust/10"
                                >
                                  <ClipboardList className="w-4 h-4" />
                                  Unpublish
                                </button>
                              )}
                              {survey.status !== 'archived' && (
                                <button
                                  onClick={() => {
                                    handleArchive(survey);
                                    closeMenu();
                                  }}
                                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50"
                                >
                                  <Archive className="w-4 h-4" />
                                  Archive
                                </button>
                              )}
                              <Link
                                to={`/marketing/surveys/${survey.id}/submissions`}
                                className="flex items-center gap-2 px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev/50"
                              >
                                <Eye className="w-4 h-4" />
                                View Submissions
                              </Link>
                              <hr className="my-1" />
                              <button
                                onClick={() => {
                                  handleDelete(survey);
                                  closeMenu();
                                }}
                                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-hud-plum hover:bg-hud-plum/10"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </button>
                            </AnchoredMenu>
                          </>,
                          document.body
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {showEmbedModal && (
        <EmbedCodeModal
          survey={showEmbedModal}
          baseUrl={baseUrl}
          onClose={() => setShowEmbedModal(null)}
        />
      )}
    </div>
  );
}

function EmbedCodeModal({
  survey,
  baseUrl,
  onClose,
}: {
  survey: Survey;
  baseUrl: string;
  onClose: () => void;
}) {
  const [embedType, setEmbedType] = useState<'iframe' | 'popup' | 'sdk'>('iframe');
  const [copied, setCopied] = useState(false);

  const embedCode = survey.public_slug
    ? generateSurveyEmbedCode(survey.public_slug, { type: embedType, baseUrl })
    : '';

  function handleCopy() {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-hud-bg-card rounded-xl shadow-xl max-w-2xl w-full mx-4 max-h-[90dvh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">
            Embed Survey: {survey.name}
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-hud-bg-elev rounded-lg transition-colors"
          >
            &times;
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex gap-2">
            {(['iframe', 'popup', 'sdk'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setEmbedType(type)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  embedType === type
                    ? 'bg-hud-emerald/15 text-hud-emerald'
                    : 'bg-hud-bg-elev text-hud-cream-dim hover:bg-hud-cream-mute'
                }`}
              >
                {type === 'iframe'
                  ? 'Inline Embed'
                  : type === 'popup'
                  ? 'Popup Button'
                  : 'JavaScript SDK'}
              </button>
            ))}
          </div>

          <div className="relative">
            <pre className="bg-hud-bg-mid text-hud-cream p-4 rounded-lg overflow-x-auto text-sm">
              <code>{embedCode}</code>
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 px-3 py-1 bg-hud-bg-elev hover:bg-hud-cream-mute text-white text-sm rounded transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <div className="bg-hud-emerald/10 border border-hud-emerald/25 rounded-lg p-4">
            <h4 className="font-medium text-hud-emerald-dim mb-1">Direct Link</h4>
            <p className="text-sm text-hud-emerald">
              {survey.public_slug && getSurveyPublicUrl(survey.public_slug, baseUrl)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText,
  ClipboardList,
  Plus,
  TrendingUp,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getFormStats, createForm } from '../../services/forms';
import { getSurveyStats, createSurvey } from '../../services/surveys';
import type { FormStats, SurveyStats } from '../../types';

export function Marketing() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [formStats, setFormStats] = useState<FormStats | null>(null);
  const [surveyStats, setSurveyStats] = useState<SurveyStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingForm, setCreatingForm] = useState(false);
  const [creatingSurvey, setCreatingSurvey] = useState(false);

  useEffect(() => {
    if (!user?.organization_id) return;

    async function loadStats() {
      try {
        const [forms, surveys] = await Promise.all([
          getFormStats(user!.organization_id),
          getSurveyStats(user!.organization_id),
        ]);
        setFormStats(forms);
        setSurveyStats(surveys);
      } catch (error) {
        console.error('Failed to load stats:', error);
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, [user?.organization_id]);

  const modules = [
    {
      id: 'forms',
      name: 'Forms',
      description: 'Capture leads with customizable forms',
      icon: FileText,
      color: 'bg-blue-500',
      href: '/marketing/forms',
      stats: formStats
        ? [
            { label: 'Total Forms', value: formStats.totalForms },
            { label: 'Published', value: formStats.publishedForms },
            { label: 'Submissions (7d)', value: formStats.recentSubmissions },
          ]
        : [],
    },
    {
      id: 'surveys',
      name: 'Surveys',
      description: 'Gather feedback with multi-step surveys',
      icon: ClipboardList,
      color: 'bg-hud-emerald',
      href: '/marketing/surveys',
      stats: surveyStats
        ? [
            { label: 'Total Surveys', value: surveyStats.totalSurveys },
            { label: 'Published', value: surveyStats.publishedSurveys },
            { label: 'Submissions', value: surveyStats.totalSubmissions },
          ]
        : [],
    },
  ];

  async function handleCreateForm() {
    if (!user?.organization_id || creatingForm) return;
    try {
      setCreatingForm(true);
      const form = await createForm(user.organization_id, user.id, 'New Form');
      navigate(`/marketing/forms/${form.id}/edit`);
    } catch (error) {
      console.error('Failed to create form:', error);
      setCreatingForm(false);
    }
  }

  async function handleCreateSurvey() {
    if (!user?.organization_id || creatingSurvey) return;
    try {
      setCreatingSurvey(true);
      const survey = await createSurvey(user.organization_id, user.id, 'New Survey');
      navigate(`/marketing/surveys/${survey.id}/edit`);
    } catch (error) {
      console.error('Failed to create survey:', error);
      setCreatingSurvey(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Marketing</h1>
          <p className="mt-1 text-sm text-hud-cream-dim">
            Forms and surveys
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6 animate-pulse"
            >
              <div className="h-12 w-12 bg-hud-bg-elev rounded-lg mb-4" />
              <div className="h-6 w-32 bg-hud-bg-elev rounded mb-2" />
              <div className="h-4 w-48 bg-hud-bg-elev rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {modules.map((module) => (
            <Link
              key={module.id}
              to={module.href}
              className="group bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6 hover:border-hud-cream-soft hover:shadow-md transition-all"
            >
              <div className="flex items-start justify-between mb-4">
                <div
                  className={`p-3 rounded-lg ${module.color} text-white`}
                >
                  <module.icon className="w-6 h-6" />
                </div>
                <ArrowRight className="w-5 h-5 text-hud-cream-mute group-hover:text-hud-cream-mute group-hover:translate-x-1 transition-all" />
              </div>

              <h3 className="text-lg font-semibold text-white mb-1">
                {module.name}
              </h3>
              <p className="text-sm text-hud-cream-dim mb-4">{module.description}</p>

              {module.stats.length > 0 && (
                <div className="grid grid-cols-3 gap-2 pt-4 border-t border-hud-bg-elev">
                  {module.stats.map((stat, idx) => (
                    <div key={idx} className="text-center">
                      <div className="text-lg font-semibold text-white">
                        {stat.value}
                      </div>
                      <div className="text-xs text-hud-cream-dim">{stat.label}</div>
                    </div>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Quick Actions</h3>
          </div>
          <div className="space-y-3">
            <button
              onClick={handleCreateForm}
              disabled={creatingForm}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-hud-bg-elev hover:border-blue-300 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="p-2 bg-blue-100 rounded-lg">
                {creatingForm ? (
                  <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4 text-blue-600" />
                )}
              </div>
              <div className="text-left">
                <div className="font-medium text-white">
                  {creatingForm ? 'Creating...' : 'Create Form'}
                </div>
                <div className="text-sm text-hud-cream-dim">
                  Build a new lead capture form
                </div>
              </div>
            </button>
            <button
              onClick={handleCreateSurvey}
              disabled={creatingSurvey}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-hud-bg-elev hover:border-hud-emerald/40 hover:bg-hud-emerald/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="p-2 bg-hud-emerald/15 rounded-lg">
                {creatingSurvey ? (
                  <Loader2 className="w-4 h-4 text-hud-emerald-dim animate-spin" />
                ) : (
                  <Plus className="w-4 h-4 text-hud-emerald-dim" />
                )}
              </div>
              <div className="text-left">
                <div className="font-medium text-white">
                  {creatingSurvey ? 'Creating...' : 'Create Survey'}
                </div>
                <div className="text-sm text-hud-cream-dim">
                  Design a feedback survey
                </div>
              </div>
            </button>
          </div>
        </div>

        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Overview</h3>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="p-2 bg-blue-100 rounded-lg">
                <TrendingUp className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1">
                <div className="text-sm text-hud-cream-dim">Total Submissions</div>
                <div className="text-xl font-semibold text-white">
                  {(formStats?.totalSubmissions || 0) +
                    (surveyStats?.totalSubmissions || 0)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="p-2 bg-hud-emerald/15 rounded-lg">
                <FileText className="w-5 h-5 text-hud-emerald-dim" />
              </div>
              <div className="flex-1">
                <div className="text-sm text-hud-cream-dim">Published Forms</div>
                <div className="text-xl font-semibold text-white">
                  {formStats?.publishedForms || 0}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="p-2 bg-blue-100 rounded-lg">
                <ClipboardList className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1">
                <div className="text-sm text-hud-cream-dim">Published Surveys</div>
                <div className="text-xl font-semibold text-white">
                  {surveyStats?.publishedSurveys || 0}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

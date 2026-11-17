import { useState, useEffect } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { Bot, Cpu, Mic, BookOpen, FileText, Shield, Activity, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { AgentsSettingsTab } from '../../components/settings/ai-agents/AgentsSettingsTab';
import { ModelsSettingsTab } from '../../components/settings/ai-agents/ModelsSettingsTab';
import { VoicesSettingsTab } from '../../components/settings/ai-agents/VoicesSettingsTab';
import { KnowledgeSettingsTab } from '../../components/settings/ai-agents/KnowledgeSettingsTab';
import { PromptsSettingsTab } from '../../components/settings/ai-agents/PromptsSettingsTab';
import { ToolsSettingsTab } from '../../components/settings/ai-agents/ToolsSettingsTab';
import { UsageLogsTab } from '../../components/settings/ai-agents/UsageLogsTab';

type TabId = 'agents' | 'models' | 'voices' | 'knowledge' | 'prompts' | 'tools' | 'usage';

interface Tab {
  id: TabId;
  name: string;
  icon: typeof Cpu;
  requiredRole?: 'SuperAdmin' | 'Admin' | 'Manager';
}

const tabs: Tab[] = [
  { id: 'agents', name: 'Agents', icon: Bot },
  { id: 'models', name: 'Models', icon: Cpu },
  { id: 'voices', name: 'Voices', icon: Mic },
  { id: 'knowledge', name: 'Global Knowledge', icon: BookOpen },
  { id: 'prompts', name: 'Prompts & Defaults', icon: FileText },
  { id: 'tools', name: 'Tools & Limits', icon: Shield },
  { id: 'usage', name: 'Usage & Logs', icon: Activity },
];

const BLOCKED_ROLES = ['Team Lead', 'Agent'];

export function AIAgentsSettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>('agents');
  const { user } = useAuth();

  const roleName = user?.role?.name;
  const isSuperAdmin = roleName === 'SuperAdmin';
  const isAdmin = roleName === 'SuperAdmin' || roleName === 'Admin';
  const isManager = roleName === 'Manager';

  const isBlocked = roleName && BLOCKED_ROLES.includes(roleName);
  const isViewOnly = isManager && !isAdmin;

  useEffect(() => {
    const tab = searchParams.get('tab') as TabId;
    if (tab && tabs.some((t) => t.id === tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId });
  };

  if (isBlocked) {
    return <Navigate to="/unauthorized" replace />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">AI Agents</h1>
        <p className="text-hud-cream-dim mt-1">
          Models, voices, prompts, knowledge, tools and limits for CLARA, FRIDAY and every subagent under them
        </p>
      </div>

      {isViewOnly && (
        <div className="bg-hud-rust/10 border border-hud-rust/20 rounded-lg p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-hud-rust shrink-0" />
          <p className="text-hud-rust text-sm">
            You have view-only access to AI settings. Contact an administrator to make changes.
          </p>
        </div>
      )}

      <div className="border-b border-hud-bg-elev">
        <nav className="flex gap-6 overflow-x-auto" aria-label="Tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`flex items-center gap-2 py-3 px-1 border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-hud-gold text-hud-gold-soft'
                    : 'border-transparent text-hud-cream-dim hover:text-white hover:border-hud-cream-mute'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="font-medium">{tab.name}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div>
        {activeTab === 'agents' && <AgentsSettingsTab isViewOnly={isViewOnly} />}
        {activeTab === 'models' && <ModelsSettingsTab />}
        {activeTab === 'voices' && <VoicesSettingsTab />}
        {activeTab === 'knowledge' && (
          <KnowledgeSettingsTab isSuperAdmin={isSuperAdmin} isViewOnly={isViewOnly} />
        )}
        {activeTab === 'prompts' && <PromptsSettingsTab isViewOnly={isViewOnly} />}
        {activeTab === 'tools' && <ToolsSettingsTab />}
        {activeTab === 'usage' && <UsageLogsTab />}
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Globe, AtSign, Bell, Settings, Send, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { OverviewTab } from '../../components/settings/email/OverviewTab';
import { DomainsTab } from '../../components/settings/email/DomainsTab';
import { FromAddressesTab } from '../../components/settings/email/FromAddressesTab';
import { UnsubscribeGroupsTab } from '../../components/settings/email/UnsubscribeGroupsTab';
import { DefaultsTab } from '../../components/settings/email/DefaultsTab';
import { TestTab } from '../../components/settings/email/TestTab';

// Resend is the only provider; its API key is managed in Settings → Integrations → Resend.
type TabId = 'overview' | 'domains' | 'from-addresses' | 'unsubscribe-groups' | 'defaults' | 'test';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ElementType;
  adminOnly?: boolean;
}

const tabs: Tab[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'from-addresses', label: 'From Addresses', icon: AtSign },
  { id: 'unsubscribe-groups', label: 'Unsubscribe Groups', icon: Bell },
  { id: 'defaults', label: 'Defaults', icon: Settings },
  { id: 'test', label: 'Test Email', icon: Send },
];

export function EmailServicesSettingsPage() {
  const { hasPermission } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = hasPermission('email.settings.manage');
  const canTest = hasPermission('email.send.test');

  const visibleTabs = tabs.filter(tab => {
    if (tab.adminOnly && !isAdmin) return false;
    if (tab.id === 'test' && !canTest) return false;
    return true;
  });

  const tabParam = searchParams.get('tab') as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(
    tabParam && visibleTabs.some(t => t.id === tabParam) ? tabParam : 'overview'
  );

  useEffect(() => {
    if (tabParam && visibleTabs.some(t => t.id === tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam, visibleTabs]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId });
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab onNavigate={handleTabChange} />;
      case 'domains':
        return <DomainsTab />;
      case 'from-addresses':
        return <FromAddressesTab />;
      case 'unsubscribe-groups':
        return <UnsubscribeGroupsTab />;
      case 'defaults':
        return <DefaultsTab />;
      case 'test':
        return canTest ? <TestTab /> : null;
      default:
        return <OverviewTab onNavigate={handleTabChange} />;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Email Services</h1>
        <p className="mt-1 text-sm text-hud-cream-dim">
          Configure Resend integration for transactional and marketing emails
        </p>
      </div>

      <div className="border-b border-hud-bg-elev">
        <nav className="flex gap-6 overflow-x-auto" aria-label="Tabs">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`
                  flex items-center gap-2 py-3 px-1 border-b-2 transition-colors whitespace-nowrap
                  ${isActive
                    ? 'border-hud-gold text-hud-gold-soft'
                    : 'border-transparent text-hud-cream-dim hover:text-white hover:border-hud-cream-mute'
                  }
                `}
              >
                <Icon className="w-4 h-4" />
                <span className="font-medium">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div>{renderTabContent()}</div>
    </div>
  );
}

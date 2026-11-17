import { useState, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { Settings, Menu, X } from 'lucide-react';
import { SettingsNav } from '../components/settings/SettingsNav';
import { PageLoader } from '../components/shared/PageLoader';

export function SettingsLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 sm:p-6 border-b border-hud-bg-card">
        <div className="hidden sm:flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-hud-gold/10 to-hud-teal/10 border border-hud-gold/20">
            <Settings className="w-6 h-6 text-hud-gold-soft" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Settings</h1>
            <p className="text-sm text-hud-cream-dim mt-0.5">Manage your account and preferences</p>
          </div>
        </div>

        <button
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
          className="lg:hidden flex items-center justify-center gap-2 w-full sm:w-auto p-2.5 rounded-lg bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white transition-colors text-sm font-medium"
        >
          {mobileNavOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          <span className="sm:hidden">{mobileNavOpen ? 'Close settings menu' : 'Settings menu'}</span>
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Phone/tablet: the open menu replaces the page instead of floating over it (it was half transparent). */}
        <aside
          className={`
            ${mobileNavOpen ? 'flex' : 'hidden'} lg:flex
            flex-col w-full lg:w-64 lg:border-r border-hud-bg-card bg-hud-bg-mid lg:bg-hud-bg-mid/50
          `}
        >
          <SettingsNav onNavigate={() => setMobileNavOpen(false)} />
        </aside>

        <main className={`flex-1 min-w-0 overflow-auto isolate ${mobileNavOpen ? 'hidden lg:block' : ''}`}>
          <div className="p-3 sm:p-6">
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

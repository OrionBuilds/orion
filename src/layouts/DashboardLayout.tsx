import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar';
import { Header } from '../components/Header';
import { CommandPalette } from '../components/CommandPalette';
import { ReAuthModal } from '../components/ReAuthModal';
import { GoogleWorkspaceConnectPrompt } from '../components/GoogleWorkspaceConnectPrompt';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MobileTabBar } from '../components/MobileTabBar';
import { useDevice } from '../contexts/DeviceContext';
import { startPhoneEnhancers } from '../lib/phoneEnhancers';
import { useSidebar } from '../contexts/SidebarContext';
import { useCommandPalette } from '../hooks/useCommandPalette';
import { usePushSync } from '../hooks/usePushNotifications';

// The floating in-app Clara panel is retired: the owner talks to Clara (and FRIDAY) in the pinned
// agent threads at the top of Conversations, backed by the same owner brain (clara-chat /
// runOwnerBrain) and one shared history with SMS.

export function DashboardLayout() {
  const { isExpanded, isMobile, isRail } = useSidebar();
  const { device } = useDevice();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (device !== 'phone' || !mainRef.current) return;
    return startPhoneEnhancers(mainRef.current);
  }, [device]);
  const { isOpen: isCommandPaletteOpen, close: closeCommandPalette } = useCommandPalette();
  usePushSync();

  const sidebarWidth = isMobile ? 'ml-0' : isRail ? 'ml-16' : isExpanded ? 'ml-64' : 'ml-16';

  return (
    <div className="hud-body min-h-dvh flex">
      <span className="hud-corner tl" /><span className="hud-corner tr" />
      <span className="hud-corner bl" /><span className="hud-corner br" />
      <Sidebar />
      <div className={`flex-1 min-w-0 flex flex-col ${sidebarWidth} transition-all duration-200`}>
        <Header />
        {/* main has no definite height (the root is min-h-dvh), so pages scroll the document.
            Pages that need a contained scroll area size themselves with FILL_MAIN_HEIGHT_MD
            (appShell.ts), which assumes this padding and the h-16 Header. */}
        <main
          ref={mainRef}
          className="flex-1 p-3 sm:p-4 md:p-6 overflow-y-auto overflow-x-hidden"
          style={device === 'phone' ? { paddingBottom: 'calc(var(--tabbar-h) + var(--safe-bottom) + 0.75rem)' } : undefined}
        >
          <GoogleWorkspaceConnectPrompt />
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <MobileTabBar />
      <CommandPalette isOpen={isCommandPaletteOpen} onClose={closeCommandPalette} />
      <ReAuthModal />
    </div>
  );
}

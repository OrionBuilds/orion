import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useDevice } from './DeviceContext';

interface SidebarState {
  isExpanded: boolean;
  collapsedGroups: Set<string>;
  isMobileOpen: boolean;
  /** Drawer mode: phone, tablet portrait, or any window under 1024px. */
  isMobile: boolean;
  /** Tablet landscape: a 64px icon rail that expands over the content (railOpen). */
  isRail: boolean;
  railOpen: boolean;
}

interface SidebarContextValue extends SidebarState {
  toggleSidebar: () => void;
  toggleGroup: (groupId: string) => void;
  isGroupCollapsed: (groupId: string) => boolean;
  expandSidebar: () => void;
  collapseSidebar: () => void;
  toggleMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  closeRail: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const { navMode } = useDevice();
  const isMobile = navMode === 'drawer';
  const isRail = navMode === 'rail';

  // Changing device class (rotating an iPad, resizing a window) closes whichever overlay was open.
  useEffect(() => {
    setIsMobileOpen(false);
    setRailOpen(false);
  }, [navMode]);

  const toggleSidebar = useCallback(() => {
    if (isRail) setRailOpen((prev) => !prev);
    else setIsExpanded((prev) => !prev);
  }, [isRail]);

  const expandSidebar = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const collapseSidebar = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const toggleMobileSidebar = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  const closeMobileSidebar = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const closeRail = useCallback(() => {
    setRailOpen(false);
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const isGroupCollapsed = useCallback(
    (groupId: string) => collapsedGroups.has(groupId),
    [collapsedGroups]
  );

  return (
    <SidebarContext.Provider
      value={{
        isExpanded,
        collapsedGroups,
        isMobileOpen,
        isMobile,
        isRail,
        railOpen,
        toggleSidebar,
        toggleGroup,
        isGroupCollapsed,
        expandSidebar,
        collapseSidebar,
        toggleMobileSidebar,
        closeMobileSidebar,
        closeRail,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
}

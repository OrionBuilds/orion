import { useOutletContext } from 'react-router-dom';

export interface TabbedModuleContext {
  inTabbedModule: true;
}

/** Passed as <Outlet context> by layouts that already show the module title above their tabs. */
export const TABBED_MODULE_CONTEXT: TabbedModuleContext = { inTabbedModule: true };

/** True when the page renders as a tab under such a layout, so it should skip its own title. */
export function useInTabbedModule(): boolean {
  return useOutletContext<TabbedModuleContext | undefined>()?.inTabbedModule === true;
}

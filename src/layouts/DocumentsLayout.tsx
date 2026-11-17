import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { ModuleTabs } from '../components/layouts';
import { PageLoader } from '../components/shared/PageLoader';
import { documentsTabs } from '../config/navigation';
import { TABBED_MODULE_CONTEXT } from '../hooks/useInTabbedModule';

// Proposals and Contracts keep their own URLs; this only adds the shared tab bar.
export function DocumentsLayout() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-semibold text-white">Documents</h1>
        <ModuleTabs tabs={documentsTabs} />
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<PageLoader />}>
          <Outlet context={TABBED_MODULE_CONTEXT} />
        </Suspense>
      </div>
    </div>
  );
}

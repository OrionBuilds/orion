import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

interface DashboardSectionProps {
  title: string;
  viewAllLink?: string;
  viewAllLabel?: string;
  children: ReactNode;
  isLoading?: boolean;
  className?: string;
}

export function DashboardSection({
  title,
  viewAllLink,
  viewAllLabel = 'View all',
  children,
  isLoading,
  className = '',
}: DashboardSectionProps) {
  return (
    <div className={`bg-hud-bg-card rounded-xl border border-hud-bg-elev ${className}`}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-hud-bg-elev">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {viewAllLink && (
          <Link
            to={viewAllLink}
            className="flex items-center gap-1 text-xs font-medium text-hud-gold-soft hover:text-hud-gold-soft transition-colors"
          >
            {viewAllLabel}
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className="p-5">{isLoading ? <LoadingSkeleton /> : children}</div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-10 w-10 bg-hud-bg-elev rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-3/4 bg-hud-bg-elev rounded" />
            <div className="h-3 w-1/2 bg-hud-bg-elev rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function DocumentLoadingState() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-8 h-8 text-hud-gold-soft animate-spin" />
    </div>
  );
}

interface DocumentNotFoundStateProps {
  icon: LucideIcon;
  label: string;
  backHref: string;
  backLabel: string;
}

export function DocumentNotFoundState({ icon: Icon, label, backHref, backLabel }: DocumentNotFoundStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-hud-cream-dim">
      <Icon className="w-12 h-12 mb-4 opacity-50" />
      <p>{label}</p>
      <Link to={backHref} className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft">
        {backLabel}
      </Link>
    </div>
  );
}

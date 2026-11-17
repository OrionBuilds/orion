import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Portal } from '../shared/Portal';

type DrawerSize = 'sm' | 'md' | 'lg' | 'xl';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  size?: DrawerSize;
  children: ReactNode;
  footer?: ReactNode;
}

const sizeClasses: Record<DrawerSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
};

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
}: DrawerProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-hidden">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />
      <div className="absolute inset-y-0 right-0 flex">
        <div
          className={`relative w-screen ${sizeClasses[size]} bg-hud-bg-mid border-l border-hud-bg-card shadow-xl flex flex-col transform transition-transform duration-300 ease-in-out`}
          style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-hud-bg-card">
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              {subtitle && <p className="text-sm text-hud-cream-dim mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors text-hud-cream-dim hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">{children}</div>

          {footer && (
            <div className="px-6 py-4 border-t border-hud-bg-card bg-hud-bg-mid/50">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div></Portal>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface SlideInDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
}

const widthClasses = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-xl',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-6xl',
};

export function SlideInDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  width = 'lg',
}: SlideInDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && drawerRef.current) {
      drawerRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <Portal><div className="fixed inset-0 z-50 overflow-hidden">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full pl-10">
        <div
          ref={drawerRef}
          tabIndex={-1}
          className={`w-screen ${widthClasses[width]} transform transition-transform duration-300 ease-out`}
          style={{ transform: isOpen ? 'translateX(0)' : 'translateX(100%)' }}
        >
          <div className="flex h-full flex-col bg-hud-bg-mid border-l border-hud-bg-card shadow-xl">
            {(title || icon) && (
              <div className="flex items-center justify-between px-6 py-5 border-b border-hud-bg-card">
                <div className="flex items-center gap-3">
                  {icon && (
                    <div className="w-10 h-10 rounded-lg bg-hud-gold/10 flex items-center justify-center text-hud-gold-soft">
                      {icon}
                    </div>
                  )}
                  <div>
                    {title && <h2 className="text-lg font-semibold text-white">{title}</h2>}
                    {subtitle && <p className="text-sm text-hud-cream-dim mt-0.5">{subtitle}</p>}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
                  aria-label="Close drawer"
                >
                  <X className="w-5 h-5 text-hud-cream-dim" />
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">{children}</div>

            {footer && (
              <div className="border-t border-hud-bg-card px-6 py-4 bg-hud-bg-mid">{footer}</div>
            )}
          </div>
        </div>
      </div>
    </div></Portal>
  );
}

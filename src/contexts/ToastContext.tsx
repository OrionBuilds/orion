import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { X, MessageSquare, CheckCircle, AlertTriangle, Info, XCircle } from 'lucide-react';

type ToastType = 'message' | 'success' | 'warning' | 'info' | 'error';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

interface ToastContextValue {
  showToast: (type: ToastType, title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 5000;

const iconMap: Record<ToastType, typeof MessageSquare> = {
  message: MessageSquare,
  success: CheckCircle,
  warning: AlertTriangle,
  info: Info,
  error: XCircle,
};

const colorMap: Record<ToastType, { bg: string; icon: string; border: string }> = {
  message: { bg: 'bg-hud-bg-card', icon: 'text-hud-gold-soft', border: 'border-hud-gold/30' },
  success: { bg: 'bg-hud-bg-card', icon: 'text-hud-emerald', border: 'border-hud-emerald/30' },
  warning: { bg: 'bg-hud-bg-card', icon: 'text-hud-rust', border: 'border-hud-rust/30' },
  info: { bg: 'bg-hud-bg-card', icon: 'text-blue-400', border: 'border-blue-500/30' },
  error: { bg: 'bg-hud-bg-card', icon: 'text-hud-plum', border: 'border-hud-plum/30' },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const Icon = iconMap[toast.type] || MessageSquare;
  const colors = colorMap[toast.type] || colorMap.message;

  return (
    <div
      className={`${colors.bg} border ${colors.border} rounded-lg shadow-2xl shadow-black/40 px-4 py-3 flex items-start gap-3 min-w-[320px] max-w-[420px] animate-slide-in-right`}
    >
      <div className={`mt-0.5 ${colors.icon} flex-shrink-0`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-hud-cream-dim mt-0.5 line-clamp-2">{toast.description}</p>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-hud-cream-mute hover:text-hud-cream-soft transition-colors flex-shrink-0 mt-0.5"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (type: ToastType, title: string, description?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-4), { id, type, title, description }]);
      setTimeout(() => dismiss(id), TOAST_DURATION);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

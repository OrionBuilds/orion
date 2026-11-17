import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';

interface ExportButtonProps {
  onExport: () => Promise<void>;
  label?: string;
  disabled?: boolean;
}

export function ExportButton({ onExport, label = 'Export PDF', disabled = false }: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleClick = async () => {
    if (isExporting || disabled) return;

    setIsExporting(true);
    try {
      await onExport();
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isExporting || disabled}
      className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-hud-bg-card border border-hud-cream-soft dark:border-hud-cream-mute rounded-lg hover:border-hud-cream-dim dark:hover:border-hud-cream-mute transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isExporting ? (
        <Loader2 className="w-4 h-4 text-hud-cream-mute animate-spin" />
      ) : (
        <FileDown className="w-4 h-4 text-hud-cream-mute" />
      )}
      <span className="text-sm font-medium text-hud-bg-elev dark:text-hud-cream-soft">
        {isExporting ? 'Exporting...' : label}
      </span>
    </button>
  );
}

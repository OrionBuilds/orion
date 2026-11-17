import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Search, Filter, ChevronDown, X } from 'lucide-react';

interface SortOption {
  label: string;
  value: string;
}

interface FilterBarProps {
  searchPlaceholder?: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filterCount?: number;
  onFilterClick?: () => void;
  sortOptions?: SortOption[];
  sortValue?: string;
  onSortChange?: (value: string) => void;
  children?: ReactNode;
}

export function FilterBar({
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  filterCount = 0,
  onFilterClick,
  sortOptions,
  sortValue,
  onSortChange,
  children,
}: FilterBarProps) {
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const sortDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(event.target as Node)) {
        setShowSortDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedSort = sortOptions?.find((opt) => opt.value === sortValue);

  return (
    <div className="flex flex-col sm:flex-row gap-3 mb-4">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:border-hud-gold focus:ring-1 focus:ring-hud-gold text-sm"
        />
        {searchValue && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-hud-cream-mute hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {onFilterClick && (
          <button
            onClick={onFilterClick}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors flex items-center gap-2 ${
              filterCount > 0
                ? 'bg-hud-gold/10 border-hud-gold/30 text-hud-gold-soft'
                : 'bg-hud-bg-card border-hud-bg-elev text-hud-cream-soft hover:bg-hud-bg-elev'
            }`}
          >
            <Filter className="w-4 h-4" />
            <span>Filters</span>
            {filterCount > 0 && (
              <span className="min-w-[20px] h-5 px-1.5 bg-hud-gold text-hud-bg-deep text-xs font-semibold rounded-full flex items-center justify-center">
                {filterCount}
              </span>
            )}
          </button>
        )}

        {sortOptions && sortOptions.length > 0 && onSortChange && (
          <div className="relative" ref={sortDropdownRef}>
            <button
              onClick={() => setShowSortDropdown(!showSortDropdown)}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev text-hud-cream-soft rounded-lg hover:bg-hud-bg-elev transition-colors flex items-center gap-2 text-sm"
            >
              <span>{selectedSort?.label || 'Sort'}</span>
              <ChevronDown className="w-4 h-4" />
            </button>
            {showSortDropdown && (
              <div className="absolute right-0 mt-2 w-48 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-50 overflow-hidden">
                {sortOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      onSortChange(option.value);
                      setShowSortDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-sm text-left transition-colors ${
                      option.value === sortValue
                        ? 'bg-hud-gold/10 text-hud-gold-soft'
                        : 'text-hud-cream-soft hover:bg-hud-bg-elev'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

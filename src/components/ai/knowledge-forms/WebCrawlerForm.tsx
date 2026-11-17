import { useState } from 'react';
import { Globe, Loader2, Check, AlertCircle } from 'lucide-react';
import { FormFooter } from './FormFooter';
import type { WebCrawlerSourceConfig } from '../../../types';
import * as agentKnowledgeService from '../../../services/agentKnowledge';

interface WebCrawlerFormProps {
  existingConfig: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
  isEditing: boolean;
}

export function WebCrawlerForm({
  existingConfig,
  onSave,
  onCancel,
  saving,
  isEditing,
}: WebCrawlerFormProps) {
  const config = existingConfig as Partial<WebCrawlerSourceConfig>;
  const [url, setUrl] = useState(config.url || '');
  const [crawlType, setCrawlType] = useState<'exact' | 'domain' | 'sitemap'>(
    config.crawlType || 'exact'
  );
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedPages, setExtractedPages] = useState<Array<{ url: string; content: string }>>([]);
  const [extractError, setExtractError] = useState<string | null>(null);

  const handleExtract = async () => {
    if (!url.trim()) return;

    setIsExtracting(true);
    setExtractError(null);
    setExtractedPages([]);

    try {
      const result = await agentKnowledgeService.crawlWebsite(url, crawlType === 'exact' ? 1 : 3);
      if (result.success && result.pages && result.pages.length > 0) {
        setExtractedPages(result.pages);
      } else {
        setExtractError(result.error || 'No content could be extracted from this URL. The site may be blocking automated requests.');
      }
    } catch (err) {
      setExtractError(
        err instanceof Error ? err.message : 'Failed to connect to the website. Please check the URL and try again.'
      );
    } finally {
      setIsExtracting(false);
    }
  };

  const handleSubmit = () => {
    const newConfig: WebCrawlerSourceConfig = {
      url: url.trim(),
      crawlType,
      depth: crawlType === 'exact' ? 1 : 3,
    };
    onSave(newConfig);
  };

  return (
    <div>
      <div className="flex items-center gap-3 p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev mb-6">
        <Globe className="w-6 h-6 text-blue-400" />
        <div>
          <h3 className="font-medium text-white">Web Crawler</h3>
          <p className="text-sm text-hud-cream-dim">Crawl and extract content from a website to train your bot.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-2">Enter Domain</label>
          <div className="flex gap-3">
            <select
              value={crawlType}
              onChange={(e) => setCrawlType(e.target.value as 'exact' | 'domain' | 'sitemap')}
              className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="exact">Exact URL</option>
              <option value="domain">Domain</option>
              <option value="sitemap">Sitemap</option>
            </select>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
            <button
              onClick={handleExtract}
              disabled={!url.trim() || isExtracting}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {isExtracting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              Extract Data
            </button>
          </div>
          <p className="text-xs text-hud-cream-mute mt-2">
            Extract Data is optional -- your URL will be crawled when the source is created.
          </p>
        </div>

        {extractError && (
          <div className="flex items-start gap-2 p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-lg">
            <AlertCircle className="w-4 h-4 text-hud-plum mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm text-hud-plum">{extractError}</p>
              <p className="text-xs text-hud-plum/70 mt-1">
                You can still create the source -- it will attempt to fetch the page when processing.
              </p>
            </div>
          </div>
        )}

        {extractedPages.length > 0 && (
          <div className="bg-hud-bg-card border border-hud-emerald/20 rounded-lg p-4">
            <h4 className="text-sm font-medium text-hud-emerald mb-3">
              Extracted {extractedPages.length} page(s) successfully
            </h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {extractedPages.map((page, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <Check className="w-4 h-4 text-hud-emerald flex-shrink-0" />
                  <span className="text-hud-cream-soft truncate">{page.url}</span>
                  <span className="text-hud-cream-mute text-xs flex-shrink-0">
                    {page.content.length.toLocaleString()} chars
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <FormFooter
        onCancel={onCancel}
        onSubmit={handleSubmit}
        saving={saving}
        isEditing={isEditing}
        disabled={!url.trim()}
      />
    </div>
  );
}

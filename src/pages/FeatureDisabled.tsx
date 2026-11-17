import { useNavigate } from 'react-router-dom';
import { Lock, ArrowLeft } from 'lucide-react';

export function FeatureDisabled() {
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh bg-hud-bg-deep flex items-center justify-center px-4">
      <div className="text-center">
        <div className="w-20 h-20 rounded-2xl bg-hud-rust/10 border border-hud-rust/20 flex items-center justify-center mx-auto mb-6">
          <Lock className="w-10 h-10 text-hud-rust" />
        </div>
        <h1 className="text-2xl font-semibold text-white mb-2">Feature Unavailable</h1>
        <p className="text-hud-cream-dim max-w-md mb-8">
          This feature is currently disabled. Check back later or contact your administrator for more information.
        </p>
        <button
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </button>
      </div>
    </div>
  );
}

import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  onRetry?: () => void;
}

interface State {
  hasError: boolean;
}

export class ConversationErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ConversationErrorBoundary caught:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center bg-hud-bg-mid">
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 rounded-full bg-hud-rust/10 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-7 h-7 text-hud-rust" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">
              Something went wrong
            </h3>
            <p className="text-sm text-hud-cream-dim mb-6">
              There was a problem loading this conversation. Please try again.
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false });
                this.props.onRetry?.();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white hover:text-hud-bg-deep rounded-lg hover:bg-hud-gold transition-colors text-sm font-medium"
            >
              <RefreshCw size={16} />
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

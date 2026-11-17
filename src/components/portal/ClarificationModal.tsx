import { useState } from 'react';
import { MessageSquare, Send, AlertCircle } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface Props {
  authorName: string;
  onSend: (message: string) => Promise<void>;
  onClose: () => void;
}

export function ClarificationModal({ authorName, onSend, onClose }: Props) {
  const [message, setMessage] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  async function handleSend() {
    if (!message.trim()) return;
    setProcessing(true);
    setError('');
    try {
      await onSend(message.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send. Please try again.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white [color-scheme:light] rounded-2xl shadow-xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-base font-bold text-hud-bg-mid">Request Clarification</h2>
            <p className="text-sm text-hud-cream-mute">Send a message to the project team</p>
          </div>
        </div>

        <p className="text-sm text-hud-cream-mute mb-4">
          Ask a question or request more information before making a decision. The project team will be notified.
        </p>

        <div className="mb-5">
          <label className="block text-sm font-medium text-hud-bg-elev mb-1.5">
            Your message <span className="text-hud-plum">*</span>
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="What additional information do you need?"
            className="w-full px-3 py-2.5 text-sm border border-hud-cream-soft rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none bg-white text-hud-bg-mid placeholder-hud-cream-mute"
            autoFocus
          />
          <p className="mt-1 text-xs text-hud-cream-dim">Sending as: {authorName}</p>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-hud-plum bg-hud-plum/10 border border-hud-plum/25 rounded-lg px-3 py-2 mb-4">
            <AlertCircle className="w-4 h-4 flex-none" />
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm text-hud-cream-mute bg-hud-cream hover:bg-hud-cream-soft rounded-xl transition-colors font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={processing || !message.trim()}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-xl transition-colors"
          >
            <Send className="w-4 h-4" />
            {processing ? 'Sending...' : 'Send Message'}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}

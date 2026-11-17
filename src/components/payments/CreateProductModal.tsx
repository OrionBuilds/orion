import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { createProduct } from '../../services/products';
import type { BillingType } from '../../types';
import { X, Loader2, Package } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface CreateProductModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateProductModal({ onClose, onCreated }: CreateProductModalProps) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceAmount, setPriceAmount] = useState('');
  const [billingType, setBillingType] = useState<BillingType>('one_time');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !name.trim() || !priceAmount) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await createProduct(
        {
          name: name.trim(),
          description: description.trim() || undefined,
          price_amount: parseFloat(priceAmount),
          billing_type: billingType,
        },
        user
      );
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create product');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Portal><div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-hud-bg-mid rounded-xl border border-hud-bg-card shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Package className="w-5 h-5 text-hud-emerald" />
            New Product
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-hud-bg-card text-hud-cream-dim">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Product Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Consulting Service"
              className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Product description (shown on invoices)"
              rows={3}
              className="w-full px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Price *
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-hud-cream-dim">$</span>
              <input
                type="number"
                value={priceAmount}
                onChange={(e) => setPriceAmount(e.target.value)}
                placeholder="0.00"
                step="0.01"
                min="0"
                className="w-full pl-8 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Billing Type
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setBillingType('one_time')}
                className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  billingType === 'one_time'
                    ? 'bg-hud-emerald/10 border-hud-emerald/30 text-hud-emerald'
                    : 'bg-hud-bg-card border-hud-bg-elev text-hud-cream-dim hover:border-hud-cream-mute'
                }`}
              >
                One-time
              </button>
              <button
                type="button"
                onClick={() => setBillingType('recurring')}
                className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  billingType === 'recurring'
                    ? 'bg-hud-gold/10 border-hud-gold/30 text-hud-gold-soft'
                    : 'bg-hud-bg-card border-hud-bg-elev text-hud-cream-dim hover:border-hud-cream-mute'
                }`}
              >
                Recurring
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim() || !priceAmount}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-emerald to-hud-teal text-white font-medium hover:from-hud-emerald-dim hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Product'
              )}
            </button>
          </div>
        </form>
      </div>
    </div></Portal>
  );
}
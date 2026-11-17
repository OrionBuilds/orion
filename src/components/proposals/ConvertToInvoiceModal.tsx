import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { createInvoice } from '../../services/invoices';
import type { Proposal, CreateInvoiceInput } from '../../types';
import { X, FileText, Loader2, DollarSign, Calendar } from 'lucide-react';
import { Portal } from '../shared/Portal';

interface ConvertToInvoiceModalProps {
  proposal: Proposal;
  onClose: () => void;
  onConverted: () => void;
}

export function ConvertToInvoiceModal({ proposal, onClose, onConverted }: ConvertToInvoiceModalProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dueDate, setDueDate] = useState('');
  const [autoSend, setAutoSend] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultDueDate = () => {
    const date = new Date();
    date.setDate(date.getDate() + 30);
    return date.toISOString().split('T')[0];
  };

  const handleConvert = async () => {
    if (!user || !proposal.line_items || proposal.line_items.length === 0) {
      setError('Proposal must have line items to convert to an invoice');
      return;
    }
    if (!proposal.contact_id) {
      // The contact was deleted; it relinks automatically when re-added with the same email.
      setError('This proposal has no linked contact. Re-add the contact (same email) to link it back, then convert.');
      return;
    }

    try {
      setIsConverting(true);
      setError(null);

      const invoiceInput: CreateInvoiceInput = {
        contact_id: proposal.contact_id,
        opportunity_id: proposal.opportunity_id || undefined,
        line_items: proposal.line_items.map(item => ({
          product_id: item.product_id || undefined,
          description: item.description || item.name,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
        discount_amount: 0,
        discount_type: 'flat',
        due_date: dueDate || defaultDueDate(),
        memo: `Converted from proposal: ${proposal.title}`,
        internal_notes: `Source proposal ID: ${proposal.id}`,
        auto_send: autoSend,
      };

      const invoice = await createInvoice(invoiceInput, user);

      navigate(`/payments/invoices/${invoice.id}`);
      onConverted();
    } catch (err) {
      console.error('Failed to convert proposal to invoice:', err);
      setError('Failed to create invoice. Please try again.');
    } finally {
      setIsConverting(false);
    }
  };

  const lineItemsTotal = proposal.line_items?.reduce((sum, item) => {
    const subtotal = item.quantity * item.unit_price;
    const discount = subtotal * (item.discount_percent / 100);
    return sum + (subtotal - discount);
  }, 0) || 0;

  return (
    <Portal><div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-elev w-full max-w-3xl max-h-[90dvh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-hud-bg-elev flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-hud-gold-soft" />
              Convert to Invoice
            </h2>
            <p className="text-sm text-hud-cream-dim mt-1">
              Create an invoice from this proposal
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-hud-bg-card rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="space-y-6">
            {error && (
              <div className="p-4 bg-hud-plum/10 border border-hud-plum/30 rounded-lg">
                <p className="text-sm text-hud-plum">{error}</p>
              </div>
            )}

            <div className="p-4 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev">
              <h3 className="text-sm font-medium text-hud-cream-soft mb-3">Proposal Details</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-hud-cream-dim">Title:</span>
                  <span className="text-white">{proposal.title}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-hud-cream-dim">Contact:</span>
                  <span className="text-white">
                    {proposal.contact?.first_name} {proposal.contact?.last_name}
                  </span>
                </div>
                {proposal.opportunity && (
                  <div className="flex justify-between">
                    <span className="text-hud-cream-dim">Opportunity:</span>
                    <span className="text-white">{proposal.opportunity.stage?.name}</span>
                  </div>
                )}
              </div>
            </div>

            {proposal.line_items && proposal.line_items.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-hud-cream-soft mb-3">
                  Line Items ({proposal.line_items.length})
                </h3>
                <div className="border border-hud-bg-elev rounded-lg overflow-hidden">
                  <div className="max-h-64 overflow-y-auto">
                    <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-hud-bg-card sticky top-0">
                        <tr>
                          <th className="text-left px-4 py-2 text-hud-cream-soft font-medium">Item</th>
                          <th className="text-right px-4 py-2 text-hud-cream-soft font-medium">Qty</th>
                          <th className="text-right px-4 py-2 text-hud-cream-soft font-medium">Price</th>
                          <th className="text-right px-4 py-2 text-hud-cream-soft font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hud-bg-elev">
                        {proposal.line_items.map((item) => {
                          const subtotal = item.quantity * item.unit_price;
                          const discount = subtotal * (item.discount_percent / 100);
                          const total = subtotal - discount;

                          return (
                            <tr key={item.id} className="bg-hud-bg-card/30">
                              <td className="px-4 py-2 text-white">{item.name}</td>
                              <td className="px-4 py-2 text-right text-hud-cream-soft">{item.quantity}</td>
                              <td className="px-4 py-2 text-right text-hud-cream-soft">
                                {proposal.currency} {item.unit_price.toLocaleString()}
                              </td>
                              <td className="px-4 py-2 text-right text-white">
                                {proposal.currency} {total.toLocaleString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-hud-bg-card border-t-2 border-hud-cream-mute">
                        <tr>
                          <td colSpan={3} className="px-4 py-2 text-right font-semibold text-white">
                            Total
                          </td>
                          <td className="px-4 py-2 text-right font-semibold text-white">
                            {proposal.currency} {lineItemsTotal.toLocaleString()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                <Calendar className="w-4 h-4 inline mr-1" />
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                placeholder={defaultDueDate()}
                className="w-full px-4 py-2.5 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
              />
              <p className="text-xs text-hud-cream-dim mt-1">
                Default: 30 days from today
              </p>
            </div>

            <div className="p-4 bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={(e) => setAutoSend(e.target.checked)}
                  className="mt-0.5 w-5 h-5 rounded border-hud-cream-mute bg-hud-bg-elev text-hud-gold focus:ring-hud-gold/50"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">Send invoice immediately</span>
                  </div>
                  <p className="text-sm text-hud-cream-dim mt-1">
                    The invoice will be marked as sent and the client will be notified
                  </p>
                </div>
              </label>
            </div>

            <div className="p-4 bg-hud-gold/10 border border-hud-gold/30 rounded-lg">
              <div className="flex items-start gap-2">
                <DollarSign className="w-5 h-5 text-hud-gold-soft flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-hud-gold-soft mb-1">What happens next?</h4>
                  <ul className="text-sm text-hud-cream-soft space-y-1">
                    <li>• Invoice will be created with all line items from this proposal</li>
                    <li>• Original proposal will remain unchanged</li>
                    <li>• You can edit the invoice after creation</li>
                    {autoSend && <li>• Client will receive an email with the invoice</li>}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-hud-bg-elev flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isConverting}
            className="px-4 py-2 text-hud-cream-soft hover:text-white transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConvert}
            disabled={isConverting}
            className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg transition-colors"
          >
            {isConverting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Converting...
              </>
            ) : (
              <>
                <FileText className="w-4 h-4" />
                Create Invoice
              </>
            )}
          </button>
        </div>
      </div>
    </div></Portal>
  );
}

import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getInvoice, sendInvoice, voidInvoice, setInvoiceDispute } from '../../services/invoices';
import type { Invoice, InvoiceStatus } from '../../types';
import {
  ArrowLeft,
  FileText,
  Loader2,
  Send,
  XCircle,
  Copy,
  ExternalLink,
  CheckCircle2,
  User,
  Building2,
  Calendar,
  Clock,
  DollarSign,
  CreditCard,
  AlertCircle,
} from 'lucide-react';
import { formatCurrency, formatDateLong, formatDateTimeShort } from '../../utils/formatters';

const STATUS_STYLES: Record<InvoiceStatus, { bg: string; text: string; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', label: 'Draft' },
  sent: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', label: 'Sent' },
  paid: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', label: 'Paid' },
  overdue: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', label: 'Overdue' },
  void: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Void' },
};

export function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, hasPermission } = useAuth();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSend = hasPermission('invoices.send');
  const canVoid = hasPermission('invoices.void');

  useEffect(() => {
    if (id) {
      loadInvoice();
    }
  }, [id]);

  const loadInvoice = async () => {
    if (!id) return;
    try {
      setIsLoading(true);
      const data = await getInvoice(id);
      setInvoice(data);
    } catch (err) {
      console.error('Failed to load invoice:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (!invoice || !user) return;
    try {
      setIsProcessing(true);
      setErrorMessage(null);
      await sendInvoice(invoice.id, user);
      await loadInvoice();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send invoice';
      setErrorMessage(msg);
      console.error('Failed to send invoice:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDisputeToggle = async () => {
    if (!invoice) return;
    const disputing = !invoice.disputed_at;
    let note: string | undefined;
    if (disputing) {
      const answer = window.prompt('What is the dispute? (optional, shown to your team)');
      if (answer === null) return; // cancelled: do not place the hold
      note = answer;
    }
    try {
      setIsProcessing(true);
      setErrorMessage(null);
      await setInvoiceDispute(invoice.id, disputing, note);
      await loadInvoice();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to update dispute hold');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVoid = async () => {
    if (!invoice || !user || !confirm('Are you sure you want to void this invoice?')) return;
    try {
      setIsProcessing(true);
      setErrorMessage(null);
      await voidInvoice(invoice.id, user);
      await loadInvoice();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to void invoice';
      setErrorMessage(msg);
      console.error('Failed to void invoice:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const copyPaymentLink = () => {
    if (invoice?.payment_link_url) {
      navigator.clipboard.writeText(invoice.payment_link_url);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const getContactName = () => {
    if (!invoice?.contact) return 'Unknown Contact';
    return invoice.contact.company || `${invoice.contact.first_name} ${invoice.contact.last_name}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <FileText className="w-12 h-12 mx-auto text-hud-cream-mute mb-4" />
        <h2 className="text-xl font-semibold text-white">Invoice not found</h2>
        <button
          onClick={() => navigate('/payments')}
          className="mt-4 text-hud-gold-soft hover:text-hud-gold-soft"
        >
          Back to Payments
        </button>
      </div>
    );
  }

  const statusStyle = STATUS_STYLES[invoice.status];
  const totalPaid = invoice.payments?.reduce((sum, p) => sum + p.amount, 0) || 0;
  const balanceDue = invoice.total - totalPaid;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/payments')}
            className="p-2 rounded-lg hover:bg-hud-bg-card text-hud-cream-dim transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-white">
                Invoice {invoice.doc_number || '#' + invoice.id.slice(0, 8)}
              </h1>
              <span className={`inline-flex px-3 py-1 rounded-full text-sm font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                {statusStyle.label}
              </span>
            </div>
            <p className="text-hud-cream-dim mt-1">
              Created {formatDateTimeShort(invoice.created_at, { hour: 'numeric' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {invoice.status === 'draft' && canSend && (
            <button
              onClick={handleSend}
              disabled={isProcessing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 transition-colors"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send Invoice
            </button>
          )}
          {invoice.status !== 'void' && invoice.status !== 'paid' && canSend && (
            <button
              onClick={handleDisputeToggle}
              disabled={isProcessing}
              title="While on hold, automated payment reminders for this invoice are cancelled"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-elev/50 text-hud-cream hover:bg-hud-bg-elev disabled:opacity-50 transition-colors"
            >
              <AlertCircle className="w-4 h-4" />
              {invoice.disputed_at ? 'Release dispute hold' : 'Hold reminders (disputed)'}
            </button>
          )}
          {invoice.status !== 'void' && invoice.status !== 'paid' && canVoid && (
            <button
              onClick={handleVoid}
              disabled={isProcessing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20 disabled:opacity-50 transition-colors"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              Void
            </button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-hud-plum/10 border border-hud-plum/20">
          <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0" />
          <p className="text-hud-plum/40 text-sm">{errorMessage}</p>
          <button
            onClick={() => setErrorMessage(null)}
            className="ml-auto text-hud-plum hover:text-hud-plum/40"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Line Items</h3>
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-hud-bg-card">
                  <th className="text-left py-2 text-sm font-medium text-hud-cream-dim">Description</th>
                  <th className="text-right py-2 text-sm font-medium text-hud-cream-dim">Qty</th>
                  <th className="text-right py-2 text-sm font-medium text-hud-cream-dim">Price</th>
                  <th className="text-right py-2 text-sm font-medium text-hud-cream-dim">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.line_items?.map((item) => (
                  <tr key={item.id} className="border-b border-hud-bg-card/50">
                    <td className="py-3 text-white">{item.description}</td>
                    <td className="py-3 text-right text-hud-cream-soft">{item.quantity}</td>
                    <td className="py-3 text-right text-hud-cream-soft">{formatCurrency(item.unit_price)}</td>
                    <td className="py-3 text-right text-white font-medium">{formatCurrency(item.total_price)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="py-3 text-right text-hud-cream-dim">Subtotal</td>
                  <td className="py-3 text-right text-white">{formatCurrency(invoice.subtotal)}</td>
                </tr>
                {invoice.discount_amount > 0 && (
                  <tr>
                    <td colSpan={3} className="py-2 text-right text-hud-cream-dim">
                      Discount {invoice.discount_type === 'percentage' && `(${invoice.discount_amount}%)`}
                    </td>
                    <td className="py-2 text-right text-hud-plum">
                      -{formatCurrency(invoice.discount_type === 'percentage' ? (invoice.subtotal * invoice.discount_amount / 100) : invoice.discount_amount)}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-hud-bg-elev">
                  <td colSpan={3} className="py-3 text-right text-lg font-semibold text-white">Total</td>
                  <td className="py-3 text-right text-lg font-semibold text-white">{formatCurrency(invoice.total)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          </div>

          {(invoice.payments?.length ?? 0) > 0 && (
            <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
              <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-hud-emerald" />
                Payments Received
              </h3>
              <div className="space-y-3">
                {invoice.payments?.map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/50">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-hud-emerald/10">
                        <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                      </div>
                      <div>
                        <p className="text-white font-medium">{formatCurrency(payment.amount)}</p>
                        <p className="text-sm text-hud-cream-dim">
                          {payment.payment_method.replace('_', ' ')} - {formatDateTimeShort(payment.received_at, { hour: 'numeric' })}
                        </p>
                      </div>
                    </div>
                    {payment.reference_number && (
                      <span className="text-sm text-hud-cream-dim">Ref: {payment.reference_number}</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-hud-bg-card flex justify-between">
                <span className="text-hud-cream-dim">Balance Due</span>
                <span className={`text-lg font-semibold ${balanceDue > 0 ? 'text-hud-rust' : 'text-hud-emerald'}`}>
                  {formatCurrency(balanceDue)}
                </span>
              </div>
            </div>
          )}

          {invoice.memo && (
            <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
              <h3 className="text-sm font-medium text-hud-cream-dim mb-2">Customer Memo</h3>
              <p className="text-white">{invoice.memo}</p>
            </div>
          )}

          {invoice.internal_notes && (
            <div className="bg-hud-bg-mid rounded-xl border border-hud-rust/20 p-6">
              <h3 className="text-sm font-medium text-hud-rust mb-2">Internal Notes</h3>
              <p className="text-hud-cream-soft">{invoice.internal_notes}</p>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Details</h3>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <User className="w-5 h-5 text-hud-cream-dim mt-0.5" />
                <div>
                  <p className="text-sm text-hud-cream-dim">Contact</p>
                  <Link
                    to={`/contacts/${invoice.contact_id}`}
                    className="text-white hover:text-hud-gold-soft transition-colors"
                  >
                    {getContactName()}
                  </Link>
                  {invoice.contact?.email && (
                    <p className="text-sm text-hud-cream-dim">{invoice.contact.email}</p>
                  )}
                </div>
              </div>

              {invoice.opportunity && (
                <div className="flex items-start gap-3">
                  <Building2 className="w-5 h-5 text-hud-cream-dim mt-0.5" />
                  <div>
                    <p className="text-sm text-hud-cream-dim">Opportunity</p>
                    <Link
                      to={`/opportunities/${invoice.opportunity_id}`}
                      className="text-white hover:text-hud-gold-soft transition-colors"
                    >
                      {formatCurrency(invoice.opportunity.value_amount)}
                    </Link>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-3">
                <Calendar className="w-5 h-5 text-hud-cream-dim mt-0.5" />
                <div>
                  <p className="text-sm text-hud-cream-dim">Due Date</p>
                  <p className="text-white">{formatDateLong(invoice.due_date)}</p>
                </div>
              </div>

              {invoice.sent_at && (
                <div className="flex items-start gap-3">
                  <Send className="w-5 h-5 text-hud-cream-dim mt-0.5" />
                  <div>
                    <p className="text-sm text-hud-cream-dim">Sent</p>
                    <p className="text-white">{formatDateTimeShort(invoice.sent_at, { hour: 'numeric' })}</p>
                  </div>
                </div>
              )}

              {invoice.paid_at && (
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-hud-emerald mt-0.5" />
                  <div>
                    <p className="text-sm text-hud-cream-dim">Paid</p>
                    <p className="text-white">{formatDateTimeShort(invoice.paid_at, { hour: 'numeric' })}</p>
                  </div>
                </div>
              )}

              {invoice.provider_invoice_id && (
                <div className="flex items-start gap-3">
                  <FileText className="w-5 h-5 text-hud-cream-dim mt-0.5" />
                  <div>
                    <p className="text-sm text-hud-cream-dim">
                      {invoice.provider === 'stripe' ? 'Stripe Invoice ID' : 'QuickBooks ID'}
                    </p>
                    <p className="text-white font-mono text-sm">{invoice.provider_invoice_id}</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {invoice.payment_link_url && invoice.status !== 'paid' && invoice.status !== 'void' && (
            <div className="bg-hud-bg-mid rounded-xl border border-hud-emerald/20 p-6">
              <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-hud-emerald" />
                Payment Link
              </h3>
              <p className="text-sm text-hud-cream-dim mb-4">
                Share this link with your customer to collect payment through QuickBooks.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={copyPaymentLink}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors"
                >
                  {copySuccess ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      Copy Link
                    </>
                  )}
                </button>
                <a
                  href={invoice.payment_link_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-hud-emerald/10 text-hud-emerald hover:bg-hud-emerald/20 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open
                </a>
              </div>
            </div>
          )}

          <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-hud-cream-dim">Subtotal</span>
                <span className="text-white">{formatCurrency(invoice.subtotal)}</span>
              </div>
              {invoice.discount_amount > 0 && (
                <div className="flex justify-between">
                  <span className="text-hud-cream-dim">Discount</span>
                  <span className="text-hud-plum">
                    -{formatCurrency(invoice.discount_type === 'percentage' ? (invoice.subtotal * invoice.discount_amount / 100) : invoice.discount_amount)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-3 border-t border-hud-bg-card">
                <span className="text-white font-medium">Total</span>
                <span className="text-white font-semibold text-lg">{formatCurrency(invoice.total)}</span>
              </div>
              {totalPaid > 0 && (
                <>
                  <div className="flex justify-between">
                    <span className="text-hud-cream-dim">Paid</span>
                    <span className="text-hud-emerald">-{formatCurrency(totalPaid)}</span>
                  </div>
                  <div className="flex justify-between pt-3 border-t border-hud-bg-card">
                    <span className="text-white font-medium">Balance Due</span>
                    <span className={`font-semibold text-lg ${balanceDue > 0 ? 'text-hud-rust' : 'text-hud-emerald'}`}>
                      {formatCurrency(balanceDue)}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
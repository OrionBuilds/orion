import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getContactInvoices } from '../../services/invoices';
import { getContactPayments, getContactPaymentSummary } from '../../services/payments';
import type { Invoice, Payment, ContactPaymentSummary, InvoiceStatus } from '../../types';
import {
  FileText,
  CreditCard,
  Plus,
  Loader2,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { CreateInvoiceModal } from '../payments/CreateInvoiceModal';
import { ContactStripePanel } from './ContactStripePanel';
import { formatCurrency, formatDateNumeric } from '../../utils/formatters';

interface ContactPaymentsTabProps {
  contactId: string;
}

const STATUS_STYLES: Record<InvoiceStatus, { bg: string; text: string; label: string }> = {
  draft: { bg: 'bg-hud-cream-mute/20', text: 'text-hud-cream-soft', label: 'Draft' },
  sent: { bg: 'bg-hud-gold/20', text: 'text-hud-gold-soft', label: 'Sent' },
  paid: { bg: 'bg-hud-emerald/20', text: 'text-hud-emerald/40', label: 'Paid' },
  overdue: { bg: 'bg-hud-plum/20', text: 'text-hud-plum/40', label: 'Overdue' },
  void: { bg: 'bg-hud-bg-elev/50', text: 'text-hud-cream-mute', label: 'Void' },
};

export function ContactPaymentsTab({ contactId }: ContactPaymentsTabProps) {
  const { hasPermission } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [summary, setSummary] = useState<ContactPaymentSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateInvoice, setShowCreateInvoice] = useState(false);

  const canCreateInvoice = hasPermission('invoices.create');

  useEffect(() => {
    loadData();
  }, [contactId]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      const [invoiceData, paymentData, summaryData] = await Promise.all([
        getContactInvoices(contactId),
        getContactPayments(contactId),
        getContactPaymentSummary(contactId),
      ]);
      setInvoices(invoiceData);
      setPayments(paymentData);
      setSummary(summaryData);
    } catch (err) {
      console.error('Failed to load payment data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ContactStripePanel contactId={contactId} />

      {summary && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-hud-bg-card/50 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-gold/10">
                <FileText className="w-5 h-5 text-hud-gold-soft" />
              </div>
              <div>
                <p className="text-lg font-semibold text-white">{formatCurrency(summary.totalInvoiced)}</p>
                <p className="text-xs text-hud-cream-dim">Total Invoiced</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-emerald/10">
                <CheckCircle2 className="w-5 h-5 text-hud-emerald" />
              </div>
              <div>
                <p className="text-lg font-semibold text-white">{formatCurrency(summary.totalPaid)}</p>
                <p className="text-xs text-hud-cream-dim">Total Paid</p>
              </div>
            </div>
          </div>
          <div className="bg-hud-bg-card/50 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-hud-rust/10">
                <Clock className="w-5 h-5 text-hud-rust" />
              </div>
              <div>
                <p className={`text-lg font-semibold ${summary.outstanding > 0 ? 'text-hud-rust' : 'text-white'}`}>
                  {formatCurrency(summary.outstanding)}
                </p>
                <p className="text-xs text-hud-cream-dim">Outstanding</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-hud-cream-soft flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Invoices ({invoices.length})
          </h3>
          {canCreateInvoice && (
            <button
              onClick={() => setShowCreateInvoice(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-hud-emerald/10 text-hud-emerald text-sm hover:bg-hud-emerald/20 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Invoice
            </button>
          )}
        </div>

        {invoices.length === 0 ? (
          <div className="text-center py-8 text-hud-cream-dim">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p>No invoices yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {invoices.map((invoice) => {
              const statusStyle = STATUS_STYLES[invoice.status];
              return (
                <Link
                  key={invoice.id}
                  to={`/payments/invoices/${invoice.id}`}
                  className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/30 hover:bg-hud-bg-card/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 text-hud-cream-dim" />
                    <div>
                      <p className="text-white font-medium">{invoice.doc_number || 'Draft'}</p>
                      <p className="text-xs text-hud-cream-dim">{formatDateNumeric(invoice.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}>
                      {statusStyle.label}
                    </span>
                    <span className="text-white font-medium">{formatCurrency(invoice.total, invoice.currency)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {payments.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-hud-cream-soft flex items-center gap-2 mb-4">
            <CreditCard className="w-4 h-4" />
            Payments ({payments.length})
          </h3>
          <div className="space-y-2">
            {payments.map((payment) => (
              <div
                key={payment.id}
                className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/30"
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-hud-emerald/10">
                    <CheckCircle2 className="w-4 h-4 text-hud-emerald" />
                  </div>
                  <div>
                    <p className="text-white font-medium">{formatCurrency(payment.amount, payment.currency)}</p>
                    <p className="text-xs text-hud-cream-dim">
                      {payment.payment_method.replace('_', ' ')} - {formatDateNumeric(payment.received_at)}
                    </p>
                  </div>
                </div>
                {payment.invoice && (
                  <Link
                    to={`/payments/invoices/${payment.invoice_id}`}
                    className="text-sm text-hud-gold-soft hover:text-hud-gold-soft"
                  >
                    {payment.invoice.doc_number}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {showCreateInvoice && (
        <CreateInvoiceModal
          defaultContactId={contactId}
          onClose={() => setShowCreateInvoice(false)}
          onCreated={() => {
            setShowCreateInvoice(false);
            loadData();
          }}
        />
      )}
    </div>
  );
}
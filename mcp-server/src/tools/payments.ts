import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerPaymentsTools(server: McpServer): void {
  server.tool(
    'products_list',
    'List products/services',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('products', { order: 'name.asc', limit: limit || 100 });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'products_create',
    'Create a product or service',
    {
      name: z.string(),
      description: z.string().optional(),
      price: z.number().optional(),
      type: z.string().optional(),
      is_active: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('products', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'products_update',
    'Update a product',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().optional(),
      is_active: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('products', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'products_delete',
    'Delete a product',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('products', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoices_list',
    'List invoices with contact and line items. Filter by status, contact_id.',
    {
      status: z.string().optional().describe('eq.draft, eq.sent, eq.paid, eq.overdue'),
      contact_id: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.status) filters['status'] = params.status;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        const data = await restGet('invoices', {
          select: '*,contact:contacts(id,first_name,last_name,email,company),line_items:invoice_line_items(*)',
          filters,
          order: params.order || 'created_at.desc',
          limit: params.limit || 50,
          offset: params.offset,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoices_get',
    'Get invoice detail with line items and payments',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('invoices', {
          select: '*,contact:contacts(*),line_items:invoice_line_items(*),payments:payments(*)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoices_create',
    'Create an invoice header row. This does NOT create line items — after creating the invoice, add each line via invoice_line_items_create (org_id + invoice_id).',
    {
      contact_id: z.string(),
      org_id: z.string().optional(),
      doc_number: z.string().optional().describe('Invoice number, e.g. INV-00001'),
      due_date: z.string().optional(),
      status: z.string().optional().describe('draft, sent, paid, overdue, void'),
      memo: z.string().optional().describe('Customer-facing memo'),
      internal_notes: z.string().optional(),
      opportunity_id: z.string().optional(),
      subtotal: z.number().optional(),
      total: z.number().optional(),
      discount_amount: z.number().optional(),
      discount_type: z.string().optional().describe('flat or percentage'),
    },
    async (params) => {
      try {
        const data = await restPost('invoices', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoices_update',
    'Update an invoice',
    {
      id: z.string(),
      status: z.string().optional(),
      due_date: z.string().optional(),
      notes: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('invoices', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoices_delete',
    'Delete an invoice',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('invoices', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payments_list',
    'List payments. Filter by invoice_id.',
    { invoice_id: z.string().optional(), limit: z.number().optional() },
    async ({ invoice_id, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (invoice_id) filters['invoice_id'] = `eq.${invoice_id}`;
        const data = await restGet('payments', {
          filters,
          order: 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payments_record',
    'Record a payment against an invoice',
    {
      invoice_id: z.string(),
      amount: z.number(),
      payment_method: z.string().optional(),
      payment_date: z.string().optional(),
      reference: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('payments', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'qbo_api',
    'QuickBooks Online API operations. Actions: find_or_create_customer, create_item, create_invoice, send_invoice, get_invoice, void_invoice, list_items, sync_invoices, getPayment',
    {
      action: z.string().describe('API action name'),
      payload: z.record(z.unknown()).optional().describe('Action-specific parameters'),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('qbo-api', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'recurring_invoice_generate',
    'Generate invoices from recurring profiles',
    { profile_id: z.string().optional() },
    async (params) => {
      try {
        const data = await callEdgeFunction('recurring-invoice-generator', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payment_reminder_send',
    'Send payment reminders for overdue invoices',
    { invoice_id: z.string().optional() },
    async (params) => {
      try {
        const data = await callEdgeFunction('payment-reminder-scheduler', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'stripe_api',
    'Stripe operations via the stripe-api edge function. Actions: createInvoice, sendInvoice, voidInvoice, getBalance, listPayouts, listPayments, listCustomers, listSubscriptions, getMRR, getVolumeMetrics, countNewCustomers, findOrCreateCustomerByContact, updateCustomer, refundCharge, createPaymentIntent. Action-specific fields go in payload (e.g. invoice_id, contact_id, amount (cents), currency, charge_id, stripe_customer_id, updates, limit, created_gte/created_lte).',
    {
      action: z.string().describe('stripe-api action name'),
      org_id: z.string().describe('Organization UUID (required)'),
      payload: z.record(z.unknown()).optional().describe('Action-specific parameters merged into the request body'),
    },
    async ({ action, org_id, payload }) => {
      try {
        const data = await callEdgeFunction('stripe-api', { action, org_id, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'stripe_provider',
    'Manage the Stripe provider connection via the stripe-provider edge function. Actions: connect (payload: secretKey, publishableKey?, webhookSigningSecret?, nickname?), status, test, disconnect.',
    {
      action: z.enum(['connect', 'status', 'test', 'disconnect']),
      payload: z.record(z.unknown()).optional().describe('Action-specific parameters (e.g. secretKey for connect)'),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('stripe-provider', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_send',
    'Send an invoice to the customer. Stripe-first: calls stripe-api sendInvoice. For QuickBooks-backed invoices use qbo_api with action send_invoice instead.',
    { org_id: z.string(), invoice_id: z.string() },
    async ({ org_id, invoice_id }) => {
      try {
        const data = await callEdgeFunction('stripe-api', { action: 'sendInvoice', org_id, invoice_id });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_void',
    'Void an invoice. Stripe-first: calls stripe-api voidInvoice. For QuickBooks-backed invoices use qbo_api with action void_invoice instead.',
    { org_id: z.string(), invoice_id: z.string() },
    async ({ org_id, invoice_id }) => {
      try {
        const data = await callEdgeFunction('stripe-api', { action: 'voidInvoice', org_id, invoice_id });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_line_items_list',
    'List line items for an invoice, ordered by sort_order',
    { invoice_id: z.string() },
    async ({ invoice_id }) => {
      try {
        const data = await restGet('invoice_line_items', {
          filters: { invoice_id: `eq.${invoice_id}` },
          order: 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_line_items_create',
    'Add a line item to an invoice. total_price is typically quantity * unit_price.',
    {
      org_id: z.string(),
      invoice_id: z.string(),
      description: z.string(),
      quantity: z.number(),
      unit_price: z.number(),
      product_id: z.string().optional(),
      total_price: z.number().optional(),
      sort_order: z.number().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('invoice_line_items', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_line_items_update',
    'Update an invoice line item by ID',
    {
      id: z.string(),
      description: z.string().optional(),
      quantity: z.number().optional(),
      unit_price: z.number().optional(),
      total_price: z.number().optional(),
      product_id: z.string().optional(),
      sort_order: z.number().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('invoice_line_items', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_line_items_delete',
    'Delete an invoice line item by ID',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('invoice_line_items', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'recurring_profiles_list',
    'List recurring invoice profiles with contact and items. Filter by status, contact_id, frequency.',
    {
      status: z.string().optional().describe('eq.active, eq.paused, eq.cancelled'),
      contact_id: z.string().optional(),
      frequency: z.string().optional().describe('eq.weekly, eq.monthly, eq.quarterly, eq.annually'),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.status) filters['status'] = params.status;
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        if (params.frequency) filters['frequency'] = params.frequency;
        const data = await restGet('recurring_profiles', {
          select: '*,contact:contacts(id,first_name,last_name,email,company),items:recurring_profile_items(*)',
          filters,
          order: params.order || 'created_at.desc',
          limit: params.limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'recurring_profiles_create',
    'Create a recurring invoice profile (header). Line items live in recurring_profile_items (org_id, recurring_profile_id, product_id?, description, quantity, unit_price, sort_order) and are inserted separately.',
    {
      org_id: z.string(),
      contact_id: z.string(),
      name: z.string(),
      frequency: z.enum(['weekly', 'monthly', 'quarterly', 'annually']),
      next_invoice_date: z.string(),
      status: z.string().optional().describe('active, paused, cancelled'),
      end_date: z.string().optional(),
      auto_send: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('recurring_profiles', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'recurring_profiles_update',
    'Update a recurring profile by ID (e.g. status active/paused/cancelled, frequency, next_invoice_date)',
    {
      id: z.string(),
      name: z.string().optional(),
      frequency: z.enum(['weekly', 'monthly', 'quarterly', 'annually']).optional(),
      status: z.string().optional(),
      next_invoice_date: z.string().optional(),
      end_date: z.string().optional(),
      auto_send: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('recurring_profiles', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'recurring_profiles_delete',
    'Delete a recurring profile by ID',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('recurring_profiles', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_templates_list',
    'List invoice templates (default first)',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('invoice_templates', {
          order: 'is_default.desc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_templates_create',
    'Create an invoice template',
    {
      org_id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      is_default: z.boolean().optional(),
      logo_url: z.string().optional(),
      header_text: z.string().optional(),
      footer_text: z.string().optional(),
      accent_color: z.string().optional(),
      show_payment_instructions: z.boolean().optional(),
      payment_instructions: z.string().optional(),
      include_due_date: z.boolean().optional(),
      include_invoice_number: z.boolean().optional(),
      include_line_item_descriptions: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('invoice_templates', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_templates_update',
    'Update an invoice template by ID',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      is_default: z.boolean().optional(),
      logo_url: z.string().optional(),
      header_text: z.string().optional(),
      footer_text: z.string().optional(),
      accent_color: z.string().optional(),
      show_payment_instructions: z.boolean().optional(),
      payment_instructions: z.string().optional(),
      include_due_date: z.boolean().optional(),
      include_invoice_number: z.boolean().optional(),
      include_line_item_descriptions: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('invoice_templates', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'invoice_templates_delete',
    'Delete an invoice template by ID',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('invoice_templates', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payment_reminders_list',
    'List payment reminders scheduled for an invoice',
    { invoice_id: z.string() },
    async ({ invoice_id }) => {
      try {
        const data = await restGet('payment_reminders', {
          filters: { invoice_id: `eq.${invoice_id}` },
          order: 'scheduled_for.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payment_reminder_settings_get',
    'Get payment reminder settings for an organization',
    { org_id: z.string() },
    async ({ org_id }) => {
      try {
        const data = await restGet('payment_reminder_settings', {
          filters: { org_id: `eq.${org_id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'payment_reminder_settings_update',
    'Update payment reminder settings for an organization',
    {
      org_id: z.string(),
      enabled: z.boolean().optional(),
      first_reminder_days: z.number().optional(),
      second_reminder_days: z.number().optional(),
      third_reminder_days: z.number().optional(),
      final_reminder_days: z.number().optional(),
      channels: z.array(z.string()).optional(),
      email_template_subject: z.string().optional(),
      email_template_body: z.string().optional(),
      sms_template: z.string().optional(),
    },
    async ({ org_id, ...body }) => {
      try {
        const data = await restPatch('payment_reminder_settings', { org_id: `eq.${org_id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

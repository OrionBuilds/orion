/** CAIO Delivery — read-only client-portal reads (session-validated via client-portal-auth). */
import { portalData } from './clientPortal';

export interface CaioPortalGate { gate_key: string; label: string; due_date: string | null; status: string }
export interface CaioPortalDocumentSummary {
  id: string; title: string; template_number: string | null; version: number | string | null;
  approved_at: string | null; next_review: string | null;
}
export interface CaioPortalRegister {
  register_key: string; title: string; purpose: string | null;
  columns: { field_key: string; label: string; ftype: string }[];
  rows: { record_key: string; data: Record<string, unknown> }[];
}
export type CaioPortalResult =
  | { enabled: false }
  | {
      enabled: true;
      engagement: { code: string | null; client: string | null; kickoff_date: string | null; status: string | null };
      gates: CaioPortalGate[];
      documents: CaioPortalDocumentSummary[];
      registers: CaioPortalRegister[];
    };
export interface CaioPortalDocument {
  id: string; title: string; version: number | string | null;
  approved_at: string | null; next_review: string | null; body_html: string;
}

export const getCaioPortal = (projectId: string) =>
  portalData<CaioPortalResult>('get-caio', { projectId });
export const getCaioPortalDocument = (projectId: string, documentId: string) =>
  portalData<CaioPortalDocument>('get-caio-document', { projectId, documentId });

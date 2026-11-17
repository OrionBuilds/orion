import type { ConsentBasis } from '../../../supabase/functions/_shared/meeting-consent';

export interface ConsentValue {
  basis: ConsentBasis | '';
  note: string;
}

export const EMPTY_CONSENT: ConsentValue = { basis: '', note: '' };

import { maskPhone } from '../../lib/mfa';
import type { MfaFactor } from '../../services/mfa';

export function factorLabel(f: MfaFactor): string {
  if (f.factorType === 'phone') {
    const masked = maskPhone(f.phone);
    return masked ? `${f.friendlyName} (${masked})` : f.friendlyName;
  }
  return f.friendlyName;
}

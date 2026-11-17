import { Phone, Video, MapPin, Link as LinkIcon } from 'lucide-react';
import type { LocationType } from '../../../types';

/** Shared by the Appointment Type drawer and the Create Calendar drawer's inline new-type form. */
export const durationOptions = [15, 30, 45, 60, 90, 120];

export const locationOptions: { value: LocationType; label: string; icon: typeof Phone }[] = [
  { value: 'phone', label: 'Phone Call', icon: Phone },
  { value: 'google_meet', label: 'Google Meet', icon: Video },
  { value: 'zoom', label: 'Zoom', icon: Video },
  { value: 'in_person', label: 'In Person', icon: MapPin },
  { value: 'custom', label: 'Custom', icon: LinkIcon },
];

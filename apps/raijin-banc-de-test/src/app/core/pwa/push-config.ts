import { InjectionToken } from '@angular/core';
import { environment } from '../../../environments/environment';

/** Public VAPID key (base64url). Public by design; the private key only lives in Supabase secrets. */
export const VAPID_PUBLIC_KEY = new InjectionToken<string>('VAPID_PUBLIC_KEY', {
  providedIn: 'root',
  factory: () => environment.vapidPublicKey,
});

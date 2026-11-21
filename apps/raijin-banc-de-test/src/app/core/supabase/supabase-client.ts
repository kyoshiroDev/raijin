import { InjectionToken } from '@angular/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

/**
 * Single Supabase client for the app, using the PUBLIC anon key.
 * All data access is constrained by Row Level Security.
 */
export const SUPABASE = new InjectionToken<SupabaseClient>('SUPABASE', {
  providedIn: 'root',
  factory: () =>
    createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
});

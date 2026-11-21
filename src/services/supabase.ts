// Cliente Supabase singleton com persistência de sessão multiplataforma (LargeSecureStore / localStorage)
// e renovação automática de token acoplada ao ciclo de vida do app nativo.
import { AppState, Platform } from 'react-native';
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import { sessionStorage } from './sessionStorage';

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_KEY = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);

export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;
}

export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        storage: sessionStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: Platform.OS === 'web',
      },
    })
  : null;

let appStateRegistered = false;

if (supabase && Platform.OS !== 'web' && !appStateRegistered) {
  appStateRegistered = true;
  const client = supabase;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void client.auth.startAutoRefresh();
    } else {
      void client.auth.stopAutoRefresh();
    }
  });
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase não está configurado. Defina EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return supabase;
}

export async function getSupabaseSession(): Promise<Session | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.warn('[supabase] falha ao obter sessão', error.message);
      return null;
    }
    return data.session ?? null;
  } catch (err) {
    console.warn('[supabase] erro ao consultar sessão', err);
    return null;
  }
}

export async function getSupabaseUser(): Promise<User | null> {
  const session = await getSupabaseSession();
  return session?.user ?? null;
}

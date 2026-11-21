// Serviço de autenticação (Email/Senha + Modo Convidado), perfil público/@username e logout limpo.
import type { User } from '@supabase/supabase-js';
import { wipeAll } from '../game/persist.ts';
import { useGame } from '../game/store.ts';
import {
  USERNAME_REGEX,
  isValidUsername,
  mapAuthError,
  normalizeUsername,
  suggestUsernameFromName,
  validateUsername,
} from './authCore.ts';
import {
  clearMigrationState,
  resolveMigrationForUser,
  type MigrationDecision,
} from './migration.ts';
import { getSupabaseSession, getSupabaseUser, requireSupabase, supabase } from './supabase.ts';
import { withCloudGuard } from './sync.ts';

export {
  USERNAME_REGEX,
  isValidUsername,
  mapAuthError,
  normalizeUsername,
  suggestUsernameFromName,
  validateUsername,
};

export interface AuthActionResult {
  user: User | null;
  needsEmailConfirmation?: boolean;
  migration: MigrationDecision | 'skipped';
}

export interface SignUpOptions {
  displayName?: string;
  username?: string;
}

export async function signInWithEmail(email: string, password: string): Promise<AuthActionResult> {
  const cleanEmail = email.trim();
  if (!cleanEmail) throw new Error('Digite seu e-mail.');
  if (!password) throw new Error('Digite sua senha.');

  const client = requireSupabase();
  useGame.getState().setAuthState({ authLoading: true });
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });
    if (error || !data.user) {
      throw new Error(mapAuthError(error));
    }
    useGame.getState().setAuthState({
      authUserId: data.user.id,
      authEmail: data.user.email ?? cleanEmail,
      authLoading: false,
    });
    const migration = await resolveMigrationForUser(data.user);
    return { user: data.user, migration };
  } catch (err) {
    useGame.getState().setAuthState({ authLoading: false });
    throw new Error(mapAuthError(err));
  }
}

export async function signUpWithEmail(
  email: string,
  password: string,
  displayNameOrOpts?: string | SignUpOptions,
): Promise<AuthActionResult> {
  const cleanEmail = email.trim();
  if (!cleanEmail) throw new Error('Digite seu e-mail.');
  if (password.length < 6) {
    throw new Error('A senha deve ter pelo menos 6 caracteres.');
  }

  const opts: SignUpOptions =
    typeof displayNameOrOpts === 'string'
      ? { displayName: displayNameOrOpts }
      : (displayNameOrOpts ?? {});

  let validUsername: string | undefined;
  if (opts.username && opts.username.trim().length > 0) {
    const check = validateUsername(opts.username);
    if (!check.ok) throw new Error(check.error);
    validUsername = check.username;
  }

  const localProfile = useGame.getState().profile;
  const displayName = (opts.displayName ?? localProfile?.name ?? 'Viajante').trim().slice(0, 32) || 'Viajante';

  const client = requireSupabase();
  useGame.getState().setAuthState({ authLoading: true });
  try {
    const { data, error } = await client.auth.signUp({
      email: cleanEmail,
      password,
      options: {
        data: {
          display_name: displayName,
          modality: localProfile?.modality ?? 'bike',
          character_id: localProfile?.characterId ?? 'custom',
          ...(validUsername ? { username: validUsername } : {}),
        },
      },
    });
    if (error) {
      throw new Error(mapAuthError(error));
    }

    if (data.session && data.user) {
      useGame.getState().setAuthState({
        authUserId: data.user.id,
        authEmail: data.user.email ?? cleanEmail,
        authLoading: false,
      });
      const migration = await resolveMigrationForUser(data.user);
      return { user: data.user, needsEmailConfirmation: false, migration };
    }

    useGame.getState().setAuthState({ authLoading: false });
    return { user: data.user ?? null, needsEmailConfirmation: true, migration: 'skipped' };
  } catch (err) {
    useGame.getState().setAuthState({ authLoading: false });
    throw new Error(mapAuthError(err));
  }
}

export async function sendPasswordReset(email: string): Promise<void> {
  const cleanEmail = email.trim();
  if (!cleanEmail) throw new Error('Digite seu e-mail.');
  const client = requireSupabase();
  const { error } = await client.auth.resetPasswordForEmail(cleanEmail);
  if (error) {
    throw new Error(mapAuthError(error));
  }
}

export async function getCurrentAuthUser(): Promise<User | null> {
  return await getSupabaseUser();
}

export async function updateProfileSettings(opts: {
  username?: string;
  isPublic?: boolean;
  displayName?: string;
}): Promise<void> {
  let cleanUsername: string | undefined;
  if (opts.username !== undefined && opts.username.trim().length > 0) {
    const check = validateUsername(opts.username);
    if (!check.ok) throw new Error(check.error);
    cleanUsername = check.username;
  }

  let cleanDisplayName: string | undefined;
  if (opts.displayName !== undefined) {
    const trimmed = opts.displayName.trim().slice(0, 32);
    if (!trimmed) throw new Error('O apelido não pode ficar vazio.');
    cleanDisplayName = trimmed;
  }

  const s = useGame.getState();
  const userId = s.authUserId ?? (await getSupabaseUser())?.id ?? null;

  if (supabase && userId) {
    const dbPatch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (cleanUsername !== undefined) dbPatch.username = cleanUsername;
    if (opts.isPublic !== undefined) dbPatch.is_public = opts.isPublic;
    if (cleanDisplayName !== undefined) dbPatch.display_name = cleanDisplayName;

    const { error } = await supabase
      .from('profiles')
      .update(dbPatch)
      .eq('id', userId);
    if (error) {
      throw new Error(mapAuthError(error));
    }

    await withCloudGuard(() => {
      useGame.getState().updateProfileIdentity({
        ...(cleanUsername !== undefined ? { username: cleanUsername } : {}),
        ...(opts.isPublic !== undefined ? { isPublic: opts.isPublic } : {}),
        ...(cleanDisplayName !== undefined ? { name: cleanDisplayName } : {}),
      });
    });
    return;
  }

  useGame.getState().updateProfileIdentity({
    ...(cleanUsername !== undefined ? { username: cleanUsername } : {}),
    ...(opts.isPublic !== undefined ? { isPublic: opts.isPublic } : {}),
    ...(cleanDisplayName !== undefined ? { name: cleanDisplayName } : {}),
  });
}

export async function signOutAndReset(): Promise<void> {
  if (supabase) {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      }
    } catch {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
  }
  clearMigrationState();
  useGame.getState().setAuthState({ authUserId: null, authEmail: null, authLoading: false });
  await wipeAll();
  useGame.getState().resetProgress();
}

let activeAuthUnsub: (() => void) | null = null;

export function initAuthListener(): () => void {
  if (activeAuthUnsub) return activeAuthUnsub;

  if (!supabase) {
    useGame.getState().setAuthState({ authUserId: null, authEmail: null, authLoading: false });
    return () => {};
  }

  let disposed = false;
  useGame.getState().setAuthState({ authLoading: true });

  void (async () => {
    const session = await getSupabaseSession();
    if (disposed) return;

    const user = session?.user ?? null;
    useGame.getState().setAuthState({
      authUserId: user?.id ?? null,
      authEmail: user?.email ?? null,
      authLoading: false,
    });

    if (user) {
      const s = useGame.getState();
      const localCloudId = s.cloudUserId ?? s.profile?.cloudUserId;
      // Quando não há perfil local ou pertence a outro usuário, resolve migração imediatamente.
      if (!s.hydrated || !s.profile || (localCloudId && localCloudId !== user.id) || !localCloudId) {
        await resolveMigrationForUser(user).catch((err) => {
          console.warn('[auth] falha ao resolver migração inicial', err);
        });
      }
    }
  })();

  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (disposed) return;
    const user = session?.user ?? null;
    useGame.getState().setAuthState({
      authUserId: user?.id ?? null,
      authEmail: user?.email ?? null,
      authLoading: false,
    });

    if (event === 'SIGNED_IN' && user) {
      void resolveMigrationForUser(user).catch((err) => {
        console.warn('[auth] falha ao migrar após login', err);
      });
    } else if (event === 'SIGNED_OUT') {
      clearMigrationState();
    }
  });

  activeAuthUnsub = () => {
    disposed = true;
    data.subscription.unsubscribe();
    activeAuthUnsub = null;
  };

  return activeAuthUnsub;
}

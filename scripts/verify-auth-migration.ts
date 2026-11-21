// Verificação automatizada do M3 (auth-migration-ui): testes unitários + mock GoTrue + integração ao vivo.
// Rodar com: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test scripts/verify-auth-migration.ts
// ATENÇÃO: nunca chamar signUp(), resetPasswordForEmail() ou resend() contra o Supabase ao vivo (política anti-bounce).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { fog } from '../src/game/fog.ts';
import { cellOf } from '../src/game/geo.ts';
import { useGame } from '../src/game/store.ts';
import { DEFAULT_AVATAR } from '../src/sprites/avatar.ts';
import {
  isValidUsername,
  mapAuthError,
  normalizeUsername,
  suggestUsernameFromName,
  validateUsername,
} from '../src/services/authCore.ts';
import { parseInviteUsername } from '../src/services/deepLinkCore.ts';
import {
  buildLocalMigrationSummary,
  decideMigration,
  inspectCloudState,
} from '../src/services/migrationCore.ts';

try {
  process.loadEnvFile('.env.local');
} catch {
  // Variáveis podem vir diretamente do ambiente
}

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_KEY = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);
const TEST_USER_A_EMAIL = (process.env.TEST_USER_A_EMAIL ?? '').trim();
const TEST_USER_A_PASSWORD = (process.env.TEST_USER_A_PASSWORD ?? '').trim();

test('1. authCore: normalização, validação, sugestão de @username e mapeamento de erros pt-BR', () => {
  assert.equal(normalizeUsername('  @Alice_SP  '), 'alice_sp');
  assert.equal(isValidUsername('alice_01'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('a'.repeat(24)), true);
  assert.equal(isValidUsername('a'.repeat(25)), false);
  assert.equal(isValidUsername('alice-sp'), false);

  assert.deepEqual(validateUsername('@Ciclista_10'), { ok: true, username: 'ciclista_10' });
  assert.equal(validateUsername('ab').ok, false);
  assert.equal(validateUsername('inválido!').ok, false);
  assert.equal(validateUsername('').ok, false);

  assert.equal(suggestUsernameFromName('João Pedro!'), 'joao_pedro');
  assert.equal(suggestUsernameFromName('Al'), 'al_br');
  assert.equal(suggestUsernameFromName('!!!'), '');

  assert.equal(mapAuthError(new Error('Invalid login credentials')), 'E-mail ou senha incorretos.');
  assert.equal(
    mapAuthError(new Error('Email not confirmed')),
    'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.',
  );
  assert.equal(
    mapAuthError(new Error('User already registered')),
    'Já existe uma conta cadastrada com este e-mail.',
  );
  assert.equal(
    mapAuthError(new Error('Password should be at least 6 characters')),
    'A senha deve ter pelo menos 6 caracteres.',
  );
  assert.equal(
    mapAuthError({ code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_key"' }),
    'Esse @username já está em uso. Escolha outro.',
  );
  assert.equal(
    mapAuthError({ status: 429, message: 'Too many requests' }),
    'Muitas tentativas seguidas. Aguarde um momento e tente novamente.',
  );
  assert.equal(
    mapAuthError(new TypeError('Failed to fetch')),
    'Sem conexão com o servidor. Confira sua internet.',
  );
});

test('2. deepLinkCore: parseInviteUsername para esquemas nativos e URLs web', () => {
  assert.equal(parseInviteUsername('desbrava://add/alice_sp'), 'alice_sp');
  assert.equal(parseInviteUsername('desbrava:///add/@Bob_99'), 'bob_99');
  assert.equal(parseInviteUsername('https://desbrava.app/add/carol_12'), 'carol_12');
  assert.equal(parseInviteUsername('https://desbrava.app/?skip=1&add=dana_br'), 'dana_br');
  assert.equal(parseInviteUsername('exp://127.0.0.1:8081/--/add/edu_07'), 'edu_07');

  assert.equal(parseInviteUsername('https://desbrava.app/?skip=1&sim=1&debug=1'), null);
  assert.equal(parseInviteUsername('https://desbrava.app/?gallery=1'), null);
  assert.equal(parseInviteUsername('desbrava://add/ab'), null);
  assert.equal(parseInviteUsername('desbrava://add/nome-invalido!'), null);
  assert.equal(parseInviteUsername(''), null);
  assert.equal(parseInviteUsername(null), null);
});

test('3. migrationCore & store: decisão de ramos e preservação de sessão no resetProgress', () => {
  const empty = { activities: 0, cells: 0, captures: 0, xp: 0 };
  const active = { activities: 2, cells: 40, captures: 1, xp: 350 };

  assert.equal(
    decideMigration({
      userId: 'u1',
      localCloudUserId: 'u1',
      local: active,
      cloud: active,
      hasLocalProfile: true,
    }),
    'same_account_sync',
  );

  assert.equal(
    decideMigration({
      userId: 'u1',
      local: active,
      cloud: empty,
      hasLocalProfile: true,
    }),
    'auto_push',
  );

  assert.equal(
    decideMigration({
      userId: 'u1',
      local: empty,
      cloud: empty,
      hasLocalProfile: true,
    }),
    'auto_push',
  );

  assert.equal(
    decideMigration({
      userId: 'u1',
      local: empty,
      cloud: active,
      hasLocalProfile: true,
    }),
    'auto_pull',
  );

  assert.equal(
    decideMigration({
      userId: 'u1',
      local: empty,
      cloud: empty,
      hasLocalProfile: false,
    }),
    'auto_pull',
  );

  assert.equal(
    decideMigration({
      userId: 'u1',
      local: active,
      cloud: active,
      hasLocalProfile: true,
    }),
    'conflict',
  );

  // Confirma buildLocalMigrationSummary + resetProgress preservando authUserId/authEmail
  fog.clear();
  useGame.getState().resetProgress();
  useGame.getState().setAuthState({ authUserId: 'u1', authEmail: 'u1@exemplo.com', authLoading: false });
  useGame.getState().createProfile('Ciclista Teste', DEFAULT_AVATAR, 'bike', 'lia', { username: 'ciclista_teste' });
  fog.load({
    keys: new Float64Array([cellOf({ lng: -46.6559, lat: -23.5614 })]),
    city: new Uint16Array([0]),
    cityIds: [],
  });
  useGame.getState().setPendingMigration({
    userId: 'u1',
    email: 'u1@exemplo.com',
    local: { activities: 1, cells: 1, captures: 0, xp: 10 },
    cloud: active,
  });

  const localSummary = buildLocalMigrationSummary();
  assert.equal(localSummary.hasProfile, true);
  assert.equal(localSummary.summary.cells, 1);

  useGame.getState().resetProgress();
  const afterReset = useGame.getState();
  assert.equal(afterReset.profile, null);
  assert.equal(afterReset.pendingMigration, null);
  assert.equal(afterReset.authUserId, 'u1');
  assert.equal(afterReset.authEmail, 'u1@exemplo.com');
  fog.clear();
});

test('4. Mock GoTrue HTTP (127.0.0.1:0): signUp sem confirmação automática, duplicidade e rate limit sem e-mail real', async (t) => {
  let mode: 'unconfirmed' | 'exists' | 'ratelimit' = 'unconfirmed';

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/auth/v1/signup')) {
      if (mode === 'exists') {
        res.statusCode = 422;
        res.end(JSON.stringify({ code: 'user_already_exists', msg: 'User already registered' }));
        return;
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          id: '00000000-0000-4000-8000-000000000001',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'mock@exemplo.invalid',
          confirmation_sent_at: new Date().toISOString(),
        }),
      );
      return;
    }
    if (req.url?.startsWith('/auth/v1/recover')) {
      res.statusCode = 429;
      res.end(JSON.stringify({ code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 60 seconds' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const mockClient = createClient(`http://127.0.0.1:${addr.port}`, 'mock-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  mode = 'unconfirmed';
  const r1 = await mockClient.auth.signUp({ email: 'mock@exemplo.invalid', password: 'Password123!' });
  assert.equal(r1.error, null);
  assert.ok(r1.data.user);
  assert.equal(r1.data.session, null);

  mode = 'exists';
  const r2 = await mockClient.auth.signUp({ email: 'mock@exemplo.invalid', password: 'Password123!' });
  assert.ok(r2.error);
  assert.equal(mapAuthError(r2.error), 'Já existe uma conta cadastrada com este e-mail.');

  mode = 'ratelimit';
  const r3 = await mockClient.auth.resetPasswordForEmail('mock@exemplo.invalid');
  assert.ok(r3.error);
  assert.equal(mapAuthError(r3.error), 'Muitas tentativas seguidas. Aguarde um momento e tente novamente.');
});

test('5. Live Supabase (lugwebngeyadfrqoapsg): signInWithPassword, inspectCloudState e update profile seguro', async (t) => {
  if (!SUPABASE_URL || !SUPABASE_KEY || !TEST_USER_A_EMAIL || !TEST_USER_A_PASSWORD) {
    t.skip('Credenciais TEST_USER_A_* ausentes em .env.local');
    return;
  }

  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authErr } = await client.auth.signInWithPassword({
    email: TEST_USER_A_EMAIL,
    password: TEST_USER_A_PASSWORD,
  });
  assert.equal(authErr, null);
  assert.ok(authData.user);
  const userId = authData.user.id;

  const { data: origProfile, error: profErr } = await client
    .from('profiles')
    .select('display_name, is_public, username')
    .eq('id', userId)
    .single();
  assert.equal(profErr, null);
  assert.ok(origProfile);

  t.after(async () => {
    await client
      .from('profiles')
      .update({
        display_name: origProfile.display_name,
        is_public: origProfile.is_public,
      })
      .eq('id', userId);
    await client.auth.signOut({ scope: 'local' });
  });

  const inspected = await inspectCloudState(client, userId);
  assert.equal(typeof inspected.hasProgress, 'boolean');
  assert.ok(inspected.summary.activities >= 0);
  assert.ok(inspected.summary.cells >= 0);
  assert.ok(inspected.summary.xp >= 0);

  // Atualiza is_public e confirma roundtrip
  const toggled = !origProfile.is_public;
  const { error: updErr } = await client
    .from('profiles')
    .update({ is_public: toggled })
    .eq('id', userId);
  assert.equal(updErr, null);

  const { data: afterUpd, error: checkErr } = await client
    .from('profiles')
    .select('is_public')
    .eq('id', userId)
    .single();
  assert.equal(checkErr, null);
  assert.equal(afterUpd?.is_public, toggled);

  // Valida mapeamento de formato inválido de @username vindo do Postgres (23514)
  const { error: badUserErr } = await client
    .from('profiles')
    .update({ username: 'X!' })
    .eq('id', userId);
  assert.ok(badUserErr);
  assert.equal(
    mapAuthError(badUserErr),
    'O @username deve ter entre 3 e 24 caracteres (a-z, 0-9 e _).',
  );
});

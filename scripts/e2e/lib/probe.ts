import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { getEnv, PROJECT_ROOT } from './env.ts';

export type CapabilityKey =
  | 'designDoc'
  | 'schema'
  | 'verifyActivity'
  | 'serviceRoleKey'
  | 'distWeb'
  | 'authSettings'
  | 'syncEngine'
  | 'authUi'
  | 'socialUi'
  | 'storeUi';

export interface AuthSettingsSnapshot {
  ok: boolean;
  mailerAutoconfirm: boolean;
  emailEnabled: boolean;
}

export interface Capabilities {
  designDoc: boolean;
  schema: boolean;
  verifyActivity: boolean;
  serviceRoleKey: boolean;
  distWeb: boolean;
  authSettings: boolean;
  authSettingsDetail: AuthSettingsSnapshot;
  syncEngine: boolean;
  authUi: boolean;
  socialUi: boolean;
  storeUi: boolean;
}

let cachedCapsPromise: Promise<Capabilities> | null = null;

export function resetProbeCache(): void {
  cachedCapsPromise = null;
}

function fileHasAny(relPaths: string[]): boolean {
  return relPaths.some((p) => fs.existsSync(path.join(PROJECT_ROOT, p)));
}

function fileContains(relPath: string, needles: string[]): boolean {
  const full = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(full)) return false;
  const content = fs.readFileSync(full, 'utf8');
  return needles.every((n) => content.includes(n));
}

async function probeAuthSettings(url: string, apiKey: string): Promise<AuthSettingsSnapshot> {
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: apiKey },
    });
    if (!res.ok) {
      return {
        ok: false,
        mailerAutoconfirm: false,
        emailEnabled: false,
      };
    }
    const json = (await res.json()) as {
      mailer_autoconfirm?: boolean;
      external?: { email?: boolean };
    };
    return {
      ok: true,
      mailerAutoconfirm: Boolean(json.mailer_autoconfirm),
      emailEnabled: Boolean(json.external?.email),
    };
  } catch {
    return {
      ok: false,
      mailerAutoconfirm: false,
      emailEnabled: false,
    };
  }
}

async function probeSchema(url: string, apiKey: string, anonJwt: string): Promise<boolean> {
  if (!apiKey || !anonJwt) return false;
  try {
    const res = await fetch(`${url}/rest/v1/store_items?select=id&limit=0`, {
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${anonJwt}`,
      },
    });
    if (res.status >= 500 || res.status === 404 || res.status === 401) return false;
    const text = await res.text();
    if (text.includes('PGRST205') || text.includes('Could not find the table')) return false;
    if (/invalid\s*api\s*key|invalid\s*jwt/i.test(text)) return false;
    if (res.status === 200) return true;
    return res.status === 403 && text.includes('42501');
  } catch {
    return false;
  }
}

async function probeVerifyActivity(url: string, apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const res = await fetch(`${url}/functions/v1/verify-activity`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (res.status >= 500 || res.status === 404 || res.status === 403) return false;
    const text = await res.text();
    if (/invalid\s*api\s*key|invalid\s*jwt|NOT_FOUND/i.test(text)) return false;
    if (res.status === 200 || res.status === 400 || res.status === 405) return true;
    if (res.status === 401) {
      return (
        text.includes('Missing authorization header') ||
        text.includes('Token de usuário ausente ou inválido') ||
        text.includes('Sessão inválida ou expirada')
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function probeCapabilities(): Promise<Capabilities> {
  if (cachedCapsPromise) return cachedCapsPromise;
  cachedCapsPromise = (async () => {
    const env = getEnv();
    const [authSettingsDetail, schema, verifyActivity] = await Promise.all([
      probeAuthSettings(env.supabaseUrl, env.supabasePublishableKey),
      probeSchema(env.supabaseUrl, env.supabasePublishableKey, env.supabaseAnonJwt),
      probeVerifyActivity(env.supabaseUrl, env.supabasePublishableKey),
    ]);

    const designDoc =
      fileHasAny(['docs/design/003-supabase-backend.md']) &&
      fileContains('docs/README.md', ['003-supabase-backend.md']);

    const syncEngine =
      fileHasAny(['src/services/sync.ts']) &&
      fileHasAny(['src/services/sessionStorage.ts', 'src/services/sessionStorage.web.ts']);

    const authUi =
      fileHasAny(['src/services/auth.ts', 'src/services/auth.web.ts']) &&
      fileHasAny(['src/services/migration.ts']);

    const socialUi =
      fileHasAny(['src/services/social.ts']) &&
      fileHasAny(['src/ui/screens/SocialScreen.tsx']);

    const storeUi =
      fileHasAny(['src/services/storeService.ts']) &&
      fileHasAny(['src/ui/screens/ShopScreen.tsx']);

    return {
      designDoc,
      schema,
      verifyActivity,
      serviceRoleKey: env.serviceRoleKey.length > 20,
      distWeb: fs.existsSync(path.join(PROJECT_ROOT, 'dist/index.html')),
      authSettings: authSettingsDetail.ok,
      authSettingsDetail,
      syncEngine,
      authUi,
      socialUi,
      storeUi,
    };
  })();
  return cachedCapsPromise;
}

const ENV_ONLY_CAPS = new Set<CapabilityKey>(['serviceRoleKey', 'distWeb']);

export async function gateTest(
  t: TestContext,
  opts: { milestone: string; requires: CapabilityKey[] },
): Promise<boolean> {
  const env = getEnv();
  const caps = await probeCapabilities();

  if (env.skipWeb && opts.requires.includes('distWeb')) {
    if (env.mode === 'strict') {
      assert.fail(`[STRICT:${opts.milestone}] --skip-web cannot be combined with --mode=strict`);
    }
    t.skip('[SKIP:skip-web] Web tests disabled via --skip-web');
    return false;
  }

  const missing: CapabilityKey[] = [];
  for (const req of opts.requires) {
    if (!caps[req]) missing.push(req);
  }

  if (missing.length === 0) return true;

  if (env.mode === 'strict') {
    assert.fail(
      `[STRICT:${opts.milestone}] Missing required capability: ${missing.join(', ')}`,
    );
  }

  const missingMilestone = missing.filter((c) => !ENV_ONLY_CAPS.has(c));
  if (missingMilestone.length > 0) {
    t.skip(
      `[PENDING_MILESTONE:${opts.milestone}] Waiting for ${missing.join(', ')}`,
    );
  } else {
    t.skip(`[SKIP:env] Missing environment requirement: ${missing.join(', ')}`);
  }
  return false;
}

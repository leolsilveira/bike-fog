import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { PROJECT_ROOT } from './env.ts';

const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export interface DistStatus {
  exists: boolean;
  stale: boolean;
  distMtimeMs: number;
  newestSourceMtimeMs: number;
}

function newestMtime(dirOrFile: string): number {
  if (!fs.existsSync(dirOrFile)) return 0;
  const stat = fs.statSync(dirOrFile);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(dirOrFile, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = path.join(dirOrFile, entry.name);
    const m = newestMtime(child);
    if (m > newest) newest = m;
  }
  return newest;
}

export function checkDistStatus(): DistStatus {
  const indexHtml = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return { exists: false, stale: true, distMtimeMs: 0, newestSourceMtimeMs: 0 };
  }
  const distMtimeMs = fs.statSync(indexHtml).mtimeMs;
  const newestSourceMtimeMs = Math.max(
    newestMtime(path.join(PROJECT_ROOT, 'App.tsx')),
    newestMtime(path.join(PROJECT_ROOT, 'package.json')),
    newestMtime(path.join(PROJECT_ROOT, 'src')),
  );
  return {
    exists: true,
    stale: newestSourceMtimeMs > distMtimeMs,
    distMtimeMs,
    newestSourceMtimeMs,
  };
}

export function buildWebBundle(): void {
  execSync('npm run build:web', { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

export interface StaticDistServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startDistServer(): Promise<StaticDistServer> {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error(
      `dist/index.html not found at ${DIST_DIR}. Run "npm run build:web" or pass "--build".`,
    );
  }

  const distRoot = path.resolve(DIST_DIR);

  const server = http.createServer((req, res) => {
    let relPath: string;
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      relPath = decodeURIComponent(reqUrl.pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (relPath.includes('\0')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    if (relPath === '/') relPath = '/index.html';

    const resolved = path.resolve(distRoot, `.${relPath}`);
    if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    let targetPath = resolved;
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      const hasExt = path.extname(relPath).length > 0;
      if (hasExt) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      targetPath = path.join(DIST_DIR, 'index.html');
    }

    const ext = path.extname(targetPath).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(targetPath).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// Local structural browser types so scripts/tsconfig.json (lib: ES2023, no DOM) compiles cleanly.
interface BrowserIdbRequest<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface BrowserIdbStore {
  get: (key: string) => BrowserIdbRequest<unknown>;
  put: (val: unknown, key: string) => BrowserIdbRequest<unknown>;
  getAllKeys: () => BrowserIdbRequest<unknown[]>;
  clear: () => BrowserIdbRequest<unknown>;
}

interface BrowserIdbTx {
  objectStore: (name: string) => BrowserIdbStore;
  error?: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

interface BrowserIdbDb {
  objectStoreNames: { contains: (name: string) => boolean };
  createObjectStore: (name: string) => void;
  transaction: (name: string, mode: string) => BrowserIdbTx;
  close: () => void;
}

interface BrowserIdbOpenRequest extends BrowserIdbRequest<BrowserIdbDb> {
  onupgradeneeded: (() => void) | null;
}

interface BrowserStorage {
  length: number;
  key: (idx: number) => string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, val: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

interface BrowserGlobals {
  indexedDB: {
    open: (name: string, version?: number) => BrowserIdbOpenRequest;
  };
  localStorage: BrowserStorage;
  sessionStorage?: BrowserStorage;
  Navigator?: { prototype?: Record<string, unknown> };
  navigator?: { onLine?: boolean };
  Event?: new (type: string) => unknown;
  dispatchEvent?: (ev: unknown) => boolean;
  __e2eOfflineFallback?: boolean;
  __desbrava?: Record<string, unknown>;
}

export interface WebSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pageErrors: string[];
  consoleErrors: string[];
  setAllowOfflineConsoleErrors: (allow: boolean) => void;
  close: () => Promise<void>;
}

function isExpectedOfflineError(msg: string): boolean {
  return (
    msg.includes('ERR_INTERNET_DISCONNECTED') ||
    msg.includes('ERR_FAILED') ||
    msg.includes('ERR_NAME_NOT_RESOLVED') ||
    msg.includes('Failed to load resource')
  );
}

const ZERO_BOUNCE_PATH_RE = /\/auth\/v1\/(signup|recover|resend)(\?|$)/;

const offlineRoutes = new WeakMap<
  WebSession,
  { matcher: (url: URL) => boolean; handler: (route: Route) => Promise<void> }
>();

export async function installZeroBounceGuard(
  page: Page,
  pageErrors: string[],
): Promise<void> {
  await page.route(
    (url) => ZERO_BOUNCE_PATH_RE.test(url.pathname),
    async (route) => {
      const reqUrl = route.request().url();
      pageErrors.push(`ZERO_BOUNCE_VIOLATION: blocked forbidden auth endpoint ${reqUrl}`);
      await route.abort('failed');
    },
  );
}

export async function launchWebSession(opts?: {
  allowOfflineErrors?: boolean;
  stubExternalTiles?: boolean;
  allowMockAuthEndpoints?: boolean;
}): Promise<WebSession> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'pt-BR',
  });

  await context.addInitScript(() => {
    const g = globalThis as unknown as BrowserGlobals;
    if (g.Navigator?.prototype) {
      Object.defineProperty(g.Navigator.prototype, 'onLine', {
        configurable: true,
        get: () => {
          try {
            const flag = g.sessionStorage?.getItem('__e2eOffline');
            if (flag === '1') return false;
            if (flag === '0') return true;
          } catch {
            // opaque origin
          }
          return g.__e2eOfflineFallback !== true;
        },
      });
    }
  });

  const page = await context.newPage();

  if (opts?.stubExternalTiles !== false) {
    // Keep external vector tile / geocoding CDNs from polluting offline or sandboxed runs.
    await context.route(
      (url) =>
        url.hostname.includes('openfreemap.org') ||
        url.hostname.includes('openstreetmap.org'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        }),
    );
  }

  let allowOffline = opts?.allowOfflineErrors ?? false;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  if (!opts?.allowMockAuthEndpoints) {
    await installZeroBounceGuard(page, pageErrors);
  }

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err));
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (allowOffline && isExpectedOfflineError(text)) return;
    consoleErrors.push(text);
  });

  return {
    browser,
    context,
    page,
    pageErrors,
    consoleErrors,
    setAllowOfflineConsoleErrors: (allow: boolean) => {
      allowOffline = allow;
    },
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

export async function setExternalOffline(
  session: WebSession,
  baseUrl: string,
  offline: boolean,
): Promise<void> {
  session.setAllowOfflineConsoleErrors(offline);
  const existing = offlineRoutes.get(session);
  if (existing) {
    await session.page.unroute(existing.matcher, existing.handler);
    offlineRoutes.delete(session);
  }

  if (offline) {
    const matcher = (url: URL) =>
      !url.href.startsWith(baseUrl) && !ZERO_BOUNCE_PATH_RE.test(url.pathname);
    const handler = async (route: Route) => {
      await route.abort('internetdisconnected');
    };
    offlineRoutes.set(session, { matcher, handler });
    await session.page.route(matcher, handler);
  }

  if (session.page.url() === 'about:blank') {
    await session.context.addInitScript((isOffline: boolean) => {
      const g = globalThis as unknown as BrowserGlobals;
      g.__e2eOfflineFallback = isOffline;
    }, offline);
  } else {
    await session.page.evaluate((isOffline: boolean) => {
      const g = globalThis as unknown as BrowserGlobals;
      try {
        g.sessionStorage?.setItem('__e2eOffline', isOffline ? '1' : '0');
      } catch {
        // ignore
      }
      g.__e2eOfflineFallback = isOffline;
      if (g.dispatchEvent && g.Event) {
        g.dispatchEvent(new g.Event(isOffline ? 'offline' : 'online'));
      }
    }, offline);
  }
}

export async function drainModals(
  page: Page,
  opts?: { maxSteps?: number; expectSummary?: boolean },
): Promise<boolean> {
  const maxSteps = opts?.maxSteps ?? 12;
  if (opts?.expectSummary) {
    // finishAndSaveTrack() is async (IDB put), so wait for the first post-finish modal to mount.
    await page
      .getByTestId('modal-summary')
      .or(page.getByTestId('modal-backdrop'))
      .or(page.getByTestId('modal-ok'))
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => undefined);
  }

  for (let i = 0; i < maxSteps; i++) {
    const summaryVisible = await page
      .getByTestId('modal-summary')
      .isVisible()
      .catch(() => false);
    if (summaryVisible) return true;

    const okBtn = page.getByTestId('modal-ok').first();
    const okVisible = await okBtn.isVisible().catch(() => false);
    if (okVisible) {
      await okBtn.click();
      await page.waitForTimeout(180);
      continue;
    }

    const backdrop = page.getByTestId('modal-backdrop').first();
    const backdropVisible = await backdrop.isVisible().catch(() => false);
    if (backdropVisible) {
      await page.waitForTimeout(180);
      continue;
    }
    break;
  }

  if (opts?.expectSummary) {
    await page.getByTestId('modal-summary').waitFor({ state: 'visible', timeout: 5000 });
    return true;
  }
  return false;
}

export async function completeGuestOnboarding(
  page: Page,
  opts: { name: string; modality: 'bike' | 'run' },
): Promise<void> {
  await page.getByTestId('title-screen').waitFor({ state: 'visible', timeout: 15_000 });
  await page.getByTestId('press-start').click();
  await page.getByTestId('create-screen').waitFor({ state: 'visible', timeout: 10_000 });

  await page.getByTestId(opts.modality === 'run' ? 'mode-run' : 'mode-bike').click();
  await page.getByTestId('step-next-0').click();
  await page.getByTestId('step-next-1').click();

  const nameInput = page.getByTestId('hero-name');
  await nameInput.fill(opts.name);
  await page.getByTestId('create-start').click();

  await page.getByTestId('tabbar').waitFor({ state: 'visible', timeout: 10_000 });
  const startVisible = await page.getByTestId('start').isVisible().catch(() => false);
  if (startVisible) {
    await page.getByTestId('tab-map').click();
  }
}

export interface SerializedIdbValue {
  kind: 'missing' | 'uint8array' | 'json';
  bytes?: number[];
  json?: unknown;
}

export async function readIdbKey(page: Page, key: string): Promise<SerializedIdbValue> {
  return page.evaluate(async (targetKey: string): Promise<SerializedIdbValue> => {
    const g = globalThis as unknown as BrowserGlobals;
    const db = await new Promise<BrowserIdbDb>((resolve, reject) => {
      const req = g.indexedDB.open('desbrava');
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const val = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(targetKey);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (val === undefined || val === null) {
        return { kind: 'missing' };
      }
      if (val instanceof Uint8Array) {
        return { kind: 'uint8array', bytes: Array.from(val) };
      }
      if (typeof val === 'string') {
        try {
          return { kind: 'json', json: JSON.parse(val) };
        } catch {
          return { kind: 'json', json: val };
        }
      }
      return { kind: 'json', json: val };
    } finally {
      db.close();
    }
  }, key);
}

export async function writeIdbKey(
  page: Page,
  key: string,
  value: unknown,
  asUint8Array = false,
): Promise<void> {
  await page.evaluate(
    async (args: { key: string; value: unknown; asUint8Array: boolean }) => {
      const g = globalThis as unknown as BrowserGlobals;
      const db = await new Promise<BrowserIdbDb>((resolve, reject) => {
        const req = g.indexedDB.open('desbrava');
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kv')) {
            req.result.createObjectStore('kv');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('kv', 'readwrite');
          const payload = args.asUint8Array
            ? Uint8Array.from(args.value as number[])
            : args.value;
          const req = tx.objectStore('kv').put(payload, args.key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IDB transaction error'));
          tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IDB transaction aborted'));
          req.onerror = () => reject(req.error ?? new Error('IDB put error'));
        });
      } finally {
        db.close();
      }
    },
    { key, value, asUint8Array },
  );
}

export async function listIdbKeys(page: Page): Promise<string[]> {
  return page.evaluate(async (): Promise<string[]> => {
    const g = globalThis as unknown as BrowserGlobals;
    const db = await new Promise<BrowserIdbDb>((resolve, reject) => {
      const req = g.indexedDB.open('desbrava');
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const keys = await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return keys.map((k) => String(k));
    } finally {
      db.close();
    }
  });
}

export async function waitForIdbKey(
  page: Page,
  key: string,
  timeoutMs = 5000,
): Promise<SerializedIdbValue> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await readIdbKey(page, key);
    if (v.kind !== 'missing') return v;
    await page.waitForTimeout(150);
  }
  return readIdbKey(page, key);
}

export async function readLocalStorageAll(
  page: Page,
): Promise<Record<string, string>> {
  return page.evaluate((): Record<string, string> => {
    const g = globalThis as unknown as BrowserGlobals;
    const out: Record<string, string> = {};
    for (let i = 0; i < g.localStorage.length; i++) {
      const k = g.localStorage.key(i);
      if (k !== null) {
        const v = g.localStorage.getItem(k);
        if (v !== null) out[k] = v;
      }
    }
    return out;
  });
}

export async function setLocalStorageItem(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    (args: { key: string; value: string }) => {
      const g = globalThis as unknown as BrowserGlobals;
      g.localStorage.setItem(args.key, args.value);
    },
    { key, value },
  );
}

export function buildTestJwt(userId: string, email: string, expSec?: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = expSec ?? nowSec + 3600;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email,
      role: 'authenticated',
      aud: 'authenticated',
      iat: nowSec,
      exp,
    }),
  ).toString('base64url');
  const sig = Buffer.from('e2e-test-signature').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

export async function seedSupabaseWebSession(
  page: Page,
  opts: {
    userId: string;
    email: string;
    ref?: string;
    accessToken?: string;
    refreshToken?: string;
    expSec?: number;
  },
): Promise<void> {
  const ref = opts.ref ?? 'lugwebngeyadfrqoapsg';
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = opts.expSec ?? nowSec + 3600;
  const accessToken = opts.accessToken ?? buildTestJwt(opts.userId, opts.email, expiresAt);
  const refreshToken = opts.refreshToken ?? 'e2e_refresh_token';

  await setLocalStorageItem(
    page,
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: Math.max(60, expiresAt - nowSec),
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: {
        id: opts.userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: opts.email,
      },
    }),
  );
}

export async function openAuthModal(page: Page): Promise<void> {
  const authOpenDirect = page
    .getByTestId('auth-open-btn')
    .or(page.getByText(/Entrar|Vincular|Conta/i))
    .first();
  if (!(await authOpenDirect.isVisible().catch(() => false))) {
    await page.getByTestId('tab-stats').click();
    await page.getByTestId('stats-scroll').waitFor({ state: 'visible', timeout: 10_000 });
  }
  const btn = page
    .getByTestId('auth-open-btn')
    .or(page.getByText(/Entrar|Vincular|Conta/i))
    .first();
  await btn.waitFor({ state: 'visible', timeout: 10_000 });
  await btn.click();
  await page.getByTestId('auth-modal').waitFor({ state: 'visible', timeout: 10_000 });
}

export async function signInViaAuthModal(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.getByTestId('auth-modal').waitFor({ state: 'visible', timeout: 10_000 });

  const signInTab = page.getByTestId('auth-mode-signin');
  if (await signInTab.isVisible().catch(() => false)) {
    await signInTab.click();
  } else {
    const submitBtn = page.getByTestId('auth-submit');
    const submitText = (await submitBtn.innerText().catch(() => '')).trim();
    if (/Criar conta|Cadastrar|Registrar/i.test(submitText)) {
      await page.getByTestId('auth-toggle-mode').click();
      await page.waitForTimeout(100);
    }
    const afterText = (await submitBtn.innerText().catch(() => '')).trim();
    if (/Criar conta|Cadastrar|Registrar/i.test(afterText)) {
      throw new Error(
        `Refusing auth-submit in Sign-Up mode (submit text: "${afterText}") to protect zero-bounce policy`,
      );
    }
  }

  await page.getByTestId('auth-email-input').fill(email);
  await page.getByTestId('auth-password-input').fill(password);
  await page.getByTestId('auth-submit').click();
}

export async function recordBriefSimRide(page: Page, durationMs = 1400): Promise<void> {
  await page.getByTestId('tab-record').click();
  await page.getByTestId('start').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('start').click();
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(durationMs);
  await page.keyboard.up('ArrowUp');
  await page.getByTestId('pause').click();
  await drainModals(page);
  await page.getByTestId('finish').click();
  await drainModals(page, { expectSummary: true });
  await page.getByTestId('modal-ok').click();
}

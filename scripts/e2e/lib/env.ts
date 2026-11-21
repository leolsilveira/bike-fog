import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type E2EMode = 'auto' | 'strict';

export interface E2EEnv {
  projectRoot: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseAnonJwt: string;
  serviceRoleKey: string;
  keepData: boolean;
  mode: E2EMode;
  skipWeb: boolean;
  buildWeb: boolean;
}

const DEFAULT_SUPABASE_URL = 'https://lugwebngeyadfrqoapsg.supabase.co';
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_viEgB_TkbnmAbmZjJw355w_HgUzi_FP';
const DEFAULT_ANON_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1Z3dlYm5nZXlhZGZycW9hcHNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyMDE0NzAsImV4cCI6MjExMDc3NzQ3MH0.YiSrCFIoaAJVuUvucKMI8GhdnTt_yT2oXbaJ687opRs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

let runtimeModeOverride: E2EMode | null = null;
let runtimeSkipWebOverride: boolean | null = null;
let runtimeBuildWebOverride: boolean | null = null;

export function setRunnerConfig(opts: {
  mode?: E2EMode;
  skipWeb?: boolean;
  buildWeb?: boolean;
}): void {
  if (opts.mode !== undefined) runtimeModeOverride = opts.mode;
  if (opts.skipWeb !== undefined) runtimeSkipWebOverride = opts.skipWeb;
  if (opts.buildWeb !== undefined) runtimeBuildWebOverride = opts.buildWeb;
}

export function resetEnvCache(): void {
  cachedFileEnv = null;
  runtimeModeOverride = null;
  runtimeSkipWebOverride = null;
  runtimeBuildWebOverride = null;
}

function parseEnvFile(filePath: string, target: Map<string, string>): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key && val.trim().length > 0 && !target.has(key)) {
      target.set(key, val);
    }
  }
}

let cachedFileEnv: Map<string, string> | null = null;

function getFileEnv(): Map<string, string> {
  if (cachedFileEnv) return cachedFileEnv;
  const map = new Map<string, string>();
  parseEnvFile(path.join(PROJECT_ROOT, '.env.test'), map);
  parseEnvFile(path.join(PROJECT_ROOT, '.env.local'), map);
  parseEnvFile(path.join(PROJECT_ROOT, '.env'), map);
  cachedFileEnv = map;
  return map;
}

function pick(direct: string | undefined, fallbackKeys: string[], defaultValue = ''): string {
  if (direct && direct.trim().length > 0) return direct.trim();
  const fileMap = getFileEnv();
  for (const k of fallbackKeys) {
    const v = fileMap.get(k);
    if (v && v.trim().length > 0) return v.trim();
  }
  return defaultValue;
}

export function getEnv(): E2EEnv {
  const fileMap = getFileEnv();

  const supabaseUrl =
    process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    pick(undefined, ['EXPO_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'], DEFAULT_SUPABASE_URL);

  const supabasePublishableKey =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    pick(
      undefined,
      [
        'EXPO_PUBLIC_SUPABASE_ANON_KEY',
        'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'SUPABASE_PUBLISHABLE_KEY',
      ],
      DEFAULT_PUBLISHABLE_KEY,
    );

  const supabaseAnonJwt =
    process.env.SUPABASE_ANON_JWT?.trim() ||
    pick(undefined, ['SUPABASE_ANON_JWT'], DEFAULT_ANON_JWT);

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    pick(undefined, ['SUPABASE_SERVICE_ROLE_KEY'], '');

  const keepDataRaw =
    process.env.E2E_KEEP_DATA?.trim() || fileMap.get('E2E_KEEP_DATA')?.trim() || '';

  const envModeRaw = process.env.E2E_MODE?.trim() || fileMap.get('E2E_MODE')?.trim() || 'auto';
  const mode: E2EMode =
    runtimeModeOverride ?? (envModeRaw === 'strict' ? 'strict' : 'auto');

  const envSkipWebRaw =
    process.env.E2E_SKIP_WEB?.trim() || fileMap.get('E2E_SKIP_WEB')?.trim() || '';
  const skipWeb = runtimeSkipWebOverride ?? envSkipWebRaw === '1';

  const envBuildWebRaw =
    process.env.E2E_BUILD_WEB?.trim() || fileMap.get('E2E_BUILD_WEB')?.trim() || '';
  const buildWeb = runtimeBuildWebOverride ?? envBuildWebRaw === '1';

  return {
    projectRoot: PROJECT_ROOT,
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabasePublishableKey,
    supabaseAnonJwt,
    serviceRoleKey,
    keepData: keepDataRaw === '1',
    mode,
    skipWeb,
    buildWeb,
  };
}

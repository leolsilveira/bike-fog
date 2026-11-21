import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setRunnerConfig, type E2EMode } from './lib/env.ts';
import { probeCapabilities, resetProbeCache } from './lib/probe.ts';
import { buildWebBundle, checkDistStatus } from './lib/webHarness.ts';

interface TierSpec {
  id: string;
  label: string;
  file: string;
}

interface TierCounts {
  label: string;
  pass: number;
  fail: number;
  pending: number;
  skip: number;
  milestones: Map<string, number>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TIERS: TierSpec[] = [
  { id: '1', label: 'Tier 1', file: path.join(__dirname, 'tier1-features.test.ts') },
  { id: '2', label: 'Tier 2', file: path.join(__dirname, 'tier2-boundaries.test.ts') },
  { id: '3', label: 'Tier 3', file: path.join(__dirname, 'tier3-combinations.test.ts') },
  { id: '4', label: 'Tier 4', file: path.join(__dirname, 'tier4-scenarios.test.ts') },
];

function parseCliArgs(argv: string[]): {
  tier: string;
  mode: E2EMode;
  build: boolean;
  skipWeb: boolean;
} {
  let tier = 'all';
  let mode: E2EMode = 'auto';
  let build = false;
  let skipWeb = false;

  for (const arg of argv) {
    if (arg.startsWith('--tier=')) {
      tier = arg.slice('--tier='.length).trim().toLowerCase();
    } else if (arg.startsWith('--mode=')) {
      const m = arg.slice('--mode='.length).trim().toLowerCase();
      mode = m === 'strict' ? 'strict' : 'auto';
    } else if (arg === '--strict') {
      mode = 'strict';
    } else if (arg === '--build') {
      build = true;
    } else if (arg === '--skip-web') {
      skipWeb = true;
    }
  }
  return { tier, mode, build, skipWeb };
}

function extractMilestone(skipMsg: string): string {
  const m = /^\[PENDING_MILESTONE:([^\]]+)\]/.exec(skipMsg);
  return m?.[1] ?? 'Mx';
}

async function runSelectedTiers(selected: TierSpec[]): Promise<{
  results: TierCounts[];
  unexpectedFails: number;
}> {
  const countsByFile = new Map<string, TierCounts>();
  for (const spec of selected) {
    countsByFile.set(path.resolve(spec.file), {
      label: spec.label,
      pass: 0,
      fail: 0,
      pending: 0,
      skip: 0,
      milestones: new Map<string, number>(),
    });
  }

  let currentFile: string | null = null;
  let unexpectedFails = 0;

  const ensureHeader = (specFile: string) => {
    if (currentFile === specFile) return;
    currentFile = specFile;
    const spec = selected.find((s) => path.resolve(s.file) === specFile);
    if (spec) {
      console.log(`\n=== ${spec.label} (${path.basename(spec.file)}) ===`);
    }
  };

  const resolveCounts = (
    file?: string,
    name?: string,
  ): { key: string | null; counts: TierCounts | null } => {
    if (file) {
      const resolved = path.resolve(file);
      const hit = countsByFile.get(resolved);
      if (hit) return { key: resolved, counts: hit };
    }
    if (name) {
      const resolvedName = path.resolve(name);
      const hit = countsByFile.get(resolvedName);
      if (hit) return { key: resolvedName, counts: hit };
    }
    if (currentFile) {
      return { key: currentFile, counts: countsByFile.get(currentFile) ?? null };
    }
    return { key: null, counts: null };
  };

  const stream = run({
    files: selected.map((s) => s.file),
    isolation: 'none',
    concurrency: false,
  });

  for await (const event of stream) {
    if (event.type === 'test:pass') {
      const detailsType = (event.data.details as { type?: string } | undefined)?.type;
      if (detailsType === 'suite') continue;
      const { key, counts } = resolveCounts(event.data.file, event.data.name);
      if (!counts || !key) continue;
      ensureHeader(key);
      const skipVal = event.data.skip;
      if (typeof skipVal === 'string' && skipVal.startsWith('[PENDING_MILESTONE:')) {
        counts.pending += 1;
        const ms = extractMilestone(skipVal);
        counts.milestones.set(ms, (counts.milestones.get(ms) ?? 0) + 1);
      } else if (skipVal) {
        counts.skip += 1;
      } else {
        counts.pass += 1;
        console.log(`  PASS  ${event.data.name}`);
      }
    } else if (event.type === 'test:fail') {
      const detailsType = (event.data.details as { type?: string } | undefined)?.type;
      if (detailsType === 'suite') continue;
      const { key, counts } = resolveCounts(event.data.file, event.data.name);
      const err = (event.data.details as { error?: Error } | undefined)?.error;
      const msg = err?.message ?? 'Unknown test failure';
      if (counts && key) {
        ensureHeader(key);
        counts.fail += 1;
      } else {
        unexpectedFails += 1;
      }
      console.error(`  FAIL  ${event.data.name}\n        ${msg}`);
    }
  }

  return {
    results: selected.map((s) => countsByFile.get(path.resolve(s.file))!),
    unexpectedFails,
  };
}

function pad(val: string | number, width: number, right = false): string {
  const s = String(val);
  return right ? s.padStart(width, ' ') : s.padEnd(width, ' ');
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  setRunnerConfig({
    mode: opts.mode,
    skipWeb: opts.skipWeb,
    buildWeb: opts.build,
  });
  process.env.E2E_MODE = opts.mode;
  process.env.E2E_SKIP_WEB = opts.skipWeb ? '1' : '0';

  if (opts.build && !opts.skipWeb) {
    console.log('Building web bundle (npm run build:web)...');
    buildWebBundle();
    resetProbeCache();
  }

  const distStatus = checkDistStatus();
  if (!opts.skipWeb && distStatus.exists && distStatus.stale) {
    console.warn(
      'WARN: dist/index.html is older than App.tsx/src/package.json. Pass --build to refresh.',
    );
  }

  const caps = await probeCapabilities();
  console.log('Desbrava E2E Runner');
  console.log(`Mode: ${opts.mode} | Tier: ${opts.tier} | SkipWeb: ${opts.skipWeb}`);
  console.log(
    `Capabilities: authSettings=${caps.authSettings} designDoc=${caps.designDoc} schema=${caps.schema} verifyActivity=${caps.verifyActivity} serviceRoleKey=${caps.serviceRoleKey} distWeb=${caps.distWeb} sync=${caps.syncEngine} authUi=${caps.authUi} socialUi=${caps.socialUi} storeUi=${caps.storeUi}`,
  );

  const selected =
    opts.tier === 'all' ? TIERS : TIERS.filter((t) => t.id === opts.tier);
  if (selected.length === 0) {
    console.error(`Invalid --tier=${opts.tier}. Use 1, 2, 3, 4, or all.`);
    process.exitCode = 1;
    return;
  }

  const { results, unexpectedFails } = await runSelectedTiers(selected);

  console.log('\n=== E2E Summary ===');
  console.log('Tier   | Pass | Fail | Pending (Mx) | Skip | Status');
  console.log('-------+------+------+--------------+------+-------');

  let totalPass = 0;
  let totalFail = unexpectedFails;
  let totalPending = 0;
  let totalSkip = 0;

  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    totalPending += r.pending;
    totalSkip += r.skip;
    const msSummary =
      r.milestones.size > 0
        ? ` (${Array.from(r.milestones.entries())
            .map(([k, v]) => `${k}:${v}`)
            .join(',')})`
        : '';
    const tierFailed =
      r.fail > 0 || (opts.mode === 'strict' && (r.pending > 0 || r.skip > 0));
    const status = tierFailed ? 'FAIL' : 'PASS';
    console.log(
      `${pad(r.label, 6)} | ${pad(r.pass, 4, true)} | ${pad(r.fail, 4, true)} | ${pad(`${r.pending}${msSummary}`, 12, true)} | ${pad(r.skip, 4, true)} | ${status}`,
    );
  }

  console.log('-------+------+------+--------------+------+-------');
  const overallFailed =
    totalFail > 0 || (opts.mode === 'strict' && (totalPending > 0 || totalSkip > 0));
  console.log(
    `${pad('Total', 6)} | ${pad(totalPass, 4, true)} | ${pad(totalFail, 4, true)} | ${pad(totalPending, 12, true)} | ${pad(totalSkip, 4, true)} | ${overallFailed ? 'FAIL' : 'PASS'}`,
  );

  if (overallFailed) {
    process.exitCode = 1;
  }
}

await main();

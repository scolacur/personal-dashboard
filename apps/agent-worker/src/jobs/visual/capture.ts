import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentWorkerConfig } from '../../shared/config';
import { authHeaderValue, proxyGitArgs } from '../../shared/checkout';
import { defaultExec, droppedEnv, type Exec } from '../conflicts/resolve';
import type { CaptureTarget } from './routes';

/**
 * One visual capture (PD-773): build a PR's head, serve it, photograph the routes.
 *
 *   1. clone the PR head (read token), `npm ci`, build the web app and the server;
 *   2. start the PR's server on a free port with an EMPTY scratch data dir and `VISUAL_FIXTURES=1`,
 *      so the PR's own fixtures (`apps/server/src/visual-fixtures/`, PD-798) seed sample data into
 *      it; the real board (`/data/dashboard.db`) is never in reach;
 *   3. run `capture-cli` against it: desktop and phone, light and dark, each page then each of its
 *      click steps;
 *   4. copy the PNGs to `<dataDir>/visual-captures/pr-<n>/<sha7>/` with a `manifest.json`, which the
 *      dashboard serves.
 * Steps 1-3 run the PR's own code (and a browser rendering it), so they run DROPPED to the Robot's
 * uid with the allowlisted env (PD-777). Only git and the final copy run as the worker.
 */

export interface Shot {
  route: string;
  viewport: string;
  scheme: string;
  file: string;
  /** PD-798: the click step this shot was taken after (`click "Add metric"`); absent for the page as loaded. */
  step?: string;
  /** 1-based position of that step on its route. */
  stepIndex?: number;
}
/** A step that could not run (PD-798): recorded, never silently skipped. */
export interface StepFailure {
  route: string;
  step: string;
  reason: string;
}
export interface CaptureManifest {
  prNumber: number;
  headSha: string;
  routes: string[];
  shots: Shot[];
  /** PD-798: steps that failed, once per route (the first viewport that hit it). */
  failures?: StepFailure[];
  createdAt: number;
}

export type CaptureOutcome = { kind: 'captured'; dir: string; manifest: CaptureManifest } | { kind: 'failed'; reason: string };

export interface ServerHandle {
  stop(): void;
}
/** Start the PR's server in the background; resolves once it was spawned. Injectable for tests. */
export type ServerStarter = (cwd: string, port: number, dataDir: string) => ServerHandle;

const BUILD_TIMEOUT_MS = 30 * 60_000;
const TAIL = 1500;
const tail = (s: string) => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

export function capturesRoot(config: AgentWorkerConfig): string {
  return path.join(config.dataDir, 'visual-captures');
}
export function captureDir(config: AgentWorkerConfig, prNumber: number, headSha: string): string {
  return path.join(capturesRoot(config), `pr-${prNumber}`, headSha.slice(0, 7));
}

export function defaultServerStarter(config: AgentWorkerConfig): ServerStarter {
  const { codingUid, codingGid } = config.robot;
  return (cwd, port, dataDir) => {
    const child = spawn('node', ['apps/server/dist/index.js'], {
      cwd,
      env: { ...droppedEnv(config), PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', VISUAL_FIXTURES: '1' },
      stdio: 'ignore',
      ...(codingUid !== undefined ? { uid: codingUid, gid: codingGid ?? codingUid } : {}),
    });
    return { stop: () => void child.kill('SIGTERM') };
  };
}

/** Poll the server's health route until it answers, or give up. */
export async function waitForHealth(baseUrl: string, timeoutMs = 60_000, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetchImpl(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface CaptureDeps {
  exec?: Exec;
  startServer?: ServerStarter;
  waitHealthy?: (baseUrl: string) => Promise<boolean>;
  /** The capture-cli script. Defaults to the one beside this bundle. */
  cliPath?: string;
  remoteUrl?: string;
  port?: number;
}

export async function captureVisuals(
  config: AgentWorkerConfig,
  target: { repo: string; prNumber: number; headSha: string; targets: CaptureTarget[] },
  deps: CaptureDeps = {},
  now: number = Date.now(),
): Promise<CaptureOutcome> {
  const exec = deps.exec ?? defaultExec(config);
  const work = path.join(config.dataDir, 'visual-work', `pr-${target.prNumber}`);
  const token = config.githubReadToken;
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${authHeaderValue(token)}`] : [];
  const git = (args: string[]) => exec('git', [...auth, ...proxyGitArgs(config), '-c', `safe.directory=${work}`, ...args]);

  rmSync(work, { recursive: true, force: true });
  mkdirSync(path.dirname(work), { recursive: true });
  let server: ServerHandle | null = null;
  try {
    const clone = await git(['clone', '--no-tags', '--depth', '1', deps.remoteUrl ?? `https://github.com/${target.repo}.git`, work]);
    if (clone.code !== 0) return { kind: 'failed', reason: `clone failed: ${tail(clone.stderr)}` };
    const fetchHead = await git(['-C', work, 'fetch', '--depth', '1', 'origin', target.headSha]);
    if (fetchHead.code !== 0) return { kind: 'failed', reason: `fetch of ${target.headSha.slice(0, 7)} failed: ${tail(fetchHead.stderr)}` };
    const co = await git(['-C', work, 'checkout', '--detach', target.headSha]);
    if (co.code !== 0) return { kind: 'failed', reason: `checkout failed: ${tail(co.stderr)}` };

    // From here the PR's code runs: hand the tree to the Robot's uid.
    if (config.robot.codingUid !== undefined) {
      await exec('chown', ['-R', `${config.robot.codingUid}:${config.robot.codingGid ?? config.robot.codingUid}`, work]);
    }
    for (const [cmd, args] of [
      ['npm', ['ci']],
      ['npm', ['run', 'build', '-w', 'apps/web']],
      ['npm', ['run', 'build', '-w', 'apps/server']],
    ] as const) {
      const r = await exec(cmd, [...args], { cwd: work, dropped: true, timeoutMs: BUILD_TIMEOUT_MS });
      if (r.code !== 0) return { kind: 'failed', reason: `${cmd} ${args.join(' ')} failed: ${tail(r.stderr || r.stdout)}` };
    }

    const port = deps.port ?? 4300 + (target.prNumber % 500);
    const baseUrl = `http://127.0.0.1:${port}`;
    const scratch = path.join(work, '.visual-data');
    const shots = path.join(work, '.visual-shots');
    mkdirSync(scratch, { recursive: true });
    if (config.robot.codingUid !== undefined) {
      await exec('chown', ['-R', `${config.robot.codingUid}:${config.robot.codingGid ?? config.robot.codingUid}`, scratch]);
    }
    server = (deps.startServer ?? defaultServerStarter(config))(work, port, scratch);
    if (!(await (deps.waitHealthy ?? ((u) => waitForHealth(u)))(baseUrl))) {
      return { kind: 'failed', reason: "the PR's server did not come up" };
    }

    const cli = deps.cliPath ?? path.join(__dirname, 'capture-cli.js');
    const args = { baseUrl, targets: target.targets, outDir: shots, chromiumPath: config.visual.chromiumPath };
    const cap = await exec('node', [cli, JSON.stringify(args)], { cwd: work, dropped: true, timeoutMs: 10 * 60_000 });
    if (cap.code !== 0) return { kind: 'failed', reason: `capture failed: ${tail(cap.stderr)}` };
    let written: Shot[];
    let failures: StepFailure[];
    try {
      const out = JSON.parse(cap.stdout) as { shots: Shot[]; failures?: StepFailure[] };
      written = out.shots;
      failures = out.failures ?? [];
    } catch {
      return { kind: 'failed', reason: `capture printed no manifest: ${tail(cap.stdout)}` };
    }

    const dest = captureDir(config, target.prNumber, target.headSha);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const kept = written.filter((s) => /^[A-Za-z0-9-]+\.png$/.test(s.file) && existsSync(path.join(shots, s.file)));
    for (const s of kept) cpSync(path.join(shots, s.file), path.join(dest, s.file));
    const manifest: CaptureManifest = {
      prNumber: target.prNumber, headSha: target.headSha, routes: target.targets.map((t) => t.route), shots: kept, failures, createdAt: now,
    };
    writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { kind: 'captured', dir: dest, manifest };
  } finally {
    server?.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

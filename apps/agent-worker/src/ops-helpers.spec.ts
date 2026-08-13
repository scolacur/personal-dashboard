// The operator helpers live at the repo root in `scripts/`, which has no test runner of its own.
// This spec sits here for the same reason `shared/decisions.spec.ts` does — agent-worker is the
// thing these helpers operate, and it already sets the precedent of a spec reaching repo-root files.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from './shared/decisions';

const ROOT = findRepoRoot(__dirname);
const ALIASES = readFileSync(path.join(ROOT, 'scripts/pd-aliases.sh'), 'utf8');
const FORMATTER = path.join(ROOT, 'scripts/robot-logs-format.py');

/** Every shell function the file defines, e.g. `robot-logs() {`. */
function definedFunctions(): string[] {
  return [...ALIASES.matchAll(/^([a-z][a-z0-9-]*)\(\)\s*\{/gm)].map((m) => m[1]);
}

/** The `pd-help` body — the printed table only, so a mention in a comment doesn't count. */
function helpBody(): string {
  const start = ALIASES.indexOf('pd-help() {');
  expect(start).toBeGreaterThan(-1);
  return ALIASES.slice(start);
}

function runFormatter(input: string, args: string[] = []): string {
  return execFileSync('python3', [FORMATTER, ...args], { input, encoding: 'utf8' });
}

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ level: 30, time: 1786552796624, pid: 1, hostname: 'nas', msg: 'robot: dispatched', ...over });

describe('pd-help stays in step with the functions that exist', () => {
  // This ticket exists BECAUSE the sortie-* block went stale against a retired runtime. A help
  // table nobody notices is wrong is worse than none — it is the thing people trust.
  it('lists every helper the file defines', () => {
    const help = helpBody();
    for (const fn of definedFunctions()) {
      if (fn === 'pd-help') continue;
      expect(help, `${fn}() is defined but pd-help never mentions it`).toContain(fn);
    }
  });

  it('does not advertise a helper that no longer exists', () => {
    const defined = new Set(definedFunctions());
    const advertised = [...helpBody().matchAll(/'((?:pd|robot)-[a-z-]+)/g)].map((m) => m[1]);
    for (const name of advertised) {
      expect(defined, `pd-help advertises ${name}, which is not defined`).toContain(name);
    }
  });

  it('names each retired sortie helper with its replacement, rather than dropping it silently', () => {
    // Someone with the old commands in muscle memory needs to be told where they went.
    const help = helpBody();
    for (const retired of ['sortie-healthcheck', 'sortie-watchdog', 'sortie-sessions']) {
      expect(help).toContain(retired);
    }
  });
});

describe('the helpers point at the real deployment', () => {
  it('uses the container and compose file that ops/agent-worker actually defines', () => {
    const compose = readFileSync(path.join(ROOT, 'ops/agent-worker/docker-compose.egress.yml'), 'utf8');
    expect(compose).toContain('container_name: agent-worker');
    expect(compose).toContain('image: agent-worker-dashboard');
    expect(ALIASES).toContain('ops/agent-worker/docker-compose.egress.yml');
  });

  it('hits the task-monitor API base, not the renamed one that 404s', () => {
    expect(ALIASES).toContain('/api/widgets/task-monitor');
    expect(ALIASES).not.toContain('/api/widgets/agent-dashboard');
  });

  it('never targets the retired sortie container', () => {
    expect(ALIASES).not.toMatch(/docker (logs|ps|exec|restart)[^\n]*\bsortie\b/);
  });
});

describe('robot-logs-format', () => {
  it('renders time, level, message and the ids an operator scans for', () => {
    const out = runFormatter(line({ ticketId: 429, branch: 'robot/429' }));
    expect(out).toMatch(/\d\d:\d\d:\d\d/);
    expect(out).toContain('INFO');
    expect(out).toContain('robot: dispatched');
    expect(out).toContain('ticketId=429');
    expect(out).toContain('branch=robot/429');
  });

  it('prints Eastern time, not the NAS host clock', () => {
    // The NAS runs a fixed -05 offset with no DST, so in summer its local time is an hour behind
    // Steve's wall clock. A log line reading 11:39 when the board says 12:39 is a real
    // misdiagnosis, so the formatter pins the zone instead of inheriting the host's.
    const out = runFormatter(line({ time: 1786552796624 }));
    expect(out).toMatch(/^12:39:56/);
  });

  it('honours an explicit TZ override', () => {
    const out = execFileSync('python3', [FORMATTER], {
      input: line({ time: 1786552796624 }),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    });
    expect(out).toMatch(/^16:39:56/);
  });

  it('maps pino levels to names', () => {
    expect(runFormatter(line({ level: 40 }))).toContain('WARN');
    expect(runFormatter(line({ level: 50 }))).toContain('ERROR');
  });

  it('surfaces a thrown error’s message without the stack', () => {
    const out = runFormatter(line({ level: 50, err: { type: 'Error', message: 'db locked', stack: 'at foo\nat bar' } }));
    expect(out).toContain('err=db locked');
    expect(out).not.toContain('at foo');
  });

  it('passes non-JSON lines through untouched', () => {
    // `docker logs` interleaves the container's startup output and npm chatter with pino's.
    // Swallowing those would hide exactly the failures someone runs this to find.
    const out = runFormatter('npm ERR! something broke\n' + line());
    expect(out).toContain('npm ERR! something broke');
    expect(out).toContain('robot: dispatched');
  });

  it('filters to one ticket, dropping other tickets AND unattributable noise', () => {
    const input = [line({ ticketId: 429 }), line({ ticketId: 7 }), 'npm ERR! noise'].join('\n');
    const out = runFormatter(input, ['--ticket', '429']);
    expect(out).toContain('ticketId=429');
    expect(out).not.toContain('ticketId=7');
    // A line with no ticket cannot belong to the ticket being filtered for.
    expect(out).not.toContain('npm ERR!');
  });

  it('--raw returns the original JSON, so nothing the formatter hides is unreachable', () => {
    const out = runFormatter(line({ ticketId: 429, weirdField: 'kept' }), ['--raw']);
    expect(JSON.parse(out.trim())).toMatchObject({ ticketId: 429, weirdField: 'kept' });
  });

  it('does not crash on a record with a missing or malformed time', () => {
    expect(runFormatter(JSON.stringify({ level: 30, msg: 'no time' }))).toContain('--:--:--');
    expect(runFormatter(JSON.stringify({ level: 30, time: 'nonsense', msg: 'bad time' }))).toContain('--:--:--');
  });

  it('skips blank lines rather than printing empty rows', () => {
    expect(runFormatter('\n\n' + line())).toMatch(/^\d\d:\d\d:\d\d[^\n]*\n$/);
  });
});

describe('robot-logs argument handling', () => {
  const run = (script: string) =>
    execFileSync('bash', ['-c', `source ${path.join(ROOT, 'scripts/pd-aliases.sh')}; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, PD_REPO_ROOT: ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  it('rejects -n with no count instead of passing an empty --tail to docker', () => {
    // `docker logs --tail ""` errors in a way that reads like the container is broken.
    expect(() => run('robot-logs -n')).toThrow();
  });

  it('rejects an unknown flag rather than treating it as a ticket id', () => {
    expect(() => run('robot-logs --bogus')).toThrow();
  });

  it('leaks no working variables into the sourcing shell', () => {
    // This file is sourced into a login shell; a stray `_n` or `_ticket` outlives the call.
    const out = run('robot-logs -n 2>/dev/null; echo "n=[${_n:-}] t=[${_ticket:-}]"');
    expect(out).toContain('n=[] t=[]');
  });
});

describe('the script is portable to the shells it claims', () => {
  /** Absent shells are skipped, not failed: the CI runner is not guaranteed to ship zsh, and this
   *  asserts "parses in the shells present here", not "every shell is installed". */
  function has(shell: string): boolean {
    try {
      execFileSync('command', ['-v', shell], { shell: '/bin/sh', stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  // bash and zsh ONLY — deliberately not POSIX `sh`. Every helper in this file is hyphenated
  // (`pd-runs`, `robot-logs`), and POSIX forbids a hyphen in a function name, so dash rejects the
  // file outright with "Bad function name". That has been true since `pd-runs` was written; it is
  // the file's stated contract ("Compatible with bash and zsh"), not a regression.
  //
  // Worth knowing WHY this was invisible locally: on macOS `/bin/sh` IS bash, so `sh -n` passes on
  // a dev machine and fails on Ubuntu CI, where `/bin/sh` is dash. Asserting `sh` here tested the
  // developer's platform, not the contract.
  it('parses under bash and zsh, the shells it claims', () => {
    const checked: string[] = [];
    for (const shell of ['bash', 'zsh']) {
      if (!has(shell)) continue;
      expect(() => execFileSync(shell, ['-n', path.join(ROOT, 'scripts/pd-aliases.sh')])).not.toThrow();
      checked.push(shell);
    }
    // Guard against the skip logic quietly reducing this to a no-op test.
    expect(checked).toContain('bash');
  });
});

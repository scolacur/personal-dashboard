import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProvisionalDecision } from '../../shared/decisions';
import { inMergeOrder, runNumberingCycle, type CycleConfig, type CycleDeps } from './cycle';

const CONFIG_BASE = {
  githubRepo: 'scolacur/personal-dashboard',
  ciTimeoutMs: 60_000,
  ciPollMs: 1_000,
  botName: 'sortie-bot-55',
  botEmail: 'bot@example.invalid',
  baseBranch: 'main',
  gitNetworkArgs: ['-c', 'http.extraHeader=Authorization: Basic SECRET'],
};

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agent_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ticket_id INTEGER,
    title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
  );`);
  return db;
}

/** A tree with `n` provisional decisions and one numbered one. */
function makeRepo(provisional: { id: string; title: string }[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cycle-'));
  mkdirSync(path.join(root, 'DECISIONS/incoming'), { recursive: true });
  writeFileSync(path.join(root, 'DECISIONS/D-079-x.md'), '# D-079: Existing\n\nbody\n');
  writeFileSync(path.join(root, 'DECISIONS.md'), 'placeholder\n');
  for (const p of provisional) {
    writeFileSync(path.join(root, `DECISIONS/incoming/${p.id}.md`), `# ${p.id}: ${p.title}\n\nbody\n`);
  }
  return root;
}

interface Harness {
  deps: CycleDeps;
  calls: { cmd: string; args: string[] }[];
  setInFlight: (n: number) => void;
  setCi: (state: 'pass' | 'fail' | 'pending') => void;
}

function harness(
  opts: {
    inFlight?: number;
    ci?: 'pass' | 'fail' | 'pending';
    addTimes?: Record<string, number>;
    checksOutput?: string;
    /** Non-zero exit from `gh pr checks` — its normal exit whenever anything is not green. */
    checksThrows?: string;
    /** What `gh pr view --json state` reports. Defaults to OPEN, the healthy case. */
    prState?: string;
    /** Rows for `gh pr list`, i.e. an already-open numbering PR. */
    openPrs?: { number: number; headRefName: string }[];
  } = {},
): Harness {
  const calls: { cmd: string; args: string[] }[] = [];
  let inFlight = opts.inFlight ?? 0;
  let ci = opts.ci ?? 'pass';
  let clock = 1_000_000;

  const deps: CycleDeps = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'log') {
        const file = args[args.length - 1];
        const t = opts.addTimes?.[path.basename(file, '.md')];
        return { stdout: t === undefined ? '' : String(t) };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://github.com/scolacur/personal-dashboard/pull/412\n' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
        // `gh pr checks` exits non-zero whenever anything is failing, pending or absent, so the
        // throwing path is the normal one and has to be exercisable.
        if (opts?.checksThrows !== undefined) throw new Error(opts.checksThrows);
        if (opts?.checksOutput !== undefined) return { stdout: opts.checksOutput };
        return { stdout: `verify\t${ci}\t2m\turl\n` };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { stdout: `${opts?.prState ?? 'OPEN'}\n` };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify(opts?.openPrs ?? []) };
      }
      return { stdout: '' };
    },
    inFlightRuns: () => inFlight,
    sleep: async (ms) => {
      clock += ms; // virtual time: the drain/CI deadlines advance without a real wait
    },
    now: () => clock,
  };
  return {
    deps,
    calls,
    setInFlight: (n) => {
      inFlight = n;
    },
    setCi: (s) => {
      ci = s;
    },
  };
}

describe('inMergeOrder', () => {
  function prov(id: string): ProvisionalDecision {
    return { id, ticketPrefix: 'EG', ticketNum: 1, letter: 'a', title: 't', file: `DECISIONS/incoming/${id}.md` };
  }

  it('orders by the commit that ADDED each file, not by filename', () => {
    // PD-600 was authored first, so it must take the lower number even though 383 sorts first.
    const h = harness({ addTimes: { 'D-TMP-EG600a': 100, 'D-TMP-EG383a': 200 } });
    return inMergeOrder([prov('D-TMP-EG383a'), prov('D-TMP-EG600a')], h.deps, '/x').then((out) => {
      expect(out.map((d) => d.id)).toEqual(['D-TMP-EG600a', 'D-TMP-EG383a']);
    });
  });

  it('sorts an undatable file last — it is almost always one added just now', async () => {
    const h = harness({ addTimes: { 'D-TMP-EG383a': 200 } });
    const out = await inMergeOrder([prov('D-TMP-EG999a'), prov('D-TMP-EG383a')], h.deps, '/x');
    expect(out.map((d) => d.id)).toEqual(['D-TMP-EG383a', 'D-TMP-EG999a']);
  });

  it('breaks a tie on id, so two decisions in one commit get a stable order', async () => {
    const h = harness({ addTimes: { 'D-TMP-EG5b': 100, 'D-TMP-EG5a': 100 } });
    const out = await inMergeOrder([prov('D-TMP-EG5b'), prov('D-TMP-EG5a')], h.deps, '/x');
    expect(out.map((d) => d.id)).toEqual(['D-TMP-EG5a', 'D-TMP-EG5b']);
  });
});

describe('runNumberingCycle', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const config = (repoRoot: string, over: Partial<CycleConfig> = {}): CycleConfig => ({
    ...CONFIG_BASE,
    repoRoot,
    ...over,
  });

  it('does nothing at all when the inbox is empty', async () => {
    const root = makeRepo([]);
    const h = harness();
    expect(await runNumberingCycle(db, config(root), h.deps)).toEqual({ status: 'nothing-to-do' });
    expect(h.calls).toEqual([]);
  });

  it('numbers, moves, rewrites, opens a PR and admin-merges on green', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'Epic dispatch' }]);
    const h = harness({ ci: 'pass' });
    const outcome = await runNumberingCycle(db, config(root), h.deps);

    expect(outcome.status).toBe('merged');
    expect(existsSync(path.join(root, 'DECISIONS/D-080-epic-dispatch.md'))).toBe(true);
    expect(existsSync(path.join(root, 'DECISIONS/incoming/D-TMP-EG383a.md'))).toBe(false);

    const merge = h.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'merge');
    expect(merge?.args).toContain('--admin');
    expect(merge?.args).toContain('412');
  });

  it('regenerates the index so the numbered decision is listed and the inbox section is gone', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'Epic dispatch' }]);
    await runNumberingCycle(db, config(root), harness().deps);
    const index = readFileSync(path.join(root, 'DECISIONS.md'), 'utf8');
    expect(index).toContain('- **[D-080](DECISIONS/D-080-epic-dispatch.md)** — Epic dispatch');
    expect(index).not.toContain('Awaiting a number');
  });

  it('refuses to rewrite when a run is somehow live inside the hold', async () => {
    // The coordinator drains before opening the window, so this should never fire. It is the
    // belt-and-braces guard: rewriting under a live Robot puts the conflict on THAT Robot's PR.
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ inFlight: 2 });
    const outcome = await runNumberingCycle(db, config(root), h.deps);

    expect(outcome).toEqual({ status: 'runs-in-flight', inFlight: 2 });
    // Nothing was touched: the decision is still in the inbox and no PR was opened.
    expect(existsSync(path.join(root, 'DECISIONS/incoming/D-TMP-EG383a.md'))).toBe(true);
    expect(h.calls.some((c) => c.cmd === 'gh')).toBe(false);
    const n = db.prepare('SELECT title FROM agent_notifications').get() as { title: string };
    expect(n.title).toContain('in flight inside the hold');
  });

  it('leaves the PR open and notifies on a red verify — never merges red', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ ci: 'fail' });
    const outcome = await runNumberingCycle(db, config(root), h.deps);

    expect(outcome).toMatchObject({ status: 'ci-red', prNumber: 412 });
    expect(h.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge')).toBe(false);
    const n = db.prepare('SELECT title FROM agent_notifications').get() as { title: string };
    expect(n.title).toContain('is red');
  });

  it('gives up on CI that never finishes, leaving the PR open', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ ci: 'pending' });
    const outcome = await runNumberingCycle(db, config(root, { ciTimeoutMs: 5_000 }), h.deps);

    expect(outcome).toMatchObject({ status: 'ci-timeout', prNumber: 412 });
    expect(h.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge')).toBe(false);
  });

  it('propagates a failure rather than swallowing it — the caller owns the hold', async () => {
    // Releasing the hold moved to the coordinator, which does it in a finally. This job's job is to
    // fail loudly so the run row records an error.
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    const boom: CycleDeps = {
      ...h.deps,
      run: async (cmd, args) => {
        // args.includes, not args[0]: push is prefixed with the `-c` auth/proxy overrides.
        if (cmd === 'git' && args.includes('push')) throw new Error('network down');
        return h.deps.run(cmd, args);
      },
    };
    await expect(runNumberingCycle(db, config(root), boom)).rejects.toThrow('network down');
  });

  it('numbers several decisions in merge order, in one PR', async () => {
    const root = makeRepo([
      { id: 'D-TMP-EG383a', title: 'Second' },
      { id: 'D-TMP-EG600a', title: 'First' },
    ]);
    const h = harness({ addTimes: { 'D-TMP-EG600a': 100, 'D-TMP-EG383a': 200 } });
    const outcome = await runNumberingCycle(db, config(root), h.deps);

    expect(outcome.status).toBe('merged');
    expect(existsSync(path.join(root, 'DECISIONS/D-080-first.md'))).toBe(true);
    expect(existsSync(path.join(root, 'DECISIONS/D-081-second.md'))).toBe(true);
    expect(h.calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'create')).toHaveLength(1);
  });

  it('reports a dangling citation without blocking the cycle', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    // Not an `EG` id: reserved example ids are excluded from the report by design (PD-548).
    const typo = `D-TMP-${'PD'}777q`;
    writeFileSync(path.join(root, 'PROJECT.md'), `cites ${typo}\n`);
    const outcome = await runNumberingCycle(db, config(root), harness().deps);

    expect(outcome.status).toBe('merged'); // advisory, not a gate
    expect(readFileSync(path.join(root, 'PROJECT.md'), 'utf8')).toContain(typo);
    const titles = (db.prepare('SELECT title FROM agent_notifications').all() as { title: string }[]).map((r) => r.title);
    expect(titles.some((t) => t.includes('no decision behind them'))).toBe(true);
  });
});

describe('the shared checkout', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const config = (repoRoot: string, over: Partial<CycleConfig> = {}): CycleConfig => ({
    ...CONFIG_BASE,
    repoRoot,
    ...over,
  });

  it('commits with an explicit identity — the container has none of its own', async () => {
    // The first live run (2026-08-22) failed exactly here: `git commit` with no user.email, AFTER
    // the renames had been applied. Identity is passed per-command so the shared checkout's own
    // config is never written to.
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    await runNumberingCycle(db, config(root), h.deps);

    const commit = h.calls.find((c) => c.cmd === 'git' && c.args.includes('commit'));
    expect(commit?.args.slice(0, 4)).toEqual([
      '-c',
      'user.name=sortie-bot-55',
      '-c',
      'user.email=bot@example.invalid',
    ]);
    // Never `git config` — that would leave a trace in infrastructure this job only borrows.
    expect(h.calls.some((c) => c.cmd === 'git' && c.args[0] === 'config')).toBe(false);
  });

  it('restores the checkout after a successful cycle', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    await runNumberingCycle(db, config(root), h.deps);
    const tail = h.calls.filter((c) => c.cmd === 'git').map((c) => c.args.join(' '));
    expect(tail.some((a) => a.startsWith('reset --hard'))).toBe(true);
    expect(tail.some((a) => a.startsWith('clean -fd'))).toBe(true);
    expect(tail.some((a) => a === 'checkout main')).toBe(true);
  });

  it('restores the checkout when the cycle fails part-way through', async () => {
    // The real damage from the live failure was not the failed commit — it was 36 staged changes
    // left on a `numbering/` branch, which poisons `pullLatest` and every later job that grounds
    // against this checkout (the PD-340 failure mode).
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    const boom: CycleDeps = {
      ...h.deps,
      run: async (cmd, args) => {
        if (cmd === 'git' && args.includes('commit')) throw new Error('Author identity unknown');
        return h.deps.run(cmd, args);
      },
    };

    await expect(runNumberingCycle(db, config(root), boom)).rejects.toThrow('Author identity unknown');

    const gitCalls = h.calls.filter((c) => c.cmd === 'git').map((c) => c.args.join(' '));
    expect(gitCalls.some((a) => a.startsWith('reset --hard'))).toBe(true);
    expect(gitCalls.some((a) => a.startsWith('clean -fd'))).toBe(true);
    expect(gitCalls.some((a) => a === 'checkout main')).toBe(true);
    expect(gitCalls.some((a) => a.startsWith('branch -D numbering/'))).toBe(true);
  });

  it('does not try to delete a branch it never created', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    const boom: CycleDeps = {
      ...h.deps,
      run: async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'checkout') throw new Error('cannot branch');
        return h.deps.run(cmd, args);
      },
    };
    await expect(runNumberingCycle(db, config(root), boom)).rejects.toThrow('cannot branch');
    expect(h.calls.some((c) => c.cmd === 'git' && c.args[0] === 'branch')).toBe(false);
  });

  it('a restore step that itself fails does not mask the real error', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    const boom: CycleDeps = {
      ...h.deps,
      run: async (cmd, args) => {
        if (cmd === 'git' && args.includes('commit')) throw new Error('the real failure');
        if (cmd === 'git' && args[0] === 'clean') throw new Error('restore also broke');
        return h.deps.run(cmd, args);
      },
    };
    await expect(runNumberingCycle(db, config(root), boom)).rejects.toThrow('the real failure');
  });

  it('returns to a configured non-default base branch', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    await runNumberingCycle(db, config(root, { baseBranch: 'trunk' }), h.deps);
    expect(h.calls.some((c) => c.cmd === 'git' && c.args.join(' ') === 'checkout trunk')).toBe(true);
  });
});

describe('pushing', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('attaches the auth/proxy overrides to the push, and only to the push', async () => {
    // The first live push failed with "could not read Username for 'https://github.com'": GH_TOKEN
    // in the environment does not authenticate plain `git push`. Auth has to travel as a git -c
    // override, the same way the grounding checkout does it.
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness();
    await runNumberingCycle(db, { ...CONFIG_BASE, repoRoot: root }, h.deps);

    const push = h.calls.find((c) => c.cmd === 'git' && c.args.includes('push'));
    expect(push?.args.slice(0, 2)).toEqual(['-c', 'http.extraHeader=Authorization: Basic SECRET']);

    // Local-only commands stay clean — no reason to hand them credentials.
    const commit = h.calls.find((c) => c.cmd === 'git' && c.args.includes('commit'));
    expect(commit?.args.join(' ')).not.toContain('extraHeader');
  });
});

describe('the merge gate', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const run = async (checksOutput: string) => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ checksOutput });
    const outcome = await runNumberingCycle(db, { ...CONFIG_BASE, repoRoot: root, ciTimeoutMs: 5_000 }, h.deps);
    return { outcome, merged: h.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'merge') };
  };

  it('merges on a green verify even when path-guard is red', async () => {
    // The third live run hit exactly this: rewriting a D-TMP- citation inside a file matching the
    // schema.ts glob turns path-guard red, every time, because the bot is not AUTHORS_EXEMPT.
    // D-078 decided in advance that --admin covers a mechanical rename. Gating on all checks would
    // mean the cycle can never merge anything.
    const { outcome, merged } = await run('verify\tpass\t2m\turl\npath-guard\tfail\t8s\turl\n');
    expect(outcome.status).toBe('merged');
    expect(merged).toBe(true);
  });

  it('never merges on a red verify, whatever else is green', async () => {
    const { outcome, merged } = await run('verify\tfail\t2m\turl\npath-guard\tpass\t8s\turl\n');
    expect(outcome).toMatchObject({ status: 'ci-red' });
    expect(merged).toBe(false);
  });

  it('treats "no checks reported" as too-early, not as failure', async () => {
    // Straight after `gh pr create` GitHub has registered nothing. Reading that as a failure is what
    // killed the third live run — it errored one second after opening a perfectly good PR.
    const { outcome, merged } = await run('no checks reported on the numbering/2026-08-22-d-080 branch\n');
    expect(outcome).toMatchObject({ status: 'ci-timeout' });
    expect(merged).toBe(false);
  });

  it('waits when the gate check has not appeared yet, even if others have', async () => {
    const { outcome } = await run('path-guard\tpass\t8s\turl\n');
    expect(outcome).toMatchObject({ status: 'ci-timeout' });
  });

  it('waits while verify is still queued or in progress', async () => {
    const { outcome } = await run('verify\tpending\t0\turl\n');
    expect(outcome).toMatchObject({ status: 'ci-timeout' });
  });
});

// The live failures of 2026-08-23/25. All three are the same shape: the cycle treating a routine
// GitHub condition as an exception, or as a condition it could not see at all.
describe('surviving GitHub (PD-498)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const config = (repoRoot: string, over: Partial<CycleConfig> = {}): CycleConfig => ({
    ...CONFIG_BASE,
    repoRoot,
    ...over,
  });

  // `gh pr checks` exits NON-ZERO whenever anything is failing, pending, or absent — so the throw is
  // the normal case. The "no checks reported" text goes to stderr with stdout empty, which is the
  // one path the runner rethrows on, so the check for it could never run. Steve saw the raw
  // "Command failed: gh pr checks 361 … no checks reported" surface as a job error.
  it('reads "no checks reported" out of a non-zero exit, not just out of stdout', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({
      checksThrows: "Command failed: gh pr checks 361\nno checks reported on the 'numbering/x' branch",
    });
    const outcome = await runNumberingCycle(db, config(root), h.deps);
    // Pending until the deadline — never merged, and never a thrown job.
    expect(outcome.status).toBe('ci-timeout');
  });

  it('does not merge on an unreadable checks failure', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ checksThrows: 'something else entirely' });
    const outcome = await runNumberingCycle(db, config(root), h.deps);
    expect(outcome.status).not.toBe('merged');
    expect(h.calls.some((c) => c.args.includes('--admin'))).toBe(false);
  });

  // A PR closed while the cycle polls reports NO checks, which is indistinguishable from "opened a
  // second ago". Without the state probe the cycle reads that as pending and spins for the whole
  // two-hour timeout, then reports that checks never finished — which is not what happened.
  it('stops when the PR is closed out from under it, instead of waiting out the deadline', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ ci: 'pending', prState: 'CLOSED' });
    const outcome = await runNumberingCycle(db, config(root), h.deps);
    expect(outcome.status).toBe('ci-red');
    const titles = (db.prepare('SELECT title FROM agent_notifications').all() as { title: string }[]).map((r) => r.title);
    expect(titles.some((t) => t.includes('no longer open'))).toBe(true);
  });

  it('keeps waiting while the PR is still open', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const outcome = await runNumberingCycle(db, config(root), harness({ ci: 'pending', prState: 'OPEN' }).deps);
    expect(outcome.status).toBe('ci-timeout');
  });

  it('assumes still-open when the state cannot be read — an API blip must not abandon a healthy PR', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const outcome = await runNumberingCycle(db, config(root), harness({ ci: 'pending', prState: '' }).deps);
    expect(outcome.status).toBe('ci-timeout');
  });

  // The branch is date-stamped, so a cycle that fails CI leaves its PR open and the NEXT day's run
  // opens a second one with the same title and the same red verify. Three piled up.
  it('does not open a second numbering PR while one is already open', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ openPrs: [{ number: 362, headRefName: 'numbering/2026-08-24-d-080' }] });
    const outcome = await runNumberingCycle(db, config(root), h.deps);

    // Narrowed by status first: `prNumber` lives on some CycleOutcome variants, not all.
    expect(outcome).toMatchObject({ status: 'ci-red', prNumber: 362 });
    expect(h.calls.some((c) => c.cmd === 'gh' && c.args[1] === 'create')).toBe(false);
    // And it must not have pushed a branch either — the whole attempt stops before any write.
    expect(h.calls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('ignores an unrelated open PR — the guard keys on the branch, not the author', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    const h = harness({ openPrs: [{ number: 400, headRefName: 'robot/512' }] });
    const outcome = await runNumberingCycle(db, config(root), h.deps);
    expect(outcome.status).toBe('merged');
  });

  it('proceeds when nothing is open', async () => {
    const root = makeRepo([{ id: 'D-TMP-EG383a', title: 'x' }]);
    expect((await runNumberingCycle(db, config(root), harness({ openPrs: [] }).deps)).status).toBe('merged');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { appendTail, codingEnv, extractMessageText, readHandoff, runRobotSession, type RunQuery } from './session';
import { OUTPUT_TAIL_MAX } from './runs';
import { VERIFY_OK_MARKER, SCM_JSON, ASK_HUMAN_MARKER } from './prompt';
import type { RobotCandidate } from './select';
import type { Worktree } from './workspace';

const candidate: RobotCandidate = {
  id: 429,
  issueNumber: 220,
  repo: 'scolacur/personal-dashboard',
  title: 'T',
  body: 'b',
  priority: 'P2',
};

describe('codingEnv', () => {
  it('injects the WRITE token as GH_TOKEN and strips the read token', () => {
    const c = loadConfig({ ROBOT_GITHUB_TOKEN: 'ghp_write', GITHUB_READ_TOKEN: 'ghp_read' });
    const env = codingEnv(c);
    expect(env.GH_TOKEN).toBe('ghp_write');
    expect(env.GITHUB_TOKEN).toBe('ghp_write');
    expect(env.GITHUB_READ_TOKEN).toBeUndefined();
  });

  it('repoints HOME/USER at the coding home only when a uid is dropped', () => {
    // dev (no uid): inherit the loop's HOME — no override.
    const dev = codingEnv(loadConfig({}));
    expect(dev.HOME).toBe(process.env.HOME);
    expect(dev.USER).toBe(process.env.USER);
    // uid dropped: HOME/USER point at the robot home the image created.
    const dropped = codingEnv(loadConfig({ ROBOT_CODING_UID: '1500', ROBOT_CODING_HOME: '/home/robot' }));
    expect(dropped.HOME).toBe('/home/robot');
    expect(dropped.USER).toBe('robot');
    expect(dropped.LOGNAME).toBe('robot');
  });

  it('sets proxy vars only when a proxy is configured', () => {
    expect(codingEnv(loadConfig({})).HTTPS_PROXY).toBeUndefined();
    const env = codingEnv(loadConfig({ HTTPS_PROXY: 'http://egress-proxy:3128' }));
    expect(env.HTTPS_PROXY).toBe('http://egress-proxy:3128');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });
});

describe('readHandoff', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-ho-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports no hand-off on a bare tree', () => {
    expect(readHandoff(dir)).toEqual({ verifyOk: false, prNumber: undefined });
  });

  it('reads the verify-ok marker and PR number from scm.json', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, VERIFY_OK_MARKER), '');
    writeFileSync(path.join(dir, SCM_JSON), JSON.stringify({ pr_number: 314, branch: 'robot/220' }));
    expect(readHandoff(dir)).toEqual({ verifyOk: true, prNumber: 314 });
  });

  it('tolerates a malformed scm.json', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, SCM_JSON), 'not json');
    expect(readHandoff(dir)).toEqual({ verifyOk: false, prNumber: undefined });
  });

  it('reads the ask-human question when the Robot parked for a human (C2)', () => {
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, ASK_HUMAN_MARKER), 'Should this use the new or old API?\n');
    expect(readHandoff(dir).askHuman).toBe('Should this use the new or old API?');
  });
});

describe('runRobotSession', () => {
  let dir: string;
  let config: AgentWorkerConfig;
  let worktree: Worktree;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-sess-'));
    config = loadConfig({});
    worktree = { dir, branch: 'robot/220' };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a clean run + hand-off when the session succeeds and leaves the markers', async () => {
    const fake: RunQuery = (async function* () {
      // simulate the Robot completing its Finish steps
      mkdirSync(path.join(dir, '.robot'), { recursive: true });
      writeFileSync(path.join(dir, VERIFY_OK_MARKER), '');
      writeFileSync(path.join(dir, SCM_JSON), JSON.stringify({ pr_number: 99 }));
      yield { type: 'system', subtype: 'init', session_id: 'sess-abc' } as never;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-abc',
        num_turns: 6,
        usage: { input_tokens: 1000, output_tokens: 234 },
      } as never;
    }) as unknown as RunQuery;

    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    // C3 metrics: turns + total tokens captured off the result message.
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-abc', verifyOk: true, prNumber: 99, turns: 6, tokens: 1234 });
  });

  it('reports !ok with the error text on an API error, and no hand-off', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'result', subtype: 'error_max_turns', session_id: 's', errors: ['max turns'] } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('max turns');
    expect(res.verifyOk).toBe(false);
  });

  // PD-230: live turn progress. Assistant messages are counted as they stream so the board can
  // show a working run closing on the cap; finishRun later overwrites with the SDK's num_turns.
  it('reports live turn progress as assistant messages stream', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' } as never;
      yield { type: 'assistant', parent_tool_use_id: null } as never;
      yield { type: 'user' } as never; // not a turn
      // Emitted inside a tool-use/sub-agent context — NOT a turn of the main loop.
      yield { type: 'assistant', parent_tool_use_id: 'toolu_123' } as never;
      yield { type: 'assistant', parent_tool_use_id: null } as never;
      yield { type: 'assistant', parent_tool_use_id: null } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', num_turns: 3 } as never;
    }) as unknown as RunQuery;

    const seen: number[] = [];
    const res = await runRobotSession(config, candidate, worktree, undefined, fake, (t) => seen.push(t));

    expect(seen).toEqual([1, 2, 3]); // monotonic; nested sub-agent turns excluded
    expect(res.turns).toBe(3); // the SDK's authoritative count still wins on the result
  });

  it('never lets a failing progress callback kill the session', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', num_turns: 1 } as never;
    }) as unknown as RunQuery;

    const res = await runRobotSession(config, candidate, worktree, undefined, fake, () => {
      throw new Error('db locked');
    });
    expect(res.ok).toBe(true);
  });

  it('runs fine with no progress callback at all', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', num_turns: 1 } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.ok).toBe(true);
  });

  it('catches a thrown session and surfaces it as an error result', async () => {
    const fake: RunQuery = (() => {
      throw new Error('spawn EACCES');
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('EACCES');
  });
});

// ── PD-426: output-tail capture ──────────────────────────────────────────────
// A `no-verify` run was undiagnosable — the worktree is removed in the loop's `finally` and the
// stream was consumed only for session_id/num_turns/usage. These cover the capture that fixes it.

describe('appendTail', () => {
  it('joins chunks with newlines and leaves a short buffer untouched', () => {
    expect(appendTail('', 'a')).toBe('a');
    expect(appendTail('a', 'b')).toBe('a\nb');
  });

  it('ignores empty chunks', () => {
    expect(appendTail('a', '')).toBe('a');
  });

  it('keeps the TAIL and truncates the FRONT once past the cap', () => {
    // The end of a failed run is the interesting part (what verify said), so the front goes.
    const out = appendTail('x'.repeat(50), 'END', 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('END')).toBe(true);
    expect(out.startsWith('…[truncated]')).toBe(true);
  });

  it('stays pinned at the cap across repeated truncation, not growing a marker each time', () => {
    let buf = '';
    for (let i = 0; i < 25; i++) buf = appendTail(buf, `line-${i}-${'y'.repeat(40)}`, 200);
    expect(buf.length).toBe(200);
    expect(buf).toContain('line-24');
    expect(buf).not.toContain('line-0-');
  });

  it('handles a single chunk larger than the whole cap', () => {
    const out = appendTail('', 'z'.repeat(500), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith('z')).toBe(true);
  });
});

describe('extractMessageText', () => {
  it('pulls assistant text blocks', () => {
    const t = extractMessageText({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(t).toBe('[assistant] hello');
  });

  it('pulls tool_result content — where the `npm run verify` output lives', () => {
    const t = extractMessageText({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'FAIL src/x.spec.ts' }] }] },
    });
    expect(t).toBe('[tool] FAIL src/x.spec.ts');
  });

  it('accepts a string tool_result and a string message content', () => {
    expect(extractMessageText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'raw' }] } })).toBe('[tool] raw');
    expect(extractMessageText({ type: 'assistant', message: { content: 'plain' } })).toBe('[assistant] plain');
  });

  it('skips unrecognised shapes instead of throwing — the SDK block shape is not guaranteed', () => {
    expect(extractMessageText({})).toBe('');
    expect(extractMessageText({ type: 'assistant' })).toBe('');
    expect(extractMessageText({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } })).toBe('');
    expect(extractMessageText(null)).toBe('');
  });
});

describe('runRobotSession output tail', () => {
  let dir: string;
  let config: AgentWorkerConfig;
  let worktree: Worktree;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-tail-'));
    config = loadConfig({});
    worktree = { dir, branch: 'robot/220' };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('captures assistant text and tool output from a no-verify run', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' } as never;
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'running verify' }] } } as never;
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Tests 3 failed' }] }] },
      } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's', num_turns: 2 } as never;
    }) as unknown as RunQuery;

    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.verifyOk).toBe(false); // no marker written — the no-verify case
    expect(res.outputTail).toContain('running verify');
    expect(res.outputTail).toContain('Tests 3 failed');
  });

  it('captures sub-agent output too — unlike the turn counter, which excludes it', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'inner detail' }] } } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.outputTail).toContain('inner detail');
  });

  it('leaves outputTail undefined when the session produced no text, so the column stays null', async () => {
    const fake: RunQuery = (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.outputTail).toBeUndefined();
  });

  it('caps the captured tail at OUTPUT_TAIL_MAX', async () => {
    const fake: RunQuery = (async function* () {
      for (let i = 0; i < 40; i++) {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'q'.repeat(500) }] } } as never;
      }
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'THE-LAST-LINE' }] } } as never;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' } as never;
    }) as unknown as RunQuery;
    const res = await runRobotSession(config, candidate, worktree, undefined, fake);
    expect(res.outputTail!.length).toBeLessThanOrEqual(OUTPUT_TAIL_MAX);
    expect(res.outputTail).toContain('THE-LAST-LINE'); // the tail survives, not the head
  });
});

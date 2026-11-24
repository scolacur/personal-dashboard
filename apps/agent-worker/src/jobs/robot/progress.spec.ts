import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../shared/config';
import {
  buildJudgePrompt,
  checkTripwires,
  JUDGE_INPUT_MAX_CHARS,
  latestPlan,
  normalizeError,
  outcomeFrom,
  parseJudgeReply,
  runProgressJudge,
  transcriptEntries,
  verifyFailureSignature,
  type JudgeQuery,
  type TranscriptEntry,
  type TripwireInput,
} from './progress';

/** PD-964 (D-114): the progress check's pure parts — every tripwire, and every judge outcome. */

const call = (turn: number, name: string, input: string, id?: string): TranscriptEntry => ({ kind: 'tool_use', turn, name, input, ...(id ? { id } : {}) });
const result = (turn: number, text: string, isError: boolean, toolUseId?: string): TranscriptEntry => ({
  kind: 'tool_result',
  turn,
  text,
  isError,
  ...(toolUseId ? { toolUseId } : {}),
});
const said = (turn: number, text: string): TranscriptEntry => ({ kind: 'text', turn, text });

function wires(over: Partial<TripwireInput>): TripwireInput {
  return { transcript: [], repeatLimit: 4, treeBefore: 'a', treeAfter: 'b', verifyFailure: null, previousVerifyFailure: null, ...over };
}

describe('checkTripwires', () => {
  it('fires nothing on a healthy window', () => {
    const t = [call(1, 'Read', '{"file":"a.ts"}'), result(1, 'ok', false), call(2, 'Edit', '{"file":"a.ts"}'), said(3, 'done')];
    expect(checkTripwires(wires({ transcript: t }))).toBeNull();
  });

  it('repeated_tool_call: the same tool with the same input K times', () => {
    const t = Array.from({ length: 4 }, (_, i) => call(i, 'Grep', '{"pattern":"foo"}'));
    expect(checkTripwires(wires({ transcript: t }))).toMatchObject({ tripwire: 'repeated_tool_call' });
    expect(checkTripwires(wires({ transcript: t.slice(0, 3) }))).toBeNull(); // K−1 is fine
  });

  it('repeated_tool_call: re-running verify that answers differently each time is not a loop', () => {
    const t = [1, 2, 3, 4, 5].flatMap((n) => [
      call(n, 'Bash', '{"command":"npm run verify"}', `v${n}`),
      result(n, `lint: ${'abcde'[n - 1]}-rule failed in file-${'abcde'[n - 1]}`, true, `v${n}`),
    ]);
    expect(checkTripwires(wires({ transcript: t }))).toBeNull();
    const same = [1, 2, 3, 4].flatMap((n) => [call(n, 'Bash', '{"command":"npm run verify"}', `s${n}`), result(n, 'lint: no-unused-vars', true, `s${n}`)]);
    // …the same call with the same answer is (the error repeats too, but the call wire fires first).
    expect(checkTripwires(wires({ transcript: same }))).toMatchObject({ tripwire: 'repeated_tool_call' });
  });

  it('repeated_tool_call ignores a different input and the exempt tools', () => {
    const t = [
      ...Array.from({ length: 4 }, (_, i) => call(i, 'Grep', `{"pattern":"foo${i}"}`)),
      ...Array.from({ length: 6 }, (_, i) => call(i, 'BashOutput', '{"id":"b1"}')),
      ...Array.from({ length: 6 }, (_, i) => call(i, 'TodoWrite', '{"todos":[]}')),
    ];
    expect(checkTripwires(wires({ transcript: t }))).toBeNull();
  });

  it('repeated_error: the same error K times, modulo line numbers and ids', () => {
    const t = [1, 2, 3, 4].map((n) => result(n, `TS2345: Argument at src/x.ts:${n * 10}:${n} is not assignable`, true));
    expect(checkTripwires(wires({ transcript: t }))).toMatchObject({ tripwire: 'repeated_error' });
  });

  it('repeated_error counts only errors — the same successful output is not a loop', () => {
    const t = [1, 2, 3, 4].map((n) => result(n, 'All tests passed', false));
    expect(checkTripwires(wires({ transcript: t }))).toBeNull();
  });

  it('no_diff_change: the tree is identical at both ends of the window', () => {
    expect(checkTripwires(wires({ treeBefore: 't1', treeAfter: 't1' }))).toMatchObject({ tripwire: 'no_diff_change' });
  });

  it('no_diff_change is skipped when a snapshot could not be taken', () => {
    expect(checkTripwires(wires({ treeBefore: null, treeAfter: null }))).toBeNull();
    expect(checkTripwires(wires({ treeBefore: 't1', treeAfter: null }))).toBeNull();
  });

  it('verify_same_failure: verify failing the same way in consecutive windows', () => {
    expect(checkTripwires(wires({ verifyFailure: 'lint: no-unused-vars', previousVerifyFailure: 'lint: no-unused-vars' }))).toMatchObject({
      tripwire: 'verify_same_failure',
    });
    expect(checkTripwires(wires({ verifyFailure: 'lint: x', previousVerifyFailure: 'typecheck: y' }))).toBeNull();
    expect(checkTripwires(wires({ verifyFailure: null, previousVerifyFailure: null }))).toBeNull();
  });
});

describe('verifyFailureSignature', () => {
  it('reads the LAST verify in the window', () => {
    const t = [
      call(1, 'Bash', '{"command":"npm run verify"}', 'v1'),
      result(1, 'FAIL lint', true, 'v1'),
      call(5, 'Bash', '{"command":"npm ci && npm run verify 2>&1 | tail"}', 'v2'),
      result(5, 'Tests  3 failed | 900 passed', true, 'v2'),
    ];
    expect(verifyFailureSignature(t)).toBe(normalizeError('Tests  3 failed | 900 passed'));
  });

  it('is null when the last verify passed, or verify did not run', () => {
    expect(verifyFailureSignature([call(1, 'Bash', '{"command":"npm run verify"}', 'v'), result(1, 'ok', false, 'v')])).toBeNull();
    expect(verifyFailureSignature([call(1, 'Bash', '{"command":"npm test"}', 'v'), result(1, 'boom', true, 'v')])).toBeNull();
  });
});

describe('parseJudgeReply', () => {
  it.each(['progressing', 'stalled', 'drifted', 'hallucinating'])('accepts %s', (v) => {
    expect(parseJudgeReply(`{"verdict":"${v}","reason":"because"}`)).toEqual({ verdict: v, reason: 'because' });
  });

  it('finds the object inside surrounding prose or a code fence', () => {
    expect(parseJudgeReply('Here you go:\n```json\n{"verdict":"stalled","reason":"loops"}\n```')).toEqual({ verdict: 'stalled', reason: 'loops' });
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'it is progressing'],
    ['broken JSON', '{"verdict": "progressing",'],
    ['unknown verdict', '{"verdict":"fine","reason":"x"}'],
    ['the loop-only error label', '{"verdict":"error","reason":"x"}'],
    ['missing verdict', '{"reason":"x"}'],
  ])('a malformed answer (%s) is an error verdict, which parks', (_label, text) => {
    const v = parseJudgeReply(text);
    expect(v.verdict).toBe('error');
    expect(outcomeFrom(null, { ...v, turns: 1, tokens: 1 }).proceed).toBe(false);
  });
});

describe('outcomeFrom', () => {
  it('only a progressing judge continues', () => {
    expect(outcomeFrom(null, { verdict: 'progressing', reason: 'r', turns: 1, tokens: 2 })).toMatchObject({ proceed: true, checkedBy: 'judge', judgeTurns: 1 });
    expect(outcomeFrom(null, { verdict: 'stalled', reason: 'r', turns: 1, tokens: 2 }).proceed).toBe(false);
  });

  it('a tripwire wins and costs no judge turns', () => {
    expect(outcomeFrom({ tripwire: 'no_diff_change', detail: 'd' }, null)).toMatchObject({
      proceed: false,
      checkedBy: 'tripwire',
      tripwire: 'no_diff_change',
      judgeTurns: 0,
    });
  });

  it('no judge result at all parks', () => {
    expect(outcomeFrom(null, null)).toMatchObject({ proceed: false, verdict: 'error' });
  });
});

describe('runProgressJudge — judge error → park', () => {
  const config = loadConfig({});
  const input = { title: 't', body: 'b', plan: null, diff: null, transcript: [], window: 1, turnsSoFar: 25 };
  const fromMessages = (messages: unknown[]): JudgeQuery =>
    (() =>
      (async function* () {
        for (const m of messages) yield m;
      })()) as unknown as JudgeQuery;

  it('returns the verdict and the call usage', async () => {
    const r = await runProgressJudge(
      config,
      input,
      fromMessages([{ type: 'result', subtype: 'success', result: '{"verdict":"progressing","reason":"ok"}', num_turns: 1, usage: { input_tokens: 900, output_tokens: 30 } }]),
    );
    expect(r).toEqual({ verdict: 'progressing', reason: 'ok', turns: 1, tokens: 930 });
  });

  it('a thrown call is an error verdict', async () => {
    const throwing = (() => {
      throw new Error('503 overloaded');
    }) as unknown as JudgeQuery;
    const r = await runProgressJudge(config, input, throwing);
    expect(r.verdict).toBe('error');
    expect(r.reason).toContain('503 overloaded');
  });

  it('a failed result is an error verdict', async () => {
    const r = await runProgressJudge(config, input, fromMessages([{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }]));
    expect(r.verdict).toBe('error');
  });

  it('runs with no tools, one turn', async () => {
    let options: Record<string, unknown> = {};
    const spy = ((args: { options: Record<string, unknown> }) => {
      options = args.options;
      return (async function* () {
        yield { type: 'result', subtype: 'success', result: '{"verdict":"stalled","reason":"x"}' };
      })();
    }) as unknown as JudgeQuery;
    await runProgressJudge(config, input, spy);
    expect(options.tools).toEqual([]);
    expect(options.maxTurns).toBe(1);
  });
});

describe('buildJudgePrompt', () => {
  it('stays inside the budget and keeps the END of a long window', () => {
    const transcript = Array.from({ length: 2_000 }, (_, i) => said(i, `step ${i} ${'x'.repeat(200)}`));
    const p = buildJudgePrompt({ title: 'T', body: 'B', plan: null, diff: 'D', transcript, window: 3, turnsSoFar: 75 });
    expect(p.length).toBeLessThanOrEqual(JUDGE_INPUT_MAX_CHARS + 200);
    expect(p).toContain('step 1999');
    expect(p).not.toContain('step 0 ');
    expect(p).toContain('window 3, 75 turns so far');
  });
});

describe('transcriptEntries / latestPlan', () => {
  it('reads text, tool calls and tool results off SDK messages', () => {
    const assistant = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Fixing it' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm run verify' } }] },
    };
    const user = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: [{ type: 'text', text: 'FAIL' }] }] } };
    expect([...transcriptEntries(assistant, 3), ...transcriptEntries(user, 3)]).toEqual([
      { kind: 'text', turn: 3, text: 'Fixing it' },
      { kind: 'tool_use', turn: 3, id: 'u1', name: 'Bash', input: '{"command":"npm run verify"}' },
      { kind: 'tool_result', turn: 3, toolUseId: 'u1', text: 'FAIL', isError: true },
    ]);
  });

  it('ignores what it does not recognize', () => {
    expect(transcriptEntries(null, 1)).toEqual([]);
    expect(transcriptEntries({ type: 'system' }, 1)).toEqual([]);
    expect(transcriptEntries({ type: 'assistant', message: { content: [{ type: 'mystery' }] } }, 1)).toEqual([]);
  });

  it('the plan is the newest TodoWrite', () => {
    expect(latestPlan([call(1, 'TodoWrite', 'old'), call(2, 'Bash', 'x'), call(3, 'TodoWrite', 'new')])).toBe('new');
    expect(latestPlan([call(1, 'Bash', 'x')])).toBeNull();
  });
});

describe('gitTreeSnapshotter (real git)', () => {
  it('fingerprints the tree, sees untracked files, diffs windows, and writes nothing into the clone', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { gitTreeSnapshotter } = await import('./progress');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    try {
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
      writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
      git('add', 'a.ts');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a');
      writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
      const objectsBefore = readdirSync(path.join(dir, '.git', 'objects')).sort();

      const snap = gitTreeSnapshotter(dir);
      const t1 = await snap.snapshot();
      const t1again = await snap.snapshot();
      expect(t1).toMatch(/^[0-9a-f]{40}$/);
      expect(t1again).toBe(t1); // nothing changed → same fingerprint (the no-change tripwire)

      writeFileSync(path.join(dir, 'new.ts'), 'export const b = 2;\n'); // untracked
      const t2 = await snap.snapshot();
      expect(t2).not.toBe(t1);
      const diff = await snap.diff(t1!, t2!);
      expect(diff).toContain('new.ts');
      expect(diff).toContain('export const b = 2;');

      expect(readdirSync(path.join(dir, '.git', 'objects')).sort()).toEqual(objectsBefore);
      expect(git('status', '--porcelain').toString()).toContain('?? new.ts'); // the real index is untouched
      snap.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

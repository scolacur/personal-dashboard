// The Refine system prompt lives in `packages/shared/src/agent-prompts.ts` (one source, rendered
// in the Agent Glossary). Like `robot/prompt.spec.ts`, this spec reaches into shared rather than
// standing up a third test runner there. Covers D-110: `maxTurns` is estimated in BOTH directions
// with a stated scale and a floor.
import { describe, it, expect } from 'vitest';
import { refineSystemPrompt, REFINE_TURN_ESTIMATE_FLOOR, ROBOT_MAX_TURNS_DEFAULT } from '@dashboard/shared';

const prompt = () => refineSystemPrompt('CONTEXT', ROBOT_MAX_TURNS_DEFAULT, REFINE_TURN_ESTIMATE_FLOOR);

describe('refineSystemPrompt — maxTurns sizing (D-110)', () => {
  it('asks for an estimate in BOTH directions, not only up', () => {
    const s = prompt();
    expect(s).toMatch(/estimate it in BOTH directions/i);
    // the downward case — a low ceiling for small work — is explicitly called out
    expect(s).toMatch(/sizing it DOWN/);
    // and set on (almost) every ticket, not omitted on virtually every one
    expect(s).toMatch(/set `maxTurns` on \(almost\) every proposed ticket/);
  });

  it('gives a concrete scale anchored on real run cost, including the fixed per-run tax', () => {
    const s = prompt();
    expect(s).toMatch(/npm ci/);
    expect(s).toMatch(/npm run verify/);
    expect(s).toMatch(/hand-off/);
    // the rungs of the scale, and the real-run figures they are grounded in
    expect(s).toMatch(/~25 turns: a small change/);
    expect(s).toMatch(/~40 turns: a few files inside ONE subsystem/);
    expect(s).toMatch(/cheapest real runs took 12-17 turns/);
  });

  it('states the floor and never quotes a rung below it', () => {
    const s = prompt();
    expect(s).toMatch(new RegExp(`Never estimate below ${REFINE_TURN_ESTIMATE_FLOOR} turns`));
    const rungs = [...s.matchAll(/~(\d+) turns:/g)].map((m) => Number(m[1]));
    expect(rungs.length).toBeGreaterThan(0);
    for (const r of rungs) expect(r).toBeGreaterThanOrEqual(REFINE_TURN_ESTIMATE_FLOOR);
  });

  it('keeps PD-432: a RAISED ceiling still needs the "cannot decompose" argument, a lowered one does not', () => {
    const s = prompt();
    expect(s).toMatch(/estimate `maxTurns` ABOVE it \(PD-432\)/);
    expect(s).toMatch(/argue in `rationale` why\s+the work is irreducible; a lowered ceiling needs no such argument/);
  });

  it('reframes omission as "unsure", not "nothing unusual"', () => {
    const s = prompt();
    expect(s).toMatch(/Omit `maxTurns`\s+ONLY when you genuinely cannot gauge the size/);
    expect(s).toMatch(/omitting means "unsure", not "nothing unusual"/);
  });

  it('quotes the actual default ceiling it was built with', () => {
    expect(prompt()).toMatch(new RegExp(`The default ${ROBOT_MAX_TURNS_DEFAULT}`));
  });
});

describe('REFINE_TURN_ESTIMATE_FLOOR (D-110)', () => {
  it('is a sane floor: above the cheapest real runs (12-17 turns), well below the default ceiling', () => {
    expect(REFINE_TURN_ESTIMATE_FLOOR).toBeGreaterThan(17);
    expect(REFINE_TURN_ESTIMATE_FLOOR).toBeLessThan(ROBOT_MAX_TURNS_DEFAULT);
  });
});

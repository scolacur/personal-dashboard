/**
 * Regenerate `DECISIONS.md` from `DECISIONS/` (PD-490, D-070).
 *
 *   npm run decisions:index
 *
 * Lives here rather than in `scripts/` because it shares its parser with the agent-worker, which
 * injects the same index into agent context — one implementation, so the file agents read and the
 * file humans read cannot disagree. It is not part of the worker bundle (`build.mjs` bundles only
 * `src/index.ts`).
 *
 * A stale index is a test failure, not a silent drift: `decisions.spec.ts` regenerates and
 * compares. This script is how you fix that failure.
 *
 * It also writes the decision-id counter's seed floor (`DECISION_SEED_MODULE`, PD-702), so the same
 * one command covers a new decision file end to end.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DECISION_SEED_MODULE,
  DECISIONS_INDEX,
  findRepoRoot,
  loadDecisions,
  readSeedFloor,
  renderDecisionsIndex,
  renderSeedModule,
} from './shared/decisions';

const repoRoot = findRepoRoot();

const decisions = loadDecisions(repoRoot);
writeFileSync(path.join(repoRoot, DECISIONS_INDEX), renderDecisionsIndex(decisions), 'utf8');

// PD-702: the counter's seed floor, so a new decision needs no hand-bumped constant. Only ever raised.
const seedPath = path.join(repoRoot, DECISION_SEED_MODULE);
const currentFloor = readSeedFloor(existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : null);
writeFileSync(seedPath, renderSeedModule(decisions, currentFloor), 'utf8');

// No "next free id" printed here, for the reason PD-560 made structural: this script must not be a
// second allocator. The counter behind `POST /api/decisions/allocate` is the only one, and a number
// computed from the filesystem is exactly the `max + 1` that produced the D-056 and D-065
// collisions. Nothing left to report but the count.
console.log(`${DECISIONS_INDEX}: ${decisions.length} numbered decisions.`);

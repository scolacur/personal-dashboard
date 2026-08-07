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
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DECISIONS_INDEX, findRepoRoot, loadDecisions, nextDecisionId, renderDecisionsIndex } from './shared/decisions';

const repoRoot = findRepoRoot();

const decisions = loadDecisions(repoRoot);
writeFileSync(path.join(repoRoot, DECISIONS_INDEX), renderDecisionsIndex(decisions), 'utf8');

console.log(`${DECISIONS_INDEX}: ${decisions.length} decisions indexed. Next free id: ${nextDecisionId(decisions)}`);

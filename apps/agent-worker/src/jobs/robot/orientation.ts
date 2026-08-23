import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { composeOrientation, orientationBlock } from '@dashboard/shared';
import { loadProvisionalDecisions, renderProvisionalSection } from '../../shared/decisions';
import { logger } from '../../shared/logger';

/**
 * The Robot's orientation context (PD-306).
 *
 * **Injected, never fetched.** The ticket originally asked for Robots to *run* `/harness` and
 * `/wrap-up`. That was rejected on grilling: an autonomous agent asked to leash itself may simply
 * not, and a skipped orientation degrades the run silently while still burning turns. So the
 * *content* is handed to the session and no command is involved.
 *
 * What goes in, and why each is that shape:
 *
 *  - **PROJECT.md, in full.** ~620 lines. Its conventions and glossary apply to every ticket, and
 *    guessing at which half matters is how you ship an agent that contradicts a settled decision.
 *    Deliberately not pared down — the eventual token audit decides that with measurements.
 *  - **The DECISIONS index, not the decisions.** Post-[[D-070]] `DECISIONS.md` is a generated
 *    ~80-line index of id + title + link. That is short, complete, and points at the two files that
 *    actually matter for a given ticket; the bodies stay on-demand via `Read`, which the existing
 *    "read it when a choice is non-obvious" instruction already drives. Injecting all ~70 bodies
 *    would be several thousand lines with a terrible relevant-to-irrelevant ratio.
 *  - **Recent MEMORY day files** (today + yesterday), read-only. This is what a human session gets
 *    from `/harness` and it is where in-flight context lives.
 *
 * What is deliberately NOT injected:
 *
 *  - **`CLAUDE.md`.** It is written for a human-driven Claude Code session and several of its
 *    instructions are *wrong* for a Robot, not merely irrelevant: RULE 1 tells the reader to create
 *    a git worktree (a Robot is already in a dedicated one, and nesting another would be a mess);
 *    "never `git add -A`" contradicts the Finish sequence, which uses it deliberately because a
 *    Robot's worktree is exclusive to that run; and it instructs the reader to query the board API
 *    and `PATCH` tickets to completed — a Robot is DB-blind by design (D-039), and the loop owns
 *    that transition. Handing it those lines invites exactly the behaviour the architecture forbids.
 *  - **Project resolution, the memory-aging pass, and the orient block** from `/harness`. A Robot is
 *    dispatched at exactly one project, has no business `git mv`-ing memory files around, and has
 *    no human reading its status report.
 *
 * Drift between this and the human `/harness` is real and tracked separately (PD-491).
 */

/** One `MEMORY/YYYY-MM-DD.md` day file. */
export interface MemoryDay {
  /** `YYYY-MM-DD` — the file's date, which is also its identity. */
  date: string;
  contents: string;
}

/** Local-time `YYYY-MM-DD`, `offsetDays` before `now`. Local, not UTC: memory files are named for
 *  Steve's day (US Eastern), so a UTC date would silently skip a file for most of each evening. */
export function memoryDateKey(now: Date, offsetDays = 0): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's and yesterday's day files, newest first. Missing days are skipped, not faked — a day
 *  with no file is normal (no session ran), which is why this reports nothing when both are absent. */
export function readRecentMemory(repoDir: string, now: Date, days = 2): MemoryDay[] {
  const out: MemoryDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = memoryDateKey(now, i);
    const file = path.join(repoDir, 'MEMORY', `${date}.md`);
    if (!existsSync(file)) continue;
    const contents = readFileSync(file, 'utf8').trim();
    if (contents) out.push({ date, contents });
  }
  return out;
}

export interface OrientationInput {
  /** The Robot's worktree — a full checkout, so every source is read from here. */
  repoDir: string;
  now?: Date;
  /** Called for each expected source that is absent. The orientation still builds (a Robot with a
   *  smaller pack is degraded, not broken) but PD-496 is the standing lesson that it must not be
   *  silent about it. */
  onMissing?: (what: string) => void;
}

/**
 * Build the orientation block appended to the Robot's system prompt.
 *
 * Returns '' when nothing at all could be read, so the caller appends nothing rather than an
 * empty-section skeleton.
 */
export function buildOrientation({ repoDir, now = new Date(), onMissing = () => {} }: OrientationInput): string {
  const parts: string[] = [];

  const projectMd = path.join(repoDir, 'PROJECT.md');
  if (existsSync(projectMd)) {
    parts.push(orientationBlock('PROJECT.md', readFileSync(projectMd, 'utf8').trim()));
  } else {
    onMissing('PROJECT.md');
  }

  const decisionsIndex = path.join(repoDir, 'DECISIONS.md');
  if (existsSync(decisionsIndex)) {
    // The committed file carries NUMBERED decisions only (PD-551) — provisional ones are kept out
    // so that authoring one touches no shared file. They are still binding, so they are appended
    // here, read live from `DECISIONS/incoming/`. An agent that cannot see a decision that merged
    // an hour ago will re-litigate it, which is the whole reason the index is injected (D-071).
    //
    // Best-effort: a malformed inbox file must not cost the agent its entire decision index. The
    // CI duplicate/parse test is what catches that, not a Robot's orientation.
    let provisional = '';
    try {
      provisional = renderProvisionalSection(loadProvisionalDecisions(repoDir));
    } catch (err) {
      logger.warn({ err }, 'orientation: could not read the decision inbox — injecting numbered decisions only');
    }
    parts.push(orientationBlock('DECISIONS.md', (readFileSync(decisionsIndex, 'utf8').trim() + provisional).trim()));
  } else {
    onMissing('DECISIONS.md');
  }

  const memory = readRecentMemory(repoDir, now);
  if (memory.length > 0) {
    parts.push(
      orientationBlock('MEMORY/YYYY-MM-DD.md', memory.map((d) => `#### MEMORY/${d.date}.md\n\n${d.contents}`).join('\n\n')),
    );
  } else {
    onMissing('MEMORY day files (today and yesterday)');
  }

  return composeOrientation(parts);
}

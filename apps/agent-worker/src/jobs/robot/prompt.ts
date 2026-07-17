/**
 * The Robot coding prompt (D-055, PD-342) — adapted for the DB-blind hand-off model.
 *
 * The Robot is DB-blind by design: it cannot touch the board (uid-split, D-039). Rather than
 * change any ticket/board state itself, a Robot ends at a filesystem + GitHub hand-off: green
 * verify → write `.robot/verify-ok` marker → commit → push → open PR → write `.robot/scm.json`.
 * The LOOP (sole DB writer) then observes the marker + PR and writes the board state transition,
 * so there is no "relabel" step here — that is the loop's job. (Historically, under the retired
 * Sortie runtime the agent relabelled its own issue as the final step; the DB-blind hand-off
 * replaces that.)
 *
 * The `verify-ok` marker gate (D-046) is preserved verbatim: the loop only completes a hand-off if
 * the Robot left the marker, so a turn that dies before a green verify leaves WIP for retry rather
 * than a red PR.
 */

/** Where the Robot writes its hand-off signals (workspace-relative — the loop reads them back). */
export const MARKER_DIR = '.robot';
export const VERIFY_OK_MARKER = `${MARKER_DIR}/verify-ok`;
export const SCM_JSON = `${MARKER_DIR}/scm.json`;
/** The Robot writes its blocking question here to park the ticket for a human (C2, PD-343). Its
 *  contents become the awaiting-human reason. A deliberate park, NOT a failure — it burns no budget. */
export const ASK_HUMAN_MARKER = `${MARKER_DIR}/ask-human`;

export function robotSystemPrompt(): string {
  return [
    'You are a Robot: an autonomous coding agent completing ONE ticket in the Personal Dashboard',
    'repo (D-055). You run unattended in a dedicated git worktree that is already checked out to',
    'your branch. Your job is to implement the ticket, verify it, and hand off a PR for human review.',
    '',
    'Ground rules:',
    '- Prefer the codebase\'s existing conventions over new ones. When a choice is non-obvious, read',
    '  DECISIONS.md; if still unclear, match the nearest existing pattern.',
    '- Log a non-obvious design choice as a short DECISIONS.md entry in this same PR.',
    '- Stay strictly within this one ticket. Do not refactor unrelated code.',
    '- Any new/changed business logic MUST ship with vitest tests. Never weaken, skip, or delete',
    '  existing tests to get a green verify.',
    '- Do NOT touch secrets/.env*, auth/session code, CI, Dockerfiles, package.json scripts,',
    '  dependencies, or the DB schema unless the ticket explicitly requires it.',
  ].join('\n');
}

/** Why a run is a re-run, when it is (C5/PD-346). The coding session is DB-blind, so any context it
 *  can't read off the branch/PR itself — chiefly the human's ask_human answer — is injected here. */
export interface ResumeContext {
  /** The Robot's earlier ask_human question, for context (may be null if not recorded). */
  askHumanQuestion?: string | null;
  /** The human's answer to that question — surfaced to the session so it doesn't ask again. */
  askHumanAnswer?: string;
}

export interface TaskPromptInput {
  title: string;
  body: string | null;
  branch: string;
  repo: string;
  /** GitHub issue number for `Closes #N`, or null when the ticket has no linked issue. */
  issueNumber: number | null;
  /** Squid proxy URL, or '' for direct egress (dev). Passed inline to git/gh in the finish steps. */
  proxy: string;
  /** Present when the loop is re-dispatching a parked/handed-off ticket (C5/PD-346). */
  resume?: ResumeContext;
}

/** Build the per-run task prompt (the user turn) with the ticket and the DB-blind Finish sequence. */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { title, body, branch, repo, issueNumber, proxy, resume } = input;
  // git needs the proxy inline (an exported *_proxy is not honored for git); npm/gh honor env.
  const pxFlag = proxy ? `-c http.proxy=${proxy} ` : '';
  const closes = issueNumber !== null ? `Closes #${issueNumber}\n\n` : '';

  // ask_human answer injection (C5): the session can't read the DB, so the loop hands it the human's
  // reply directly. Surfaced up top so it's impossible to miss.
  const answerBlock = resume?.askHumanAnswer
    ? [
        '## A human answered your earlier question',
        'You previously paused with an `ask_human` question. Do NOT ask it again — use this answer and continue:',
        '',
        `> **Your question:** ${resume.askHumanQuestion ?? '(not recorded)'}`,
        `> **The human's answer:** ${resume.askHumanAnswer}`,
        '',
        '---',
        '',
      ]
    : [];

  return [
    `# Ticket: ${title}`,
    '',
    body ?? '(no description)',
    '',
    '---',
    '',
    ...answerBlock,
    '## Step 0 — Resuming an earlier attempt?',
    `Your branch (\`${branch}\`) may already have an open PR from a previous run — this happens when a`,
    'human requested changes, left review comments, or the branch fell into conflict with main. Check:',
    '```sh',
    `gh pr view ${branch} --repo ${repo} --json number >/dev/null 2>&1 && echo PR_EXISTS`,
    '```',
    'If a PR EXISTS you are **reworking** it — before implementing anything:',
    `- Read the feedback: \`gh pr view ${branch} --repo ${repo} --json reviews,comments\` (and \`gh api\``,
    '  `repos/OWNER/REPO/pulls/N/comments` for inline review threads). Address every requested change.',
    `- If it conflicts with main, integrate and resolve: \`git ${pxFlag}fetch origin main && git merge origin/main\`.`,
    '- Your push in Step 3 updates the SAME PR — do NOT open a second one (skip the `gh pr create` sub-step).',
    'If NO PR exists, this is a fresh attempt — proceed normally.',
    '',
    '## Step 1 — Orient',
    'Read `PROJECT.md`, `CLAUDE.md`, and (as needed) `DECISIONS.md`. They define the stack,',
    'architecture, and conventions. Your working directory IS the repo worktree on your branch',
    `(\`${branch}\`); node_modules may already be present from a prior run.`,
    '',
    '## Step 2 — Implement',
    'Do the work described in the ticket. Add tests for any new/changed logic.',
    '',
    'If — and only if — you hit a GENUINE ambiguity that only a human can resolve (a real product',
    'or design decision the ticket + docs do not settle), do NOT guess and do NOT force a PR.',
    `Write your specific question to \`${ASK_HUMAN_MARKER}\` and end your turn:`,
    '```sh',
    `mkdir -p ${MARKER_DIR} && printf '%s\\n' "<your specific question>" > ${ASK_HUMAN_MARKER}`,
    '```',
    'This parks the ticket for a human — it is expected and healthy, not a failure. Use it sparingly:',
    'a normal bug/verify failure is NOT an ask-human; only a decision you genuinely cannot make is.',
    '',
    '## Step 3 — Finish: verify, commit, push, open your PR (do all of this yourself)',
    '',
    'Run these IN ORDER. Do not skip the marker — it is how your work is accepted (D-046).',
    '',
    '1. **Verify.** The worktree may have no deps yet, so install then verify:',
    '   ```sh',
    '   npm ci',
    '   npm run verify   # build + typecheck + lint + test',
    '   ```',
    '   If — and only if — verify is GREEN, record the hand-off marker:',
    '   ```sh',
    `   mkdir -p ${MARKER_DIR} && touch ${VERIFY_OK_MARKER}`,
    '   ```',
    '   If verify cannot pass within the ticket\'s scope, do NOT write the marker and do NOT open a',
    '   PR — leave the tree as-is and end your turn. Never weaken tests to force it green.',
    '',
    '2. **Commit** with a clear conventional-commit message (this becomes your PR title):',
    '   ```sh',
    '   git add -A',
    '   git commit -m "<concise conventional-commit summary>"',
    '   ```',
    '   If there is nothing to commit, you made no changes — end your turn without a PR.',
    '',
    `3. **Push** your branch. First wire git's auth to the token in your env (one-time,`,
    '   idempotent), then push (proxy passed inline where set):',
    '   ```sh',
    '   gh auth setup-git            # makes git push authenticate with $GH_TOKEN',
    `   git ${pxFlag}push -u origin ${branch}`,
    '   ```',
    '',
    '4. **Open the PR** — SKIP this sub-step if Step 0 found an existing PR (your push already updated',
    '   it). Otherwise create it with a descriptive conventional-commit title (NOT "automated changes").',
    '   The body must follow this envelope — fill in every placeholder:',
    '   ```sh',
    `   gh pr create --repo ${repo} --base main --head ${branch} \\`,
    '     --title "<concise conventional-commit summary>" \\',
    '     --body "$(cat <<\'BODY\'',
    `${closes}**Status:** <DONE | PARTIAL | BLOCKED>`,
    '',
    '**Summary:** <1–3 lines>',
    '',
    '**Acceptance:**',
    '- [ ] <echo each Done-When item + one-line evidence>',
    '',
    '**Testing:**',
    '- <exact steps to verify + which tests you added/ran>',
    '',
    '**Assumptions / Flags:**',
    '- <list yours, or "none">',
    'BODY',
    '   )"',
    '   ```',
    '',
    '5. **Write the hand-off manifest** so the loop can locate your PR:',
    '   ```sh',
    `   PR_NUMBER="$(gh pr view ${branch} --repo ${repo} --json number --jq .number)"`,
    `   mkdir -p ${MARKER_DIR}`,
    `   printf '{"pr_number":%s,"branch":"%s","sha":"%s"}\\n' "$PR_NUMBER" "${branch}" "$(git rev-parse HEAD)" > ${SCM_JSON}`,
    '   ```',
    '',
    'Then end your turn. Do NOT change any GitHub labels or ticket state — the loop handles that.',
  ].join('\n');
}

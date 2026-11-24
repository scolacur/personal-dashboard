<script lang="ts">
  import type { AwaitingVisualItem } from '@dashboard/shared';
  import { approveLabel, askedBy, captureNotice, rejectBlocked, shotsByRoute, stepFailureLines } from './visual-check-logic';

  /**
   * One Robot PR waiting for Steve's visual check (PD-773): what was asked, the screenshots, and
   * Approve / Request changes. Approving releases review-gate once the Evaluator has shipped it;
   * requesting changes sends the PR back to the Robot with the note.
   */
  let {
    item,
    onDecide,
  }: {
    item: AwaitingVisualItem;
    onDecide: (approved: boolean, note: string) => Promise<void>;
  } = $props();

  let note = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const groups = $derived(shotsByRoute(item.shots));
  const failed = $derived(stepFailureLines(item));
  const blocked = $derived(rejectBlocked(note));
  // The list refetches on its own cadence; `now` here is when this card rendered that data.
  const notice = $derived(captureNotice(item, Date.now()));

  async function decide(approved: boolean) {
    if (busy || (!approved && blocked)) return;
    busy = true;
    error = null;
    try {
      await onDecide(approved, note);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="vc">
  <p class="vc-asked">
    {askedBy(item)} asked for your eyes on
    {#if item.prUrl}<a href={item.prUrl} target="_blank" rel="noreferrer">PR #{item.prNumber}</a>{:else}PR #{item.prNumber}{/if}:
  </p>
  <ul class="vc-reasons">
    {#each item.reasons as r, i (i)}<li>{r.reason}</li>{/each}
  </ul>

  {#if notice}
    <p class="vc-pending" class:vc-warn={notice.tone === 'warn'} role={notice.tone === 'warn' ? 'status' : undefined}>{notice.text}</p>
  {/if}
  {#if groups.length > 0}
    {#each groups as g (g.key)}
      <h4 class="vc-route">{g.heading}</h4>
      <div class="vc-shots">
        {#each g.shots as s (s.file)}
          <a class="vc-shot" href={s.url} target="_blank" rel="noreferrer">
            <img src={s.url} alt="{g.heading} on {s.viewport}, {s.scheme} theme" loading="lazy" />
            <span>{s.viewport} · {s.scheme}</span>
          </a>
        {/each}
      </div>
    {/each}
  {/if}

  {#if failed.length > 0}
    <div class="vc-failed" role="status">
      <p>{failed.length === 1 ? 'A click step' : `${failed.length} click steps`} could not run, so some of what was asked for is not pictured:</p>
      <ul>{#each failed as f, i (i)}<li>{f}</li>{/each}</ul>
    </div>
  {/if}

  <label class="vc-note-label" for="vc-note-{item.ticketId}">What to change (needed to request changes)</label>
  <textarea id="vc-note-{item.ticketId}" class="vc-note" rows="2" bind:value={note} disabled={busy}></textarea>
  <div class="vc-actions">
    <button class="vc-approve" onclick={() => decide(true)} disabled={busy}>{approveLabel(item)}</button>
    <button class="vc-reject" onclick={() => decide(false)} disabled={busy || blocked !== null} title={blocked ?? ''}>Request changes</button>
  </div>
  {#if error}<p class="vc-error" role="alert">{error}</p>{/if}
</div>

<style lang="scss" src="./VisualCheck.scss"></style>

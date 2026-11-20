<script lang="ts">
  import type { AwaitingVisualItem } from '@dashboard/shared';
  import { askedBy, rejectBlocked, shotsByRoute } from './visual-check-logic';

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
  const blocked = $derived(rejectBlocked(note));

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

  {#if groups.length === 0}
    <p class="vc-pending">Screenshots are still being captured; they appear here within a few minutes.</p>
  {:else}
    {#each groups as g (g.route)}
      <h4 class="vc-route">{g.route}</h4>
      <div class="vc-shots">
        {#each g.shots as s (s.file)}
          <a class="vc-shot" href={s.url} target="_blank" rel="noreferrer">
            <img src={s.url} alt="{g.route} on {s.viewport}, {s.scheme} theme" loading="lazy" />
            <span>{s.viewport} · {s.scheme}</span>
          </a>
        {/each}
      </div>
    {/each}
  {/if}

  <label class="vc-note-label" for="vc-note-{item.ticketId}">What to change (needed to request changes)</label>
  <textarea id="vc-note-{item.ticketId}" class="vc-note" rows="2" bind:value={note} disabled={busy}></textarea>
  <div class="vc-actions">
    <button class="vc-approve" onclick={() => decide(true)} disabled={busy}>Looks right</button>
    <button class="vc-reject" onclick={() => decide(false)} disabled={busy || blocked !== null} title={blocked ?? ''}>Request changes</button>
  </div>
  {#if error}<p class="vc-error" role="alert">{error}</p>{/if}
</div>

<style lang="scss" src="./VisualCheck.scss"></style>

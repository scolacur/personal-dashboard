<script lang="ts">
  import { BST_MATCH_INTENT_LABELS, type BstMatch } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import { splitByConfidence, type MatchGroup } from '$lib/buy-sell-trade/matches';
  import { setMatchDismissed } from '$lib/buy-sell-trade/api';

  // What the r/modular scan found (PD-438), split into confirmed and possible (PD-475).
  //
  // The two halves are separate sections rather than one badged list because they are read
  // differently: the confirmed half line by line, the possible half at a skim. That split IS the
  // feature — it is what lets the matcher stop discarding uncertain hits without turning the
  // readout into noise. See D-065's PD-475 amendment.
  let {
    matches,
    onDismissed,
  }: {
    matches: BstMatch[];
    /** Told which match went away, so the page can drop it from its own state. */
    onDismissed: (id: number) => void;
  } = $props();

  let busy = $state<number | null>(null);
  let error = $state('');

  const split = $derived(splitByConfidence(matches));
  const possibleCount = $derived(split.possible.reduce((n, g) => n + g.items.length, 0));

  async function dismiss(m: BstMatch): Promise<void> {
    busy = m.id;
    error = '';
    try {
      await setMatchDismissed(m.id, true);
      onDismissed(m.id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to dismiss';
    } finally {
      busy = null;
    }
  }
</script>

{#snippet groupList(groups: MatchGroup[], showWhy: boolean)}
  {#each groups as group (group.label)}
    <article class="match-group sig-{group.significance}">
      <h3 class="match-item">
        {group.label}
        {#if group.significance === 'high'}
          <span class="match-flag">worth a look</span>
        {/if}
      </h3>
      <ul class="match-list">
        {#each group.items as m (m.id)}
          <li class="match">
            <div class="match-meta">
              <span class="match-intent intent-{m.intent}">{BST_MATCH_INTENT_LABELS[m.intent]}</span>
              <a
                class="match-author"
                href={m.authorUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                u/{m.author}
              </a>
              <!-- Only on a possible match: there, "why did this fire?" is the first question,
                   and the answer is rarely self-evident. On a confirmed one it is just clutter. -->
              {#if showWhy && m.matchedOn}
                <span class="match-why">matched “{m.matchedOn}”</span>
              {/if}
            </div>
            <p class="match-excerpt">{m.excerpt}</p>
            <div class="match-actions">
              <a class="match-link" href={m.permalink} target="_blank" rel="noreferrer noopener">
                Open comment ↗
              </a>
              <Button variant="ghost" onclick={() => dismiss(m)} disabled={busy === m.id}>
                {busy === m.id ? 'Dismissing…' : 'Dismiss'}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    </article>
  {/each}
{/snippet}

<section class="bst-matches" aria-label="Matches from r/modular">
  {#if error}<p class="bst-error" role="alert">{error}</p>{/if}

  {#if split.confirmed.length > 0}
    <h2 class="bst-matches-title">Matches from r/modular</h2>
    {@render groupList(split.confirmed, false)}
  {/if}

  {#if possibleCount > 0}
    <!-- Collapsed by default. These are recorded rather than discarded (PD-475), which is only
         tolerable if they stay out of the way until asked for. -->
    <Collapsible
      title="Possible matches"
      count={possibleCount}
      open={false}
      storeKey="bst-possible-matches"
    >
      <p class="bst-possible-help">
        Mentions the scan could not confirm — usually a name that is also ordinary modular
        vocabulary, or a nickname it worked out for itself. Worth a skim, not a read.
      </p>
      {@render groupList(split.possible, true)}
    </Collapsible>
  {/if}
</section>

<style lang="scss" src="./MatchesReadout.scss"></style>

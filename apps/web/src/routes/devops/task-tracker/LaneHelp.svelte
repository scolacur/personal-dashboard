<script lang="ts">
  import type { TicketStatus } from '@dashboard/shared';
  import { laneHelp, laneHelpText } from '../lane-help';

  /**
   * The `?` beside a lane header, and the popover it opens (PD-517).
   *
   * Deliberately not a `title=` attribute: the Queue's rules are a six-item list, and a native
   * tooltip renders them as an unstyled blob, appears only after a delay, and is unreachable by
   * keyboard. This is a real popover — shown on hover, on focus, and on click — but it stays a
   * plain element rather than a new component library, per the ticket.
   *
   * Click-to-pin exists because the Queue text is long enough to want to read at your own pace,
   * and a hover-only popover disappears the moment you move toward it.
   */
  let {
    status,
    label,
    alignEnd = false,
  }: {
    status: TicketStatus;
    label: string;
    /** Anchor the popover to its right edge. `.board` is an `overflow-x: auto` scroll container,
     *  so a left-anchored popover on the last lane opens into clipped space. */
    alignEnd?: boolean;
  } = $props();

  const help = $derived(laneHelp(status));
  const describedById = $derived(`lane-help-${status}`);

  let pinned = $state(false);
</script>

<span class="lane-help">
  <button
    class="lane-help-btn"
    class:pinned
    type="button"
    aria-label="What does the {label} lane mean?"
    aria-expanded={pinned}
    aria-describedby={describedById}
    title={laneHelpText(status)}
    onclick={() => (pinned = !pinned)}
  >?</button>

  <!-- Always in the DOM so `aria-describedby` resolves for a screen reader even while the popover
       is visually hidden; CSS reveals it on hover/focus, and `.pinned` keeps it open. -->
  <span class="lane-help-pop" class:pinned class:align-end={alignEnd} id={describedById} role="tooltip">
    <span class="lane-help-summary">{help.summary}</span>
    {#if help.bullets.length > 0}
      <ul class="lane-help-list">
        {#each help.bullets as b (b)}
          <li>{b}</li>
        {/each}
      </ul>
    {/if}
    {#if help.footnote}
      <span class="lane-help-foot">{help.footnote}</span>
    {/if}
  </span>
</span>

<style lang="scss" src="./LaneHelp.scss"></style>

<script lang="ts">
  import type { TicketStatus } from '@dashboard/shared';
  import { laneHelp } from '../lane-help';

  /**
   * The `?` beside a lane header, and the popover it opens (PD-517).
   *
   * Deliberately not a `title=` attribute: the Queue's rules are a list, and a native tooltip
   * renders them as an unstyled blob, appears only after a delay, and is unreachable by keyboard.
   * This is a real popover, but it stays a plain element rather than a new component library.
   *
   * **No `title` at all (PD-591).** One was set as a plain-text fallback, and the browser rendered
   * it *on top of* the popover — two tooltips for one control, the native one obscuring the real
   * one. A fallback that fights the thing it backs up is worse than no fallback.
   *
   * **Hover and keyboard focus only (PD-591).** Click-to-pin was removed: it let several popovers
   * sit open at once, and a pinned one stayed up after the pointer left, so the board accumulated
   * panels nobody had dismissed. Hover/focus means exactly one is ever showing, and it is always
   * the one being pointed at.
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
</script>

<span class="lane-help">
  <button
    class="lane-help-btn"
    type="button"
    aria-label="What does the {label} lane mean?"
    aria-describedby={describedById}
  >?</button>

  <!-- Always in the DOM so `aria-describedby` resolves for a screen reader even while the popover
       is visually hidden; CSS reveals it on hover/focus. -->
  <span class="lane-help-pop" class:align-end={alignEnd} id={describedById} role="tooltip">
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

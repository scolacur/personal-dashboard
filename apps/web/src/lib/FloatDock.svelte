<script lang="ts">
  import type { Snippet } from 'svelte';

  // The bottom-right floating row: everything that hovers over the page lives here, side by side,
  // so the pieces never land on top of each other — the "Change something" button plus the
  // Pomodoro on most pages, plus the Refine chat on the ticket-detail page. Items sit on a common
  // bottom edge, so one that expands (a chat, the Pomodoro panel) grows upward and leaves its
  // neighbours where they were.
  //
  // `aboveBottomNav` lifts the dock on phones for pages with a sticky bottom nav (the ticket page),
  // which it would otherwise cover. `align="center"` centres the row along the bottom of the
  // content column on desktop (the ticket page, where it holds the Refine chat); phones keep it
  // bottom-right either way.
  const {
    children,
    aboveBottomNav = false,
    align = 'right',
  }: { children: Snippet; aboveBottomNav?: boolean; align?: 'right' | 'center' } = $props();
</script>

<div class="float-dock" class:above-bottom-nav={aboveBottomNav} class:center={align === 'center'}>
  {@render children()}
</div>

<style lang="scss" src="./FloatDock.scss"></style>

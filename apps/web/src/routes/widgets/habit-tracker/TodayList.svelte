<script lang="ts">
  import { STREAK_BADGE_MIN, type HabitTodayRow } from '@dashboard/shared';

  /**
   * The Today checklist (PD-721; schedules + streaks PD-722). A flat list of due habits in manual
   * order; tap a row to tick, tap again to untick, no confirmation. Shared by the card (`compact`)
   * and the page's Today tab. Read-only — no editing of items here (that is the Habits tab).
   *
   * Only **due** rows appear: a days-of-week habit is absent on a day it is not due; a per-week habit
   * is always present and, once its target is met, shows as done for the week ("✓ 3/3 this week").
   * A current streak of {@link STREAK_BADGE_MIN} or more shows a 🔥N badge.
   */
  let {
    rows,
    completed,
    onToggle,
    loaded = true,
    compact = false,
  }: {
    rows: HabitTodayRow[];
    completed: Set<number>;
    onToggle: (item: HabitTodayRow['item']) => void;
    loaded?: boolean;
    compact?: boolean;
  } = $props();

  const visible = $derived(rows.filter((r) => r.due));
</script>

<ul class="today-list" class:compact aria-label="Today's habits">
  {#each visible as row (row.item.id)}
    {@const done = completed.has(row.item.id)}
    {@const weekDone = row.perWeek?.met ?? false}
    <li>
      <button
        type="button"
        class="today-row"
        class:done={done || weekDone}
        aria-pressed={done}
        onclick={() => onToggle(row.item)}
      >
        <span class="check" aria-hidden="true">{done || weekDone ? '✓' : ''}</span>
        <span class="name">{row.item.name}</span>
        {#if row.perWeek}
          <span class="week-progress" class:met={weekDone}>
            {weekDone ? '✓ ' : ''}{row.perWeek.count}/{row.perWeek.target} this week
          </span>
        {/if}
        {#if row.streak.current >= STREAK_BADGE_MIN}
          <span class="streak" title={`${row.streak.current}-period streak`}>🔥{row.streak.current}</span>
        {/if}
      </button>
    </li>
  {/each}

  {#if visible.length === 0 && loaded}
    <li class="empty">
      {compact ? 'Nothing due today.' : 'Nothing due today — add or schedule a habit on the Habits tab.'}
    </li>
  {/if}
</ul>

<style lang="scss" src="./TodayList.scss"></style>

<script lang="ts">
  import type { AcuteStrategyDraw } from '@dashboard/shared';
  import { relativeDrawTime } from './utils';

  interface Props {
    draws: AcuteStrategyDraw[];
  }

  let { draws }: Props = $props();
</script>

<section class="recent-draws">
  <h2 class="recent-title">Recent draws</h2>
  {#if draws.length === 0}
    <p class="recent-empty">No draws yet — press Shuffle.</p>
  {:else}
    <ul class="recent-list">
      {#each draws as draw (draw.id)}
        <li class="recent-item">
          <div class="recent-body">
            <span class="recent-text">
              {draw.idea_text}{#if draw.idea_id === null}<span class="deleted"> (deleted)</span>{/if}
            </span>
            <span class="type-badge type-{draw.idea_type.toLowerCase()}">{draw.idea_type}</span>
          </div>
          <span class="recent-time">{relativeDrawTime(draw.drawn_at)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style lang="scss" src="./RecentDraws.scss"></style>

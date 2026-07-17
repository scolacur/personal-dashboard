<script lang="ts">
  import type { TicketEvent, RobotEventDetail } from '@dashboard/shared';
  import { ROBOT_EVENT } from '@dashboard/shared';
  import { fetchTicketEvents } from '../routes/task-monitor/api';
  import Collapsible from './Collapsible.svelte';

  // The ticket's activity timeline (C3/PD-344, realising PD-255). Reads the SAME
  // agent_ticket_events log the Refine thread uses (reuse, not a parallel log) and renders the
  // milestone subset — everything EXCEPT the refine_* conversation turns, which TicketThread
  // already shows. Newest first.
  const { ticketId }: { ticketId: number } = $props();

  let events = $state<TicketEvent[]>([]);
  let loading = $state(true);

  // Conversation turns live in the Refine thread, not here.
  const HIDDEN = new Set(['refine_human', 'refine_agent', 'refine_proposal']);

  async function load(): Promise<void> {
    try {
      const all = await fetchTicketEvents(ticketId);
      events = all.filter((e) => !HIDDEN.has(e.type)).reverse(); // newest first
    } catch {
      events = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (ticketId) load();
  });

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  function icon(type: string): string {
    switch (type) {
      case ROBOT_EVENT.dispatched:
        return '🤖';
      case ROBOT_EVENT.handoff:
        return '✅';
      case ROBOT_EVENT.fault:
        return '⚠️';
      case ROBOT_EVENT.parked:
        return '🅿️';
      case ROBOT_EVENT.askHuman:
        return '❓';
      case ROBOT_EVENT.paused:
        return '⛔';
      case ROBOT_EVENT.humanReply:
        return '💬';
      case ROBOT_EVENT.resumed:
        return '▶️';
      case ROBOT_EVENT.reactivated:
        return '🔄';
      case ROBOT_EVENT.stalled:
        return '⏱️';
      case ROBOT_EVENT.completed:
        return '🏁';
      case ROBOT_EVENT.prClosed:
        return '🚫';
      case ROBOT_EVENT.sessionEnded:
        return '🧹';
      case 'created':
        return '✨';
      case 'status_changed':
        return '↔️';
      case 'archived':
        return '🗄️';
      default:
        return '•';
    }
  }

  // A human-readable line per event. Robot milestones carry a RobotEventDetail; the generic
  // server events carry their own small shapes (from/to, etc.).
  function describe(e: TicketEvent): string {
    const d = (e.detail ?? {}) as RobotEventDetail & { from?: string; to?: string; spawnedDisplayId?: string };
    switch (e.type) {
      case ROBOT_EVENT.dispatched:
        return `Robot dispatched${d.branch ? ` on ${d.branch}` : ''}`;
      case ROBOT_EVENT.handoff:
        return `Handed off a PR${d.prUrl ? '' : ''}`;
      case ROBOT_EVENT.fault:
        return `Transient fault — retrying${d.reason ? `: ${d.reason}` : ''}`;
      case ROBOT_EVENT.parked:
        return `Parked${d.tier ? ` (${d.tier})` : ''}${d.reason ? `: ${d.reason}` : ''}`;
      case ROBOT_EVENT.askHuman:
        return `Asked for human input${d.question ? `: ${d.question}` : ''}`;
      case ROBOT_EVENT.paused:
        return `System-wide fault — dispatch paused${d.reason ? `: ${d.reason}` : ''}`;
      case ROBOT_EVENT.humanReply:
        return `You replied${d.text ? `: ${d.text}` : ''}`;
      case ROBOT_EVENT.resumed:
        return 'Resumed after your reply';
      case ROBOT_EVENT.reactivated:
        return `Re-activated for rework${d.reason ? `: ${d.reason}` : ''}`;
      case ROBOT_EVENT.stalled:
        return `Stalled run ${d.state === 'stuck' ? 'parked (stuck)' : 're-queued'}${d.reason ? `: ${d.reason}` : ''}`;
      case ROBOT_EVENT.completed:
        return 'PR merged — ticket completed';
      case ROBOT_EVENT.prClosed:
        return 'PR closed without merging — needs human';
      case ROBOT_EVENT.sessionEnded:
        return `Agent session ended${d.to ? ` (moved to ${d.to})` : ''}`;
      case 'created':
        return 'Ticket created';
      case 'status_changed':
        return `Status ${d.from ?? '?'} → ${d.to ?? '?'}`;
      case 'assignee_changed':
        return `Assignee ${d.from ?? 'none'} → ${d.to ?? 'none'}`;
      case 'recurred':
        return `Recurred → ${d.spawnedDisplayId ?? 'new ticket'}`;
      case 'archived':
        return 'Archived';
      case 'epic_unlinked':
        return 'Unlinked from epic';
      default:
        return e.type;
    }
  }
</script>

{#if !loading && events.length > 0}
  <Collapsible title="Robot activity" count={events.length} storeKey="activity">
    <ul class="events">
      {#each events as e (e.id)}
        <li class="event" class:milestone={e.type.startsWith('robot_')}>
          <span class="ev-icon" aria-hidden="true">{icon(e.type)}</span>
          <div class="ev-body">
            <span class="ev-text">{describe(e)}</span>
            {#if e.type === ROBOT_EVENT.handoff && (e.detail as RobotEventDetail)?.prUrl}
              <a class="ev-link" href={(e.detail as RobotEventDetail).prUrl} target="_blank" rel="noreferrer">view PR</a>
            {/if}
            <span class="ev-when">{fmt(e.createdAt)}</span>
          </div>
        </li>
      {/each}
    </ul>
  </Collapsible>
{/if}

<style lang="scss" src="./ActivityTimeline.scss"></style>

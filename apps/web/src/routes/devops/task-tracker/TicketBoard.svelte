<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { AgentTicket, TicketStatus } from '@dashboard/shared';
  import LaneColumn from './LaneColumn.svelte';
  import LaneHelp from './LaneHelp.svelte';
  import { pickBeforeId, type DropCandidate } from '../board-drag';

  /**
   * The board grid: lane headers, an optional Epic band, and the draggable Ticket band (PD-554).
   *
   * Extracted from `task-tracker/+page.svelte` so the Epic detail page can show the same board
   * scoped to one Epic's members — **one board, not two that drift.** That is the whole point of the
   * component; the alternative was a second kanban that would diverge on the first change to either.
   *
   * **What it owns:** the grid, the lane headers and their `?` help, the drag state, the drop
   * indicators, and the insertion maths (`pickBeforeId`, tested in `board-drag.spec.ts`).
   *
   * **What it does not own:** the cards. They arrive through the `card` snippet, because the board
   * page's cards carry a dozen page-specific callbacks — edit, duplicate, copy, refine, relations,
   * the status legend — that mean nothing on an Epic page. Passing them all through as props would
   * make the component a description of one caller rather than a board. The snippet receives the
   * per-ticket drag props it needs, so the caller never reimplements the gesture.
   *
   * `onMove` is the single write. The component never calls the API itself: the two callers need
   * different follow-ups (a full board reload; a member refetch), and a component that reloads its
   * caller's data is a component that only fits one caller.
   */
  let {
    columns,
    itemsFor,
    lanes = columns.length,
    showEpics = false,
    showTickets = true,
    epicAreaHeight,
    addDisabled = false,
    onAdd,
    canDrag,
    onMove,
    epicBand,
    card,
  }: {
    columns: { status: TicketStatus; label: string }[];
    /** The tickets for a lane, already filtered and in display order. */
    itemsFor: (status: TicketStatus) => AgentTicket[];
    /** Grid column count; defaults to the number of columns. */
    lanes?: number;
    showEpics?: boolean;
    showTickets?: boolean;
    epicAreaHeight?: number;
    addDisabled?: boolean;
    /** Omit to hide the per-lane `+` entirely (the Epic page has its own Add member). */
    onAdd?: (status: TicketStatus) => void;
    /**
     * Whether this ticket may be dragged, and what to say when it may not.
     *
     * The caller decides, because the reasons are its own: the board refuses terminal
     * (D-083) and robot-locked (D-058) cards and toasts an explanation.
     */
    canDrag?: (t: AgentTicket) => { ok: boolean; reason?: string };
    /** Commit a move. `beforeId` is the card to insert before, or null to append to the band. */
    onMove: (ticket: AgentTicket, status: TicketStatus, beforeId: number | null) => void;
    /** The Epic band's cells and resize handle, rendered inside the grid by the caller. */
    epicBand?: Snippet;
    card: Snippet<[AgentTicket, { dragging: boolean; dropBefore: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }]>;
  } = $props();

  let draggingId = $state<number | null>(null);
  let dropTarget = $state<{ status: TicketStatus; beforeId: number | null } | null>(null);

  function onDragStart(e: DragEvent, ticket: AgentTicket) {
    const verdict = canDrag ? canDrag(ticket) : { ok: true };
    if (!verdict.ok) {
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'none';
      e.preventDefault();
      return;
    }
    draggingId = ticket.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(ticket.id));
    }
  }

  function onDragEnd() {
    draggingId = null;
    dropTarget = null;
  }

  function onColumnDragOver(e: DragEvent, status: TicketStatus) {
    if (draggingId === null) return;
    const dragged = itemsFor(status).find((t) => t.id === draggingId) ?? findDragged();
    if (!dragged) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // The DOM half: measure the cards. What the measurements MEAN is `pickBeforeId`, which is
    // pure and tested — the banding rules are the part worth getting right.
    const candidates: DropCandidate[] = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.card'),
    ]
      .filter((el) => Number(el.dataset.id) !== draggingId)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          id: Number(el.dataset.id),
          priority: el.dataset.priority ?? 'none',
          midpointY: rect.top + rect.height / 2,
        };
      });
    dropTarget = { status, beforeId: pickBeforeId(candidates, dragged.priority, e.clientY) };
  }

  /** The dragged ticket, wherever it currently sits — a drag crosses lanes. */
  function findDragged(): AgentTicket | undefined {
    for (const col of columns) {
      const hit = itemsFor(col.status).find((t) => t.id === draggingId);
      if (hit) return hit;
    }
    return undefined;
  }

  function onDrop(e: DragEvent, status: TicketStatus) {
    e.preventDefault();
    const ticket = findDragged();
    const beforeId = dropTarget?.beforeId ?? null;
    draggingId = null;
    dropTarget = null;
    if (ticket) onMove(ticket, status, beforeId);
  }
</script>

<div
  class="board"
  class:no-epics={!showEpics}
  style="--lanes: {lanes}{epicAreaHeight !== undefined ? `; --epic-area-height: ${epicAreaHeight}px` : ''}"
>
  <!-- Row 1: lane headers -->
  {#each columns as col, i (col.status)}
    <div class="lane-head" style="grid-column: {i + 1}">
      <h2 class="column-head">
        {col.label}<span class="count">{itemsFor(col.status).length}</span>
        <!-- PD-517: a lane's rules are invisible on the surface, and the header is where the
             question gets asked. -->
        <LaneHelp status={col.status} label={col.label} alignEnd={i >= columns.length - 1} />
      </h2>
    </div>
  {/each}

  <!-- Rows 2–3: the Epic band, supplied by the caller. Rendered here so it sits inside the same
       grid, but styled by the caller — a snippet compiles in its parent's scope. -->
  {#if showEpics}{@render epicBand?.()}{/if}

  <!-- Row 4: Ticket band (the only drop target) -->
  {#if showTickets}
    {#each columns as col, i (col.status)}
      {@const items = itemsFor(col.status)}
      <LaneColumn
        label={col.label}
        count={items.length}
        gridColumn={i + 1}
        dragOver={dropTarget?.status === col.status && draggingId !== null}
        addDisabled={addDisabled || onAdd === undefined}
        showDropEnd={draggingId !== null &&
          dropTarget?.status === col.status &&
          dropTarget?.beforeId === null}
        onAdd={() => onAdd?.(col.status)}
        onDragOver={(e) => onColumnDragOver(e, col.status)}
        onDrop={(e) => onDrop(e, col.status)}
      >
        {#each items as ticket (ticket.id)}
          {@render card(ticket, {
            dragging: draggingId === ticket.id,
            dropBefore: dropTarget?.status === col.status && dropTarget?.beforeId === ticket.id,
            onDragStart: (e: DragEvent) => onDragStart(e, ticket),
            onDragEnd,
          })}
        {/each}
      </LaneColumn>
    {/each}
  {/if}
</div>

<style lang="scss" src="./TicketBoard.scss"></style>

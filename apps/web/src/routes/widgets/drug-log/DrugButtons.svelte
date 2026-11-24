<script lang="ts">
  import { contrastText, type DrugLogDrug } from '@dashboard/shared';
  import { labelScale } from './drug-log';

  /**
   * The grid of round tap buttons (PD-975, Drug log widget). In normal mode a tap logs; in edit
   * mode (page only) a tap opens the button's editor and a trailing "+" adds one.
   *
   * Each tap restarts a ring pulse in the button's colour (a `{#key}` on a per-button counter);
   * the press itself is a CSS `:active` scale. Both are off under `prefers-reduced-motion`.
   */
  interface Props {
    drugs: DrugLogDrug[];
    /** Today's count per drug id. */
    counts: Map<number, number>;
    editing?: boolean;
    compact?: boolean;
    onTap: (drug: DrugLogDrug) => void;
    onEdit?: (drug: DrugLogDrug) => void;
    onAdd?: () => void;
  }

  let { drugs, counts, editing = false, compact = false, onTap, onEdit, onAdd }: Props = $props();

  let pulses = $state<Record<number, number>>({});

  function press(drug: DrugLogDrug): void {
    if (editing) {
      onEdit?.(drug);
      return;
    }
    pulses[drug.id] = (pulses[drug.id] ?? 0) + 1;
    onTap(drug);
  }
</script>

<div class="drug-grid" class:compact class:editing>
  {#each drugs as drug (drug.id)}
    {@const count = counts.get(drug.id) ?? 0}
    <button
      type="button"
      class="drug"
      style:--drug-color={drug.color}
      style:--drug-text={contrastText(drug.color)}
      style:--label-scale={labelScale(drug.label)}
      aria-label={editing ? `Edit ${drug.label}` : `Log ${drug.label} (${count} today)`}
      onclick={() => press(drug)}
    >
      {#if (pulses[drug.id] ?? 0) > 0}
        {#key pulses[drug.id]}
          <span class="ring" aria-hidden="true"></span>
        {/key}
      {/if}
      <span class="label">{drug.label}</span>
      {#if count > 0 && !editing}
        <span class="badge" aria-hidden="true">{count}</span>
      {/if}
      {#if editing}
        <span class="edit-mark" aria-hidden="true">✎</span>
      {/if}
    </button>
  {/each}

  {#if editing && onAdd}
    <button type="button" class="drug add" aria-label="Add a button" onclick={onAdd}>
      <span class="label">+</span>
    </button>
  {/if}
</div>

<style lang="scss" src="./DrugButtons.scss"></style>

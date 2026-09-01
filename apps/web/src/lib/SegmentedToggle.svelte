<script lang="ts" generics="T extends string">
  /**
   * A small set of mutually-exclusive choices, shown as one control rather than a dropdown.
   *
   * Extracted from the Epic page's list/board switch (PD-608) so the board's assignee filter can be
   * the same control instead of a second one that looks almost like it. A `<select>` is the right
   * shape when the options are many, variable, or long; for a fixed handful it hides every option
   * but one behind a click, to save space a toolbar row has plenty of.
   *
   * Deliberately a component and not just a shared stylesheet: the accessible structure is the part
   * worth sharing — `role="group"` with a label, and `aria-pressed` on each button. A partial would
   * have shared the paint and let each caller reinvent the semantics.
   */
  let {
    options,
    value,
    onChange,
    label,
  }: {
    options: { value: T; label: string; title?: string }[];
    value: T;
    onChange: (value: T) => void;
    /** Names the group for a screen reader; there is no visible label. */
    label: string;
  } = $props();
</script>

<div class="segmented" role="group" aria-label={label}>
  {#each options as o (o.value)}
    <button
      type="button"
      class:active={value === o.value}
      aria-pressed={value === o.value}
      title={o.title ?? o.label}
      onclick={() => onChange(o.value)}>{o.label}</button
    >
  {/each}
</div>

<style lang="scss">
  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;

    button {
      padding: 2px var(--space-sm);
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: var(--font-size-xs);
      white-space: nowrap;
      cursor: pointer;

      &:hover:not(.active) {
        color: var(--text);
        background: var(--surface-2);
      }

      &.active {
        background: var(--accent);
        color: var(--bg);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
    }
  }

  /* Comfortable tap targets on mobile, matching the board's other controls. */
  @media (max-width: 640px) {
    .segmented button {
      min-height: 40px;
      padding: var(--space-sm) var(--space-md);
      font-size: var(--font-size-sm);
    }
  }
</style>

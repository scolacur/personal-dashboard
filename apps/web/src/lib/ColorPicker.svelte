<script lang="ts">
  import { untrack } from 'svelte';
  import { COLOR_PRESETS, normalizeHexColor, type ColorPreset } from '@dashboard/shared';

  /**
   * A reusable colour picker (PD-975, Drug log widget; next reused by the Epic card border colour).
   *
   * Preset swatches plus a "Custom" swatch, together one radiogroup (roving tabindex, arrow keys
   * move and select, per the ARIA radio pattern). Choosing Custom reveals a hex field with a live
   * preview and a native colour input as a helper. `value` is always a canonical `#rrggbb`: an
   * invalid hex in the field is flagged and never written back.
   */
  let {
    value = $bindable(),
    presets = COLOR_PRESETS,
    label = 'Colour',
  }: {
    value: string;
    presets?: readonly ColorPreset[];
    /** Accessible name for the radiogroup. */
    label?: string;
  } = $props();

  const uid = `cp-${Math.random().toString(36).slice(2, 8)}`;

  const presetIndex = $derived(presets.findIndex((p) => p.hex === normalizeHexColor(value)));
  // Custom is "on" when the person picked it, or the value matches no preset.
  let customChosen = $state(false);
  const customActive = $derived(customChosen || presetIndex < 0);
  // Index of the checked radio: presets 0..n-1, Custom = n.
  const checkedIndex = $derived(customActive ? presets.length : presetIndex);

  let hexText = $state('');
  // Keep the field in step with the value whenever the *value* changes (a swatch, the native
  // input, the parent). Only `value` is tracked: re-running on keystrokes would overwrite a
  // half-typed hex with the last valid one.
  $effect(() => {
    const v = normalizeHexColor(value);
    untrack(() => {
      if (v !== null && normalizeHexColor(hexText) !== v) hexText = v;
    });
  });
  const hexValid = $derived(normalizeHexColor(hexText) !== null);

  let groupEl = $state<HTMLDivElement | null>(null);

  function pick(i: number): void {
    if (i < presets.length) {
      customChosen = false;
      value = presets[i].hex;
    } else {
      customChosen = true;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    const n = presets.length + 1;
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    let next: number;
    if (e.key in step) next = (checkedIndex + step[e.key] + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    pick(next);
    groupEl?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  function onHexInput(): void {
    const v = normalizeHexColor(hexText);
    if (v !== null) value = v;
  }

  function onNativeInput(e: Event): void {
    const v = normalizeHexColor((e.currentTarget as HTMLInputElement).value);
    if (v !== null) {
      value = v;
      hexText = v;
    }
  }
</script>

<div class="color-picker">
  <div class="swatches" role="radiogroup" aria-label={label} bind:this={groupEl}>
    {#each presets as p, i (p.hex)}
      <button
        type="button"
        class="swatch"
        role="radio"
        aria-checked={checkedIndex === i}
        aria-label={p.name}
        title={p.name}
        tabindex={checkedIndex === i ? 0 : -1}
        style:--swatch={p.hex}
        onclick={() => pick(i)}
        onkeydown={onKeydown}
      ></button>
    {/each}
    <button
      type="button"
      class="swatch custom"
      role="radio"
      aria-checked={customActive}
      aria-label="Custom colour"
      title="Custom"
      tabindex={customActive ? 0 : -1}
      style:--swatch={customActive ? value : null}
      onclick={() => pick(presets.length)}
      onkeydown={onKeydown}
    >
      {#if !customActive}<span aria-hidden="true">+</span>{/if}
    </button>
  </div>

  {#if customActive}
    <div class="custom-row">
      <span
        class="preview"
        style:background={hexValid ? normalizeHexColor(hexText) : value}
        aria-hidden="true"
      ></span>
      <label class="hex" for="{uid}-hex">
        <span class="visually-hidden">Hex colour</span>
        <input
          id="{uid}-hex"
          type="text"
          inputmode="text"
          autocomplete="off"
          spellcheck="false"
          maxlength="7"
          placeholder="#rrggbb"
          aria-invalid={!hexValid}
          aria-describedby={hexValid ? undefined : `${uid}-err`}
          bind:value={hexText}
          oninput={onHexInput}
        />
      </label>
      <input
        class="native"
        type="color"
        aria-label="Pick a colour"
        value={normalizeHexColor(value) ?? '#000000'}
        oninput={onNativeInput}
      />
    </div>
    {#if !hexValid}
      <p class="error" id="{uid}-err">Enter a hex colour like #2e9e5b.</p>
    {/if}
  {/if}
</div>

<style lang="scss" src="./ColorPicker.scss"></style>

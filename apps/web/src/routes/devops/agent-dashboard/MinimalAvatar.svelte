<script lang="ts">
  // PD-819: the minimalist (vector) avatar styles — a quieter alternative to the 8-bit sprites.
  // Same contract as PixelRobot: tinted by `color`, one accessory per kind, still + grey when idle.
  //   orb    — a breathing disc with a white glyph (eyes / magnifier / visor)
  //   line   — a single-stroke robot face
  //   ripple — a solid kind shape (square / circle / diamond) sending out rings
  import type { ActiveAgentKind } from '@dashboard/shared';
  import type { MinimalStyle } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    style: MinimalStyle;
    color: string;
    size?: number;
    idle?: boolean;
    label?: string;
  }
  let { kind, style, color, size = 80, idle = false, label }: Props = $props();
</script>

<svg
  class="minimal-avatar style-{style} kind-{kind}"
  class:idle
  viewBox="0 0 64 52"
  width={size}
  height={(size * 52) / 64}
  style="--bot: {color}"
  role="img"
  aria-label={label ?? `${kind} agent`}
>
  {#if style === 'orb'}
    <circle class="glow" cx="32" cy="26" r="23" />
    <circle class="disc" cx="32" cy="26" r="17" />
    {#if kind === 'robot'}
      <g class="eyes">
        <circle cx="26" cy="25" r="2.6" class="ink" />
        <circle cx="38" cy="25" r="2.6" class="ink" />
      </g>
    {:else if kind === 'evaluator'}
      <g class="tool">
        <circle cx="30" cy="24" r="6" class="ink-stroke" />
        <line x1="34.5" y1="28.5" x2="39" y2="33" class="ink-stroke" />
      </g>
    {:else}
      <rect x="20" y="17" width="24" height="5" rx="2.5" class="visor" />
      <g class="eyes">
        <circle cx="27" cy="29" r="2.4" class="ink" />
        <circle cx="37" cy="29" r="2.4" class="ink" />
      </g>
    {/if}
  {:else if style === 'line'}
    <g class="bob">
      <line x1="32" y1="14" x2="32" y2="8" class="stroke" />
      <circle cx="32" cy="6" r="2.6" class="antenna" />
      <rect x="19" y="14" width="26" height="23" rx="7" class="stroke" />
      <g class="eyes">
        <circle cx="26.5" cy="25" r="2.4" class="fill" />
        <circle cx="37.5" cy="25" r="2.4" class="fill" />
      </g>
      <line x1="28.5" y1="31.5" x2="35.5" y2="31.5" class="stroke" />
      {#if kind === 'evaluator'}
        <g class="tool">
          <circle cx="52" cy="35" r="5.5" class="stroke" />
          <line x1="48" y1="39" x2="44.5" y2="43" class="stroke" />
        </g>
      {:else if kind === 'auditor'}
        <line x1="16" y1="18.5" x2="48" y2="18.5" class="visor-stroke" />
      {/if}
    </g>
  {:else}
    <circle class="ring" cx="32" cy="26" r="13" />
    <circle class="ring late" cx="32" cy="26" r="13" />
    {#if kind === 'robot'}
      <rect x="22" y="16" width="20" height="20" rx="5" class="core" />
    {:else if kind === 'evaluator'}
      <circle cx="32" cy="26" r="11" class="core" />
    {:else}
      <rect x="24" y="18" width="16" height="16" rx="2" class="core diamond" />
    {/if}
  {/if}
</svg>

<style lang="scss" src="./MinimalAvatar.scss"></style>

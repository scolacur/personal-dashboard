<script lang="ts">
  // PD-819: the single-stroke avatar family. Every variant draws the same kind accessories — the
  // Evaluator's magnifying glass, the Auditor's green visor — placed to fit its head.
  import type { ActiveAgentKind } from '@dashboard/shared';
  import type { LineStyle } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    style: LineStyle;
  }
  let { kind, style }: Props = $props();

  // Where each variant's accessories sit: visor line (y, x1, x2) and magnifier centre.
  const GEOMETRY: Record<LineStyle, { visor: [number, number, number]; lens: [number, number] }> = {
    line: { visor: [18.5, 16, 48], lens: [52, 35] },
    bubble: { visor: [20, 17, 47], lens: [53, 37] },
    tv: { visor: [15, 13, 51], lens: [55, 39] },
    bust: { visor: [11.5, 19, 45], lens: [52, 31] },
  };
  let g = $derived(GEOMETRY[style]);
</script>

<g class="bob">
  {#if style === 'line'}
    <line x1="32" y1="14" x2="32" y2="8" class="stroke" />
    <circle cx="32" cy="6" r="2.6" class="antenna" />
    <rect x="19" y="14" width="26" height="23" rx="7" class="stroke" />
    <g class="eyes">
      <circle cx="26.5" cy="25" r="2.4" class="fill" />
      <circle cx="37.5" cy="25" r="2.4" class="fill" />
    </g>
    <line x1="28.5" y1="31.5" x2="35.5" y2="31.5" class="stroke" />
  {:else if style === 'bubble'}
    <circle cx="32" cy="27" r="13" class="stroke" />
    <line x1="17" y1="24" x2="17" y2="30" class="stroke" />
    <line x1="47" y1="24" x2="47" y2="30" class="stroke" />
    <circle cx="32" cy="10" r="2.6" class="antenna" />
    <g class="eyes">
      <path d="M24.5 27.5 q2.5 -3.5 5 0" class="stroke" />
      <path d="M34.5 27.5 q2.5 -3.5 5 0" class="stroke" />
    </g>
    <path d="M28.5 32.5 q3.5 3 7 0" class="stroke" />
  {:else if style === 'tv'}
    <line x1="28" y1="14" x2="22" y2="6" class="stroke" />
    <line x1="36" y1="14" x2="42" y2="6" class="stroke" />
    <circle cx="22" cy="5" r="2" class="antenna" />
    <circle cx="42" cy="5" r="2" class="antenna late" />
    <rect x="16" y="14" width="32" height="26" rx="4" class="stroke" />
    <rect x="20.5" y="18.5" width="23" height="17" rx="3" class="stroke thin" />
    <line x1="22" y1="20" x2="42" y2="20" class="scanline" />
    <g class="eyes">
      <line x1="27.5" y1="24.5" x2="27.5" y2="29.5" class="stroke" />
      <line x1="36.5" y1="24.5" x2="36.5" y2="29.5" class="stroke" />
    </g>
  {:else}
    <line x1="32" y1="8" x2="32" y2="4" class="stroke" />
    <circle cx="32" cy="2.5" r="2.2" class="antenna" />
    <rect x="22" y="8" width="20" height="17" rx="6" class="stroke" />
    <g class="eyes">
      <circle cx="28" cy="16" r="2" class="fill" />
      <circle cx="36" cy="16" r="2" class="fill" />
    </g>
    <line x1="29.5" y1="21" x2="34.5" y2="21" class="stroke" />
    <path d="M18 50 v-12 q0 -8 8 -8 h12 q8 0 8 8 v12" class="stroke" />
    <line x1="21" y1="40" x2="27" y2="46" class="stroke arm" />
    {#if kind !== 'evaluator'}
      <line x1="43" y1="40" x2="37" y2="46" class="stroke arm late" />
    {/if}
  {/if}

  {#if kind === 'evaluator'}
    <g class="tool">
      <circle cx={g.lens[0]} cy={g.lens[1]} r="5.5" class="stroke" />
      <line x1={g.lens[0] - 4} y1={g.lens[1] + 4} x2={g.lens[0] - 7.5} y2={g.lens[1] + 8} class="stroke" />
    </g>
  {:else if kind === 'auditor'}
    <line x1={g.visor[1]} y1={g.visor[0]} x2={g.visor[2]} y2={g.visor[0]} class="visor-stroke" />
  {/if}
</g>

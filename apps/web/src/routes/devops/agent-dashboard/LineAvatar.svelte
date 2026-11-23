<script lang="ts">
  // PD-819: the single-stroke robot faces behind Robot mode — `line` (Robots, Auditors) and `tv`
  // (Evaluators). Each draws its kind's accessory: the Evaluator's magnifying glass, the Auditor's
  // green visor, placed to fit the head.
  import type { ActiveAgentKind } from '@dashboard/shared';

  interface Props {
    kind: ActiveAgentKind;
    face: 'line' | 'tv';
  }
  let { kind, face }: Props = $props();

  // Visor line (y, x1, x2) and magnifier centre for each face.
  const GEOMETRY = {
    line: { visor: [18.5, 16, 48], lens: [52, 35] },
    tv: { visor: [15, 13, 51], lens: [55, 39] },
  } as const;
  let g = $derived(GEOMETRY[face]);
</script>

<g class="bob">
  {#if face === 'line'}
    <line x1="32" y1="14" x2="32" y2="8" class="stroke" />
    <circle cx="32" cy="6" r="2.6" class="antenna" />
    <rect x="19" y="14" width="26" height="23" rx="7" class="stroke" />
    <g class="eyes">
      <circle cx="26.5" cy="25" r="2.4" class="fill" />
      <circle cx="37.5" cy="25" r="2.4" class="fill" />
    </g>
    <line x1="28.5" y1="31.5" x2="35.5" y2="31.5" class="stroke" />
  {:else}
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

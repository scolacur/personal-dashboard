<script lang="ts">
  // PD-819: one 8-bit robot (PD-682), drawn as a grid of 1×1 rects so it stays pixel-crisp at any
  // size. The body takes `color` (the run's project colour); every other colour is a class below.
  // Parts (eyes / antenna / tool) are grouped so each can animate on its own.
  import type { ActiveAgentKind } from '@dashboard/shared';
  import { SPRITE_H, SPRITE_W, spriteFor, type PixelPart } from './pixel-robots';

  interface Props {
    kind: ActiveAgentKind | 'sleeping';
    color: string;
    /** Rendered width in px; height follows the sprite's aspect. */
    size?: number;
    label?: string;
  }
  let { kind, color, size = 80, label }: Props = $props();

  const NAMES: Record<string, string> = {
    D: 'outline', B: 'body', S: 'screen', E: 'eye', M: 'mouth', A: 'antenna', L: 'chest',
    K: 'rim', G: 'glass', W: 'glint', H: 'handle', V: 'visor', v: 'brim', Z: 'zzz',
  };
  const PARTS: PixelPart[] = ['body', 'tool', 'eyes', 'antenna'];

  let byPart = $derived.by(() => {
    const pixels = spriteFor(kind);
    return PARTS.map((part) => ({ part, pixels: pixels.filter((p) => p.part === part) })).filter(
      (g) => g.pixels.length > 0,
    );
  });
</script>

<svg
  class="pixel-robot kind-{kind}"
  viewBox="0 0 {SPRITE_W} {SPRITE_H}"
  width={size}
  height={(size * SPRITE_H) / SPRITE_W}
  shape-rendering="crispEdges"
  style="--bot: {color}"
  role="img"
  aria-label={label ?? `${kind} robot`}
>
  <g class="bob">
    {#each byPart as g (g.part)}
      <g class="part part-{g.part}">
        {#each g.pixels as p (`${p.x},${p.y}`)}
          <rect x={p.x} y={p.y} width="1" height="1" class="c-{NAMES[p.c]}" />
        {/each}
      </g>
    {/each}
  </g>
</svg>

<style lang="scss" src="./PixelRobot.scss"></style>

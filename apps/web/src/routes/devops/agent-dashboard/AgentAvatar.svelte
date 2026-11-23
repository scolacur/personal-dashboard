<script lang="ts">
  // PD-819: picks the renderer for the chosen avatar style — an 8-bit sprite set or a minimalist
  // vector style. Everything above this component is style-agnostic.
  import type { ActiveAgentKind } from '@dashboard/shared';
  import MinimalAvatar from './MinimalAvatar.svelte';
  import PixelRobot from './PixelRobot.svelte';
  import { isPixelStyle, type AvatarStyle } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    style: AvatarStyle;
    color: string;
    size?: number;
    idle?: boolean;
    label?: string;
  }
  let { kind, style, color, size, idle, label }: Props = $props();
</script>

{#if isPixelStyle(style)}
  <PixelRobot {kind} set={style} {color} {size} {idle} {label} />
{:else}
  <MinimalAvatar {kind} {style} {color} {size} {idle} {label} />
{/if}

<script lang="ts">
  // PD-819: an agent's avatar, tinted by `color` (its project), still + grey when `idle`. Two
  // families under comparison: single-stroke faces (LineAvatar) and signal shapes (RippleAvatar).
  import type { ActiveAgentKind } from '@dashboard/shared';
  import LineAvatar from './LineAvatar.svelte';
  import RippleAvatar from './RippleAvatar.svelte';
  import { isLineStyle, type AvatarStyle } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    style: AvatarStyle;
    color: string;
    size?: number;
    idle?: boolean;
    label?: string;
  }
  let { kind, style, color, size = 64, idle = false, label }: Props = $props();
</script>

<svg
  class="agent-avatar style-{style} kind-{kind}"
  class:idle
  viewBox="0 0 64 52"
  width={size}
  height={(size * 52) / 64}
  style="--bot: {color}"
  role="img"
  aria-label={label ?? `${kind} agent`}
>
  {#if isLineStyle(style)}
    <LineAvatar {kind} {style} />
  {:else}
    <RippleAvatar {kind} {style} />
  {/if}
</svg>

<style lang="scss" src="./AgentAvatar.scss"></style>

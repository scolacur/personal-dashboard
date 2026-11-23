<script lang="ts">
  // PD-819: an agent's avatar in the chosen mode (see `avatarStyleFor`), tinted by `color` (its
  // project), still + grey when `idle`.
  import type { ActiveAgentKind } from '@dashboard/shared';
  import LineAvatar from './LineAvatar.svelte';
  import OrbitAvatar from './OrbitAvatar.svelte';
  import { avatarStyleFor, type AvatarMode } from './agent-fleet';

  interface Props {
    kind: ActiveAgentKind;
    mode: AvatarMode;
    color: string;
    size?: number;
    idle?: boolean;
    label?: string;
  }
  let { kind, mode, color, size = 64, idle = false, label }: Props = $props();

  let style = $derived(avatarStyleFor(mode, kind));
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
  {#if style === 'orbit'}
    <OrbitAvatar {kind} />
  {:else}
    <LineAvatar {kind} face={style} />
  {/if}
</svg>

<style lang="scss" src="./AgentAvatar.scss"></style>

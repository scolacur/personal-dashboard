<script lang="ts">
  // PD-819: one live agent — its 8-bit robot (PD-682) and a speech-box saying what it's doing:
  // ticket, turns, tokens, model. Tinted by the run's project colour. Values that change between
  // polls are re-keyed so they fade in (PD-818's "fade-in on change").
  import type { ActiveAgent } from '@dashboard/shared';
  import AgentAvatar from './AgentAvatar.svelte';
  import {
    KIND_LABELS,
    botColor,
    formatElapsed,
    formatModel,
    formatTokens,
    formatTurns,
    nearTurnCap,
    type AvatarStyle,
  } from './agent-fleet';

  interface Props {
    agent: ActiveAgent;
    avatar: AvatarStyle;
    now: number;
  }
  let { agent, avatar, now }: Props = $props();

  let color = $derived(botColor(agent));
  let label = $derived(KIND_LABELS[agent.kind]);
  let turns = $derived(formatTurns(agent.turns, agent.maxTurns));
  let tokens = $derived(formatTokens(agent.tokens));
  let model = $derived(formatModel(agent.model));
  let nearCap = $derived(nearTurnCap(agent.turns, agent.maxTurns));
</script>

<article class="agent-tile kind-{agent.kind}" style="--tint: {color}">
  <div class="bot-col">
    <AgentAvatar kind={agent.kind} style={avatar} {color} size={60} label="{label.one} robot" />
  </div>

  <div class="speech" role="group" aria-label="{label.one} status">
    <div class="speech-head">
      {#if agent.ticket}
        <a class="ticket-id" href="/devops/tickets/{agent.ticket.displayId}">{agent.ticket.displayId ?? `#${agent.ticket.id}`}</a>
      {:else}
        <span class="ticket-id none">{label.blurb}</span>
      {/if}
      {#if agent.project}
        <span class="project">{agent.project.name}</span>
      {/if}
      <span class="elapsed" title="Running for">{formatElapsed(agent.startedAt, now)}</span>
    </div>

    {#if agent.ticket}
      <p class="title" title={agent.ticket.title}>{agent.ticket.title}</p>
    {/if}
    {#if agent.detail}
      <p class="detail">{agent.detail}</p>
    {/if}

    <dl class="stats">
      <div class="stat" class:warn={nearCap}>
        <dt>turn</dt>
        {#key turns}<dd class="fresh">{turns}</dd>{/key}
      </div>
      <div class="stat">
        <dt>tokens</dt>
        {#key tokens}<dd class="fresh">{tokens}</dd>{/key}
      </div>
      <div class="stat">
        <dt>model</dt>
        <dd title={agent.model ?? undefined}>{model}</dd>
      </div>
    </dl>
  </div>
</article>

<style lang="scss" src="./AgentTile.scss"></style>

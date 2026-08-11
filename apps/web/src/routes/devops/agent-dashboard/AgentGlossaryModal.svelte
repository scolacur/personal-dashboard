<script lang="ts">
  // The Agent Glossary (PD-306): what each autonomous agent is responsible for, and the exact
  // prompts it receives. Every prompt below is RENDERED from the same builders the worker calls
  // (packages/shared/src/agent-prompts.ts) with placeholder inputs — nothing here is transcribed,
  // so it cannot drift from what the agents actually get. PD-500 tracks editing them from here.
  import Modal from '$lib/Modal.svelte';
  import { AGENT_GLOSSARY_VIEWS, PROMPT_PLACEHOLDERS, type AgentType } from './agent-glossary';

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  let activeTab = $state<AgentType>('robot');
  let copied = $state<string | null>(null);

  const active = $derived(AGENT_GLOSSARY_VIEWS.find((v) => v.profile.id === activeTab) ?? AGENT_GLOSSARY_VIEWS[0]);

  async function copy(title: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = title;
      setTimeout(() => (copied = null), 1500);
    } catch {
      // Clipboard is permission-gated and unavailable over plain http on some hosts. The prompt is
      // still selectable by hand, so a failure here is not worth interrupting anyone over.
    }
  }
</script>

<Modal {open} title="Agent Glossary" {onClose}>
  <div class="glossary-tabs">
    {#each AGENT_GLOSSARY_VIEWS as view (view.profile.id)}
      <button
        class="glossary-tab"
        class:active={activeTab === view.profile.id}
        type="button"
        onclick={() => (activeTab = view.profile.id)}>{view.profile.label}</button
      >
    {/each}
  </div>

  <div class="agent-view">
    <p class="agent-tagline">{active.profile.tagline}</p>
    <p class="agent-access" class:agent-access-write={active.profile.access !== 'read-only'}>
      {active.profile.access}
    </p>

    <h4 class="agent-heading">Responsibilities</h4>
    <ul class="agent-responsibilities">
      {#each active.profile.responsibilities as item, i (i)}
        <li>{item}</li>
      {/each}
    </ul>
    <p class="agent-decisions">
      Reasoning: {active.profile.decisions.join(', ')} — see <code>DECISIONS.md</code>.
    </p>

    <h4 class="agent-heading">Prompts</h4>
    <p class="agent-prompt-intro">
      Rendered from the same code the worker runs, with placeholders for anything that varies per
      run. This is what the agent receives, not a description of it.
    </p>

    {#each active.sections as section (section.title)}
      <section class="prompt-section">
        <div class="prompt-head">
          <h5 class="prompt-title">{section.title}</h5>
          <button class="prompt-copy" type="button" onclick={() => copy(section.title, section.text)}>
            {copied === section.title ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p class="prompt-note">{section.note}</p>
        <pre class="prompt-text">{section.text}</pre>
      </section>
    {/each}

    <h4 class="agent-heading">Placeholders</h4>
    <ul class="placeholder-list">
      {#each PROMPT_PLACEHOLDERS as p (p.token)}
        <li><code>{p.token}</code><span>{p.meaning}</span></li>
      {/each}
    </ul>
  </div>
</Modal>

<style lang="scss" src="./AgentGlossaryModal.scss"></style>

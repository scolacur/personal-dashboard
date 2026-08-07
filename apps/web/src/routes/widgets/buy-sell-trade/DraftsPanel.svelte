<script lang="ts">
  import {
    BST_DRAFT_FORMATS,
    BST_DRAFT_FORMAT_LABELS,
    BST_TEMPLATE_TOKENS,
    pickupList,
    type BstDraft,
    type BstDraftFormat,
    type BstListing,
  } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import {
    fetchDrafts,
    generateDrafts,
    saveTemplate,
  } from '$lib/buy-sell-trade/api';

  // Drafted posts (PD-439's on-demand half, built in PD-475).
  //
  // **Why there is a button at all.** The monthly cron is registered as of PD-439, and the
  // button is still not redundant: waiting for the 15th to post something you decided to sell
  // today is a silly constraint for a tool you own, and it is how you see a template edit take
  // effect without waiting two weeks. Generating is deterministic template expansion, so doing
  // it on demand costs nothing — and since PD-440 it records a run row exactly like the cron.
  let {
    listings,
    templates,
    onTemplatesSaved,
  }: {
    listings: BstListing[];
    templates: Record<BstDraftFormat, string>;
    onTemplatesSaved: (templates: Record<BstDraftFormat, string>) => void;
  } = $props();

  let drafts = $state<BstDraft[]>([]);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state('');
  let copied = $state<number | null>(null);

  /** Which historical batch is on screen; null means the newest. */
  let viewing = $state<number | null>(null);

  /** Newest-first list of generation timestamps — each is one batch of three formats. */
  const batches = $derived([...new Set(drafts.map((d) => d.generatedAt))].sort((a, b) => b - a));
  const showing = $derived(viewing ?? batches[0] ?? null);
  const current = $derived(drafts.filter((d) => d.generatedAt === showing));
  const pickups = $derived(pickupList(listings));

  async function load(): Promise<void> {
    error = '';
    try {
      drafts = await fetchDrafts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load drafts';
    } finally {
      loaded = true;
    }
  }

  async function generate(): Promise<void> {
    busy = true;
    error = '';
    try {
      await generateDrafts();
      drafts = await fetchDrafts();
      // Jump to what was just made, whatever was being viewed before.
      viewing = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to generate';
    } finally {
      busy = false;
    }
  }

  async function copy(draft: BstDraft): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.content);
      copied = draft.id;
      setTimeout(() => {
        if (copied === draft.id) copied = null;
      }, 2000);
    } catch {
      // Clipboard is permission-gated and can simply refuse. The text is on screen and
      // selectable, so say so rather than pretending it worked.
      error = 'Could not copy — select the text and copy it by hand.';
    }
  }

  function when(at: number): string {
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  /* ── Template editing ─────────────────────────── */

  let editing = $state<BstDraftFormat | null>(null);
  let templateDraft = $state('');
  let savingTemplate = $state(false);

  function edit(format: BstDraftFormat): void {
    editing = format;
    templateDraft = templates[format];
  }

  async function persistTemplate(): Promise<void> {
    if (!editing) return;
    savingTemplate = true;
    error = '';
    try {
      const saved = await saveTemplate(editing, templateDraft);
      onTemplatesSaved(saved.templates);
      editing = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save template';
    } finally {
      savingTemplate = false;
    }
  }
</script>

<Collapsible title="Drafted posts" storeKey="bst-drafts" open={false}>
  <div class="drafts">
    {#if !loaded}
      <!-- Loaded on first open rather than with the page: three rendered posts are a lot of text
           to fetch for a section that is usually closed. -->
      <Button variant="ghost" onclick={load}>Load drafts</Button>
    {:else}
      {#if error}<p class="drafts-error" role="alert">{error}</p>{/if}

      <div class="drafts-bar">
        <Button variant="primary" onclick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate now'}
        </Button>

        {#if batches.length > 1}
          <label class="drafts-history">
            <span>Showing</span>
            <select
              value={String(showing)}
              onchange={(e) => (viewing = Number(e.currentTarget.value))}
            >
              {#each batches as b, i (b)}
                <option value={String(b)}>{when(b)}{i === 0 ? ' (latest)' : ''}</option>
              {/each}
            </select>
          </label>
        {:else if showing}
          <span class="drafts-when">Generated {when(showing)}</span>
        {/if}
      </div>

      {#if current.length === 0}
        <p class="drafts-empty">
          No drafts yet. “Generate now” renders your current list into all three formats.
        </p>
      {:else}
        {#each BST_DRAFT_FORMATS as format (format)}
          {@const draft = current.find((d) => d.format === format)}
          {#if draft}
            <article class="draft">
              <header class="draft-head">
                <h3 class="draft-title">{BST_DRAFT_FORMAT_LABELS[format]}</h3>
                <div class="draft-actions">
                  <Button variant="ghost" onclick={() => copy(draft)}>
                    {copied === draft.id ? 'Copied' : 'Copy'}
                  </Button>
                  <Button variant="ghost" onclick={() => edit(format)}>Edit template</Button>
                </div>
              </header>
              <pre class="draft-body">{draft.content}</pre>
            </article>
          {/if}
        {/each}

        {#if pickups.length > 0}
          <!-- Private, and deliberately outside the draft text: the post says what is for sale,
               this says where to go and find it. -->
          <Collapsible title="Where they are" count={pickups.length} open={false} storeKey="bst-pickup">
            <ul class="pickup-list">
              {#each pickups as p (p.item + p.location)}
                <li><span class="pickup-item">{p.item}</span><span class="pickup-where">{p.location}</span></li>
              {/each}
            </ul>
          </Collapsible>
        {/if}
      {/if}
    {/if}
  </div>
</Collapsible>

{#if editing}
  <div class="template-editor">
    <h4 class="template-title">{BST_DRAFT_FORMAT_LABELS[editing]} template</h4>
    <p class="template-help">
      Tokens: {BST_TEMPLATE_TOKENS.join(' · ')}. Changes apply to the next draft you generate —
      no redeploy. Clear it back to the default by deleting everything and saving.
    </p>
    <textarea
      class="template-input"
      rows="14"
      aria-label="Post template"
      bind:value={templateDraft}
      disabled={savingTemplate}
    ></textarea>
    <div class="template-actions">
      <Button variant="ghost" onclick={() => (editing = null)} disabled={savingTemplate}>
        Cancel
      </Button>
      <Button variant="primary" onclick={persistTemplate} disabled={savingTemplate}>
        {savingTemplate ? 'Saving…' : 'Save template'}
      </Button>
    </div>
  </div>
{/if}

<style lang="scss" src="./DraftsPanel.scss"></style>

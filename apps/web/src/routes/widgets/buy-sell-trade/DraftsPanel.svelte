<script lang="ts">
  import {
    BST_DRAFT_FORMATS,
    BST_DRAFT_FORMAT_LABELS,
    BST_TEMPLATE_TOKENS,
    type BstDraft,
    type BstDraftFormat,
  } from '@dashboard/shared';
  import { onMount } from 'svelte';
  import Button from '$lib/Button.svelte';
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
    templates,
    onTemplatesSaved,
  }: {
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

  onMount(load);

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

  /** Per-draft copy failure, shown AT the button. The panel-level `error` sits above three long
   *  draft bodies, so a failure reported there is off-screen from the button that caused it —
   *  which is what made this look like a dead button rather than a failing one. */
  let copyFailed = $state<number | null>(null);

  /**
   * Copy without `navigator.clipboard`, which **does not exist here**.
   *
   * The dashboard is served over plain HTTP on the LAN (`http://192.168.68.50:8088`). The async
   * Clipboard API is restricted to secure contexts, so `navigator.clipboard` is `undefined` on
   * that origin and the old code threw on every click. It is not a permissions prompt anyone can
   * grant — the API is simply absent, and it will stay absent until the box is served over HTTPS.
   *
   * `document.execCommand('copy')` is deprecated but has no secure-context requirement and is
   * the only thing that works on this origin. Returns false if even that is refused.
   */
  function legacyCopy(text: string): boolean {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but focusable — `display: none` or `hidden` would make the selection fail.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }

  async function copy(draft: BstDraft): Promise<void> {
    copyFailed = null;
    let ok = false;
    try {
      // Preferred when it exists (HTTPS, or localhost during dev); absent on the LAN origin.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(draft.content);
        ok = true;
      }
    } catch {
      ok = false; // permission-gated even where it exists — fall through to the legacy path
    }

    if (!ok) ok = legacyCopy(draft.content);

    if (ok) {
      copied = draft.id;
      setTimeout(() => {
        if (copied === draft.id) copied = null;
      }, 2000);
    } else {
      // The text is on screen and selectable, so say so rather than pretending it worked.
      copyFailed = draft.id;
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
    if (editing === format) {
      editing = null;
      return;
    }
    editing = format;
    // `?? ''` because a format the settings row has never carried would otherwise bind
    // `undefined` into the textarea, which renders blank and saves as a cleared template.
    templateDraft = templates[format] ?? '';
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

<div class="drafts">
    {#if !loaded}
      <p class="drafts-empty">Loading drafts…</p>
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
        <!-- Three across on a desktop-width modal, one per row on a phone. Each format keeps its
             own Copy and Edit template controls inside its own box. -->
        <div class="drafts-grid">
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
                  <Button variant="ghost" onclick={() => edit(format)}>
                    {editing === format ? 'Close template' : 'Edit template'}
                  </Button>
                </div>
              </header>

              {#if copyFailed === draft.id}
                <p class="draft-copy-error" role="alert">
                  Couldn’t copy automatically — select the text below and copy it by hand.
                </p>
              {/if}

              <!-- The editor lives INSIDE the draft it edits. It used to render after the whole
                   section, below three long draft bodies, so the button scrolled nothing into
                   view and read as dead. -->
              {#if editing === format}
                <div class="template-editor">
                  <h4 class="template-title">{BST_DRAFT_FORMAT_LABELS[format]} template</h4>
                  <p class="template-help">
                    Tokens: {BST_TEMPLATE_TOKENS.join(' · ')}. Changes apply to the next draft you
                    generate — no redeploy. Clear it back to the default by deleting everything
                    and saving.
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

              <pre class="draft-body">{draft.content}</pre>
            </article>
          {/if}
        {/each}
        </div>
      {/if}
    {/if}
</div>

<style lang="scss" src="./DraftsPanel.scss"></style>

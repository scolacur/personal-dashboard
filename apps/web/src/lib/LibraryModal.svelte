<script lang="ts">
  import Modal from './Modal.svelte';
  import { widgets as registry, defaultSpan } from './widgets';
  import { pageWidgets } from './page-widgets.svelte';

  /**
   * The widget library's picker surface (PD-334, D-071).
   *
   * A **toggle list**, not an add-only list: a checked row means the widget is on this page,
   * so one surface both answers "what's on this page?" and edits it in either direction. That
   * matters beyond tidiness — it is the only membership control available below 768px, where
   * Arrange (and so the per-card remove) is unavailable.
   *
   * Names only. The Library page is the surface that renders widgets live; a picker wants to be
   * scannable, and mounting seventeen live widgets inside a modal would be neither.
   */
  let {
    open,
    pageId,
    pageTitle,
    onClose,
  }: { open: boolean; pageId: string; pageTitle: string; onClose: () => void } = $props();

  const onPage = $derived(new Set(pageWidgets.forPage(pageId).map((w) => w.widgetId)));

  function toggle(widgetId: string) {
    const widget = registry.find((w) => w.id === widgetId);
    if (!widget) return;
    if (onPage.has(widgetId)) void pageWidgets.remove(pageId, widgetId);
    else void pageWidgets.add(pageId, widgetId, defaultSpan(widget));
  }
</script>

<Modal {open} title={`Add to ${pageTitle}`} {onClose}>
  <ul class="library-list">
    {#each registry as widget (widget.id)}
      {@const checked = onPage.has(widget.id)}
      <li>
        <!-- A real checkbox rather than a styled button: this is a set of independent on/off
             choices, which is exactly what a checkbox announces to a screen reader. -->
        <label class="library-row" class:checked>
          <input
            type="checkbox"
            {checked}
            onchange={() => toggle(widget.id)}
          />
          <span class="library-title">{widget.title}</span>
          <span class="library-description">{widget.description}</span>
        </label>
      </li>
    {/each}
  </ul>
</Modal>

<style lang="scss" src="./LibraryModal.scss"></style>

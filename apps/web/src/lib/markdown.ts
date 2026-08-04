import { marked } from 'marked';

/**
 * Svelte action that renders markdown into a node's `innerHTML`, avoiding `{@html}`.
 *
 * Extracted from TicketThread when the ticket-detail Description gained a rendered view
 * (PD-409) so both surfaces parse markdown the same way.
 *
 * Note the rendered HTML is **not** sanitized — `marked` passes raw HTML through. That
 * matches the pre-existing behaviour of the Refine thread and is tolerable only because the
 * board is LAN-only, single-user, and its content is authored by Steve and by agents. Anything
 * that widens that audience (auth, remote access, third-party ticket sources) needs a
 * sanitizer first.
 *
 * Styling: the injected children aren't compiled by Svelte, so a consumer's rules for them
 * must use `:global(...)` under a scoped parent class.
 */
export function applyMarkdown(node: HTMLElement, text: string) {
  node.innerHTML = marked.parse(text) as string;
  return {
    update(newText: string) {
      node.innerHTML = marked.parse(newText) as string;
    },
  };
}

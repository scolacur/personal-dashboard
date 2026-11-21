/**
 * Svelte action: move the node to <body> for as long as it is mounted.
 *
 * For modals whose trigger lives somewhere that would trap them: an ancestor with `perspective` or
 * `transform` becomes the containing block for `position: fixed` (a widget card), and one that is
 * `position: sticky` / `fixed` with a z-index starts a stacking context the modal cannot climb out
 * of (the ticket page's sticky Details column, under the FloatDock).
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}

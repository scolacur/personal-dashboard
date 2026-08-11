/**
 * App-wide auto-dismissing toast (PD-334).
 *
 * Promoted from the Kanban board's page-local copy once a second caller appeared — the shell's
 * page-membership writes, which need to report a failed save (D-071). PROJECT.md §5 puts
 * cross-route components in `lib/`.
 *
 * A module rather than component state so that non-component code can raise one: the membership
 * store is a plain `.svelte.ts` module and has no component to hang a local `toast` off.
 * `lib/Toast.svelte` renders whatever is current and is mounted once in the root layout.
 */

const DEFAULT_MS = 3000;

export type ToastTone = 'info' | 'error';

let _message = $state<string | null>(null);
let _tone = $state<ToastTone>('info');
let timer: ReturnType<typeof setTimeout> | null = null;

export const toast = {
  get message() {
    return _message;
  },
  get tone() {
    return _tone;
  },
  /** Show a message, replacing any current one and restarting the dismiss timer. */
  show(message: string, tone: ToastTone = 'info', ms: number = DEFAULT_MS) {
    _message = message;
    _tone = tone;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      _message = null;
      timer = null;
    }, ms);
  },
  dismiss() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    _message = null;
  },
};

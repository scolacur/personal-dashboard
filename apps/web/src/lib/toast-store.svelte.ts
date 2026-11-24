/**
 * App-wide auto-dismissing toast (PD-334).
 *
 * Promoted from the Kanban board's page-local copy once a second caller appeared — the shell's
 * page-membership writes, which need to report a failed save (D-073). PROJECT.md §5 puts
 * cross-route components in `lib/`.
 *
 * A module rather than component state so that non-component code can raise one: the membership
 * store is a plain `.svelte.ts` module and has no component to hang a local `toast` off.
 * `lib/Toast.svelte` renders whatever is current and is mounted once in the root layout.
 */

const DEFAULT_MS = 3000;

export type ToastTone = 'info' | 'error';

/**
 * An optional button on the toast, e.g. "Undo" (PD-975, Drug log widget). Clicking it runs
 * `onClick` and dismisses the toast. Callers that pass none get the plain, non-interactive toast.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

let _message = $state<string | null>(null);
let _tone = $state<ToastTone>('info');
let _action = $state<ToastAction | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export const toast = {
  get message() {
    return _message;
  },
  get tone() {
    return _tone;
  },
  get action() {
    return _action;
  },
  /**
   * Show a message, replacing any current one (and its action) and restarting the dismiss timer.
   * `action` adds a button to the toast; it is dropped with the toast when it dismisses.
   */
  show(message: string, tone: ToastTone = 'info', ms: number = DEFAULT_MS, action: ToastAction | null = null) {
    _message = message;
    _tone = tone;
    _action = action;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      _message = null;
      _action = null;
      timer = null;
    }, ms);
  },
  /** Run the current action (if any) and dismiss. */
  act() {
    const action = _action;
    toast.dismiss();
    action?.onClick();
  },
  dismiss() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    _message = null;
    _action = null;
  },
};

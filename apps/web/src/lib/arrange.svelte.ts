let _active = $state(false);

export const arrangeMode = {
  get active() {
    return _active;
  },
  enter() {
    _active = true;
  },
  exit() {
    _active = false;
  },
  toggle() {
    _active = !_active;
  },
};

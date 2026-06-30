import type { BackendWidget } from '../../types';

export const widget: BackendWidget = {
  name: 'pomodoro',
  registerRoutes(_app) {
    // Timer runs entirely client-side; no backend routes needed
  },
};

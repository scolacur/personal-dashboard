export interface WidgetMeta {
  id: string;
  title: string;
  description: string;
  route: string;
}

export const widgets: WidgetMeta[] = [
  {
    id: 'hello',
    title: 'Hello Widget',
    description: 'Stub widget proving the dashboard convention.',
    route: '/widgets/hello',
  },
  {
    id: 'pomodoro',
    title: 'Pomodoro Timer',
    description: 'Configurable focus timer with work, short break, and long break phases.',
    route: '/widgets/pomodoro',
  },
];

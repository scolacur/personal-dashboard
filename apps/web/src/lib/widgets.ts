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
    description: 'Focus timer with work/break cycles.',
    route: '/widgets/pomodoro',
  },
];

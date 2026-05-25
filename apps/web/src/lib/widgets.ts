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
];

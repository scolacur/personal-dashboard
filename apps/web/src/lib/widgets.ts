import type { Component } from 'svelte';
import AcuteStrategiesGenerator from './AcuteStrategiesGenerator.svelte';
import MusicTracker from './MusicTracker.svelte';

export interface WidgetEmbed {
  // Typed loosely: each widget's embedded component accepts `variant` and `view` props
  // by convention; threading per-widget prop types through the generic registry would
  // require heavy generics with no practical benefit at this scale.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
  /** Grid span in integer multiples of the base card cell. */
  span: { cols: number; rows: number };
}

export interface WidgetMeta {
  id: string;
  title: string;
  description: string;
  route: string;
  /** Page ids (see pages.ts) this widget is surfaced on. */
  pages?: string[];
  /** When present, the card renders a live embedded component instead of a link stub. */
  embed?: WidgetEmbed;
}

// One entry per folder in the repo-root `widgets/` spec directory. Each widget
// owns a route at /widgets/<id>. The home grid renders all of these; each page
// renders the subset tagged with its id.
export const widgets: WidgetMeta[] = [
  {
    id: 'morning-routine',
    title: 'Morning Routine',
    description: 'A fresh morning checklist that resets each day.',
    route: '/widgets/morning-routine',
    pages: ['productivity'],
  },
  {
    id: 'reminders',
    title: 'Reminders',
    description: 'One-off and recurring reminders.',
    route: '/widgets/reminders',
    pages: ['productivity'],
  },
  {
    id: 'habit-log',
    title: 'Habit Log',
    description: 'Track daily habits.',
    route: '/widgets/habit-log',
    pages: ['productivity', 'health-fitness'],
  },
  {
    id: 'pomodoro',
    title: 'Pomodoro Timer',
    description: 'Configurable focus timer with work, short break, and long break phases.',
    route: '/widgets/pomodoro',
    pages: ['productivity'],
  },
  {
    id: 'diary',
    title: 'Diary',
    description: 'Daily journal entries.',
    route: '/widgets/diary',
    pages: ['productivity'],
  },
  {
    id: 'vision-board',
    title: 'Vision Board',
    description: 'Visual board of goals and inspiration.',
    route: '/widgets/vision-board',
    pages: ['productivity'],
  },
  {
    id: 'workout-log',
    title: 'Workout Log',
    description: 'Log workouts and track progress.',
    route: '/widgets/workout-log',
    pages: ['health-fitness'],
  },
  {
    id: 'music-picker',
    title: 'Music Picker',
    description: 'Pick what to listen to right now.',
    route: '/widgets/music-picker',
    pages: ['music-discovery'],
  },
  {
    id: 'music-tracker',
    title: 'Music Tracker',
    description: 'Detect new playlist additions and check whether they are in your DJ library.',
    route: '/widgets/music-tracker',
    pages: ['music-discovery'],
    embed: {
      component: MusicTracker,
      span: { cols: 2, rows: 3 },
    },
  },
  {
    id: 'concert-discovery',
    title: 'Concert Discovery',
    description: 'Upcoming concerts worth knowing about.',
    route: '/widgets/concert-discovery',
    pages: ['music-discovery', 'event-tracker'],
  },
  {
    id: 'acute-strategies-generator',
    title: 'Acute Strategies Generator',
    description: 'Random musical ideas and techniques from a list you maintain.',
    route: '/widgets/acute-strategies-generator',
    pages: ['music-production'],
    embed: {
      component: AcuteStrategiesGenerator,
      span: { cols: 2, rows: 2 },
    },
  },
  {
    id: 'festival-follower',
    title: 'Festival Follower',
    description: 'Track festival lineups and dates.',
    route: '/widgets/festival-follower',
    pages: ['event-tracker'],
  },
  {
    id: 'concert-diary',
    title: 'Concert Diary',
    description: "Log of shows you've attended, with photos and notes.",
    route: '/widgets/concert-diary',
    pages: ['event-tracker'],
  },
  {
    id: 'chat',
    title: 'Chat',
    description: 'Quick-access LLM assistant embedded in the dashboard.',
    route: '/widgets/chat',
  },
];

/** Widgets surfaced on a given page. */
export function widgetsForPage(pageId: string): WidgetMeta[] {
  return widgets.filter((w) => w.pages?.includes(pageId));
}

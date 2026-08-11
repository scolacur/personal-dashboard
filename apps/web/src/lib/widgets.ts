import type { Component } from 'svelte';
import AcuteStrategiesGenerator from './AcuteStrategiesGenerator.svelte';
import BuySellTrade from './BuySellTrade.svelte';
import MusicTracker from './MusicTracker.svelte';
import DevOpsAgentWidget from '../routes/devops/AgentWidget.svelte';
import DevOpsJobsWidget from '../routes/devops/JobsWidget.svelte';
import DevOpsTaskTrackerWidget from '../routes/devops/TaskTrackerWidget.svelte';

export interface WidgetEmbed {
  // Typed loosely: each widget's embedded component accepts `variant` and `view` props
  // by convention; threading per-widget prop types through the generic registry would
  // require heavy generics with no practical benefit at this scale.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
  /** Grid span in integer multiples of the base card cell. */
  span: { cols: number; rows: number };
  /** Whether the card offers the ↺ flip control, which swaps the embed's `view` prop
   *  between 'generator' and 'manage'. Only meaningful for embeds that read `view` —
   *  a summary widget with a single face leaves this unset so no dead button renders. */
  flippable?: boolean;
}

export interface WidgetMeta {
  id: string;
  title: string;
  description: string;
  route: string;
  /** When present, the card renders a live embedded component instead of a link stub. */
  embed?: WidgetEmbed;
}

// One entry per folder in the repo-root `widgets/` spec directory, plus the Dev Ops summaries.
// Each widget owns a route at /widgets/<id>.
//
// **Registration says nothing about where a widget appears** (D-071). It puts the widget in the
// widget library; placement onto pages is user state, stored server-side and read through
// `page-widgets.svelte.ts`. There is deliberately no `pages` field and no `system` flag here —
// the registry answers "what exists", never "what goes where".
export const widgets: WidgetMeta[] = [
  {
    id: 'morning-routine',
    title: 'Morning Routine',
    description: 'A fresh morning checklist that resets each day.',
    route: '/widgets/morning-routine',
  },
  {
    id: 'reminders',
    title: 'Reminders',
    description: 'One-off and recurring reminders.',
    route: '/widgets/reminders',
  },
  {
    id: 'habit-log',
    title: 'Habit Log',
    description: 'Track daily habits.',
    route: '/widgets/habit-log',
  },
  {
    id: 'pomodoro',
    title: 'Pomodoro Timer',
    description: 'Configurable focus timer with work, short break, and long break phases.',
    route: '/widgets/pomodoro',
  },
  {
    id: 'diary',
    title: 'Diary',
    description: 'Daily journal entries.',
    route: '/widgets/diary',
  },
  {
    id: 'vision-board',
    title: 'Vision Board',
    description: 'Visual board of goals and inspiration.',
    route: '/widgets/vision-board',
  },
  {
    id: 'workout-log',
    title: 'Workout Log',
    description: 'Log workouts and track progress.',
    route: '/widgets/workout-log',
  },
  {
    id: 'music-picker',
    title: 'Music Picker',
    description: 'Pick what to listen to right now.',
    route: '/widgets/music-picker',
  },
  {
    id: 'music-tracker',
    title: 'Music Tracker',
    description: 'Detect new playlist additions and check whether they are in your DJ library.',
    route: '/widgets/music-tracker',
    embed: {
      component: MusicTracker,
      span: { cols: 2, rows: 3 },
      flippable: true,
    },
  },
  {
    id: 'concert-discovery',
    title: 'Concert Discovery',
    description: 'Upcoming concerts worth knowing about.',
    route: '/widgets/concert-discovery',
  },
  {
    id: 'acute-strategies-generator',
    title: 'Acute Strategies Generator',
    description: 'Random musical ideas and techniques from a list you maintain.',
    route: '/widgets/acute-strategies-generator',
    embed: {
      component: AcuteStrategiesGenerator,
      span: { cols: 2, rows: 2 },
      flippable: true,
    },
  },
  {
    id: 'festival-follower',
    title: 'Festival Follower',
    description: 'Track festival lineups and dates.',
    route: '/widgets/festival-follower',
  },
  {
    id: 'concert-diary',
    title: 'Concert Diary',
    description: "Log of shows you've attended, with photos and notes.",
    route: '/widgets/concert-diary',
  },
  {
    id: 'buy-sell-trade',
    title: 'Buy, Sell, Trade',
    description: 'Your buy/sell/trade gear list, sale terms, and r/modular matches.',
    route: '/widgets/buy-sell-trade',
    // No `flippable`: D-062 retired the card flip — the header links to the widget page,
    // which is where the list management and terms live.
    embed: {
      component: BuySellTrade,
      span: { cols: 2, rows: 1 },
    },
  },
  {
    id: 'chat',
    title: 'Chat',
    description: 'Quick-access LLM assistant embedded in the dashboard.',
    route: '/widgets/chat',
  },

  // ── Dev Ops summaries (PD-413) ───────────────────────────────────────────────
  // Compact views onto the Dev Ops subpages; each card header links to the full subpage its
  // summary is drawn from. Ordinary library citizens since D-071 — the `system: true` flag that
  // used to hold them off Home is gone, because Home is now curated by hand like any other page.
  {
    id: 'devops-task-tracker',
    title: 'Task Tracker',
    description: 'Tickets in progress and recently shipped.',
    route: '/devops/task-tracker',
    embed: {
      component: DevOpsTaskTrackerWidget,
      span: { cols: 2, rows: 2 },
    },
  },
  {
    id: 'devops-jobs',
    title: 'Jobs',
    description: 'Recurring jobs and their most recent runs.',
    route: '/devops/jobs',
    embed: {
      component: DevOpsJobsWidget,
      span: { cols: 2, rows: 2 },
    },
  },
  {
    id: 'devops-agent',
    title: 'Agent',
    description: 'Robot fleet, dispatch state, and worker heartbeats.',
    route: '/devops/agent-dashboard',
    embed: {
      component: DevOpsAgentWidget,
      span: { cols: 2, rows: 2 },
    },
  },
];

export function widgetById(id: string): WidgetMeta | undefined {
  return widgets.find((w) => w.id === id);
}

/** The span a widget takes when first placed on a page. Non-embedded widgets are link stubs
 *  and need only one cell. */
export function defaultSpan(w: WidgetMeta): { cols: number; rows: number } {
  return { cols: w.embed?.span.cols ?? 1, rows: w.embed?.span.rows ?? 1 };
}

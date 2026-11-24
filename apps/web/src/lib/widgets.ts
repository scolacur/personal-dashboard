import type { Component } from 'svelte';
import AcuteStrategiesGenerator from './AcuteStrategiesGenerator.svelte';
import BuySellTrade from './BuySellTrade.svelte';
import HabitTracker from './HabitTracker.svelte';
import IdTracker from './IdTracker.svelte';
import DrugLog from './DrugLog.svelte';
import TinnitusTracker from './TinnitusTracker.svelte';
import SleepJournal from './SleepJournal.svelte';
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
// **Registration says nothing about where a widget appears** (D-073). It puts the widget in the
// widget library; placement onto pages is user state, stored server-side and read through
// `page-widgets.svelte.ts`. There is deliberately no `pages` field and no `system` flag here —
// the registry answers "what exists", never "what goes where".
export const widgets: WidgetMeta[] = [
  {
    id: 'reminders',
    title: 'Reminders',
    description: 'One-off and recurring reminders.',
    route: '/widgets/reminders',
  },
  {
    // Replaces the `habit-log` and `morning-routine` stubs (PD-721). A page whose saved
    // membership still names either of those renders fine: `resolvePlacements` drops a placement
    // the registry no longer has (see layout.ts / layout.spec.ts).
    id: 'habit-tracker',
    title: 'Habit Tracker',
    description: 'Daily habits and the morning routine, ticked off once a day.',
    route: '/widgets/habit-tracker',
    embed: {
      component: HabitTracker,
      span: { cols: 1, rows: 3 },
      // No `flippable` (D-062): the card is the Today checklist; managing habits lives on the page.
    },
  },
  {
    // PD-975 (Drug log widget): a tap counter for a video game character's in-game use.
    id: 'drug-log',
    title: 'Drug Log',
    description: 'Tap a round button to log it; see counts by day and by drug.',
    route: '/widgets/drug-log',
    embed: {
      component: DrugLog,
      span: { cols: 1, rows: 2 },
      // No `flippable` (D-062): the card is the tap grid; editing buttons and the log live on the page.
    },
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
    id: 'id-tracker',
    title: 'ID Tracker',
    description: 'Log the unidentified tracks in your mixes and work them out.',
    route: '/widgets/id-tracker',
    embed: {
      component: IdTracker,
      span: { cols: 2, rows: 2 },
      // No `flippable` (D-062): the card is a summary, the page is where mixes are managed.
    },
  },
  {
    id: 'tinnitus-tracker',
    title: 'Tinnitus Tracker',
    description: 'Log tinnitus intensity with tags and notes.',
    route: '/widgets/tinnitus-tracker',
    embed: {
      component: TinnitusTracker,
      // 3 rows: the card carries notes and backdating as well as the slider (PD-716).
      span: { cols: 1, rows: 3 },
      // No `flippable` (D-062): the card is capture; history and tag editing live on the page.
    },
  },
  {
    id: 'sleep-journal',
    title: 'Sleep Journal',
    description: 'Log each night: sleep and wake times, how rested, dream notes and supplements.',
    route: '/widgets/sleep-journal',
    embed: {
      component: SleepJournal,
      // 4 rows: times, the rested slider, counted tags and a dream-notes box.
      span: { cols: 1, rows: 4 },
      // No `flippable` (D-062): the card is capture; history, trends and tag editing live on the page.
    },
  },
  {
    // The E2E loop test's throwaway build target (PD-892). Library only, never
    // placed on a page; no embed, so it has no card.
    id: 'e2e-canary',
    title: 'E2E Canary',
    description: 'Test surface for the E2E loop test. Not a real widget.',
    route: '/widgets/e2e-canary',
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
  // summary is drawn from. Ordinary library citizens since D-073 — the `system: true` flag that
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

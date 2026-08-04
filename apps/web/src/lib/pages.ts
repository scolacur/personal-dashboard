/** A nested nav item under a top-level page (PD-286). `route` is a real subroute of the parent
 *  (PD-422 replaced the original `#hash` scroll targets); reached by drilling into the parent
 *  in the side nav. */
export interface NavChild {
  id: string;
  title: string;
  route: string;
}

export interface PageMeta {
  id: string;
  title: string;
  description: string;
  route: string;
  /** Nested nav items. Selecting this page in the side nav navigates to it and slides to a
   *  second panel listing these (PD-415); a page without children just navigates. */
  children?: NavChild[];
}

// The dashboard's top-level nav destinations. One entry per folder in the
// repo-root `pages/` spec directory. The side nav renders these in order.
export const pages: PageMeta[] = [
  {
    id: 'home',
    title: 'Home',
    description: 'Landing page — all your widgets at a glance.',
    route: '/',
  },
  {
    id: 'productivity',
    title: 'Productivity',
    description: 'Habits, morning routine, focus timer, and journaling.',
    route: '/productivity',
  },
  {
    id: 'health-fitness',
    title: 'Health / Fitness',
    description: 'Workouts and health tracking.',
    route: '/health-fitness',
  },
  {
    id: 'music-discovery',
    title: 'Music Discovery',
    description: 'Find and track new music to listen to and add to the library.',
    route: '/music-discovery',
  },
  {
    id: 'music-production',
    title: 'Music Production',
    description: 'Tools that support the music-making process.',
    route: '/music-production',
  },
  {
    id: 'event-tracker',
    title: 'Event Tracker',
    description: "Discover live events and log shows you've attended.",
    route: '/event-tracker',
  },
  {
    id: 'buy-sell-trade',
    title: 'Buy, Sell, Trade',
    description: 'Gear you are buying, selling and trading — and who is asking for it.',
    route: '/buy-sell-trade',
  },
  {
    id: 'inboxes',
    title: 'Inboxes',
    description: 'One-at-a-time organizational jobs you chip away at over time.',
    route: '/inboxes',
  },
  {
    id: 'devops',
    title: 'Dev Ops',
    description: 'Monitor and control AI agent workflows.',
    route: '/devops',
    children: [
      { id: 'do-agent-dashboard', title: 'Agent Dashboard', route: '/devops/agent-dashboard' },
      { id: 'do-jobs', title: 'Jobs', route: '/devops/jobs' },
      { id: 'do-task-tracker', title: 'Task Tracker', route: '/devops/task-tracker' },
    ],
  },
];

export function pageById(id: string): PageMeta | undefined {
  return pages.find((p) => p.id === id);
}

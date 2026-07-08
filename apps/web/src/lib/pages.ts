/** A nested nav item under a top-level page (PD-286). `route` carries a `#hash` to scroll to a
 *  section on the parent page. Revealed via the parent's accordion. */
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
  /** Nested nav items, revealed as an accordion under this page in the side nav. */
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
    id: 'inboxes',
    title: 'Inboxes',
    description: 'One-at-a-time organizational jobs you chip away at over time.',
    route: '/inboxes',
  },
  {
    id: 'task-monitor',
    title: 'Task Monitor',
    description: 'Monitor and control AI agent workflows.',
    route: '/task-monitor',
    children: [
      { id: 'tm-site-status', title: 'Site Status', route: '/task-monitor#site-status' },
      { id: 'tm-jobs', title: 'Jobs', route: '/task-monitor#jobs' },
      { id: 'tm-tickets', title: 'Tickets', route: '/task-monitor#tickets' },
    ],
  },
];

export function pageById(id: string): PageMeta | undefined {
  return pages.find((p) => p.id === id);
}

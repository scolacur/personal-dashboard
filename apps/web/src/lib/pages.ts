/** A nested nav item under a top-level page (PD-286). `route` may carry a `#hash` to scroll
 *  to a section on the parent page, or be omitted when the item is a non-link group header
 *  (its `children` render nested beneath it). `badge: true` opts the item into a live count
 *  overlaid by the nav from a store (Ticket Audit open findings). */
export interface NavChild {
  id: string;
  title: string;
  route?: string;
  count?: number;
  badge?: boolean;
  /** Grandchild items rendered indented under this one (e.g. Reports → Ticket Audit). */
  children?: NavChild[];
}

export interface PageMeta {
  id: string;
  title: string;
  description: string;
  route: string;
  /** Optional static badge count next to the nav label. */
  count?: number;
  /** Nested nav items, indented under this page in the side nav. */
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
      { id: 'tm-jobs', title: 'Jobs', route: '/task-monitor#jobs' },
      { id: 'tm-tickets', title: 'Tickets', route: '/task-monitor#tickets' },
      {
        id: 'tm-reports',
        title: 'Reports',
        children: [
          {
            id: 'ticket-audit',
            title: 'Ticket Audit',
            route: '/task-monitor/reports/ticket-audit',
            badge: true,
          },
        ],
      },
    ],
  },
];

export function pageById(id: string): PageMeta | undefined {
  return pages.find((p) => p.id === id);
}

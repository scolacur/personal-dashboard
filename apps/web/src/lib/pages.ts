/** A nested nav item under a top-level page (PD-286). `route` is a real subroute of the parent
 *  (PD-422 replaced the original `#hash` scroll targets); reached by drilling into the parent
 *  in the side nav. */
export interface NavChild {
  id: string;
  title: string;
  route: string;
  /** A live count shown beside the item (PD-746). `decisions` = Refine sessions waiting on Steve. */
  badge?: 'decisions';
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

// The pinned, code-defined nav pages (PD-969 — pages become data). Home is always first and
// Dev Ops always last; neither can be moved, nested, renamed or deleted. Every other page is a
// user-managed `NavPage` row served by `/api/shell/nav-pages` (see `nav-pages.svelte.ts`).
export const pages: PageMeta[] = [
  {
    id: 'home',
    title: 'Home',
    description: 'Landing page — all your widgets at a glance.',
    route: '/',
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
      { id: 'do-decisions', title: 'Decisions', route: '/devops/decisions', badge: 'decisions' },
      { id: 'do-velocity', title: 'Velocity', route: '/devops/velocity' },
    ],
  },
];

export function pageById(id: string): PageMeta | undefined {
  return pages.find((p) => p.id === id);
}

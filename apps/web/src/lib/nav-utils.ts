import { pages } from './pages';

/** Returns the title of the nav page that best matches `pathname`, or "Dashboard" if none. */
export function resolvePageTitle(pathname: string): string {
  // Sort longest route first so /task-monitor/tickets/... matches /task-monitor before /.
  const sorted = [...pages].sort((a, b) => b.route.length - a.route.length);
  const match = sorted.find((p) =>
    p.route === '/'
      ? pathname === '/'
      : pathname === p.route || pathname.startsWith(p.route + '/'),
  );
  return match?.title ?? 'Dashboard';
}

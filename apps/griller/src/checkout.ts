import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GrillerConfig } from './config';
import { logger } from './logger';

const run = promisify(execFile);

/**
 * git `-c` overrides that route git through the squid proxy. Mirrors Sortie's
 * WORKFLOW.md hook: the proxy is passed INLINE (not just via env) so it applies
 * even in restricted execution contexts. Empty when there's no proxy (dev).
 */
export function proxyGitArgs(config: GrillerConfig): string[] {
  return config.httpsProxy
    ? ['-c', `http.proxy=${config.httpsProxy}`, '-c', `https.proxy=${config.httpsProxy}`]
    : [];
}

/** HTTPS clone URL with the read token inlined (Sortie pattern — no SSH keys). */
export function cloneUrl(config: GrillerConfig): string {
  const auth = config.githubReadToken ? `x-access-token:${config.githubReadToken}@` : '';
  return `https://${auth}github.com/${config.githubRepo}.git`;
}

/** Ensure the read-only grounding checkout exists and is reasonably current. */
export async function ensureCheckout(config: GrillerConfig): Promise<void> {
  if (existsSync(path.join(config.checkoutDir, '.git'))) {
    await pullLatest(config);
    return;
  }
  logger.info({ dir: config.checkoutDir }, 'cloning grounding checkout');
  // Shallow: the griller only grounds against the current tree, never needs history.
  await run('git', [...proxyGitArgs(config), 'clone', '--depth', '1', cloneUrl(config), config.checkoutDir]);
  logger.info('grounding checkout ready');
}

/** Fast-forward the checkout; a failure is logged, not fatal (grounding is best-effort). */
export async function pullLatest(config: GrillerConfig): Promise<void> {
  try {
    await run('git', ['-C', config.checkoutDir, ...proxyGitArgs(config), 'pull', '--ff-only']);
    logger.debug('grounding checkout pulled');
  } catch (err) {
    logger.warn({ err }, 'git pull failed — grounding against stale checkout');
  }
}

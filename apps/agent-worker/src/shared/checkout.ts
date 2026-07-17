import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentWorkerConfig } from './config';
import { logger } from './logger';

const run = promisify(execFile);

/**
 * git `-c` overrides that route git through the squid proxy. The proxy is passed
 * INLINE (not just via env) so it applies
 * even in restricted execution contexts. Empty when there's no proxy (dev).
 */
export function proxyGitArgs(config: AgentWorkerConfig): string[] {
  return config.httpsProxy
    ? ['-c', `http.proxy=${config.httpsProxy}`, '-c', `https.proxy=${config.httpsProxy}`]
    : [];
}

/** Plain HTTPS remote — NO token. Auth is supplied out-of-band via authArgs() so the token
 *  never lands in the URL (and thus never in `.git/config`, which sits on a shared volume). */
export function cloneUrl(config: AgentWorkerConfig): string {
  return `https://github.com/${config.githubRepo}.git`;
}

/** Base64 of the token's Authorization header value, or '' when there's no token. Kept
 *  separate so callers can redact it from logs (it is a secret, just encoded). */
export function authHeaderValue(token: string): string {
  return token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
}

/**
 * git `-c` args that attach the read token as an HTTP Authorization header. Unlike a
 * token-in-URL, an `http.extraHeader` override is per-invocation — git never writes it to
 * `.git/config`, so the token isn't persisted on the shared /data volume.
 */
export function authArgs(config: AgentWorkerConfig): string[] {
  const b64 = authHeaderValue(config.githubReadToken);
  return b64 ? ['-c', `http.extraHeader=Authorization: Basic ${b64}`] : [];
}

/** Strip both the raw token and its base64 header form from a string before it's logged. */
function redactSecrets(text: string, config: AgentWorkerConfig): string {
  let out = text;
  for (const secret of [config.githubReadToken, authHeaderValue(config.githubReadToken)]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

/**
 * Run git with the token-bearing args, but ensure any failure NEVER leaks the token:
 * execFile's error embeds the full argv (header + all), so we rethrow a sanitized Error and
 * drop the original (whose .cmd/.stack also carry the secret). `GIT_TERMINAL_PROMPT=0` fails
 * fast on an auth error instead of blocking on a prompt.
 */
async function runGit(args: string[], config: AgentWorkerConfig): Promise<void> {
  try {
    await run('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (err) {
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), config));
  }
}

/** Ensure the read-only grounding checkout exists and is reasonably current. */
export async function ensureCheckout(config: AgentWorkerConfig): Promise<void> {
  if (existsSync(path.join(config.checkoutDir, '.git'))) {
    await pullLatest(config);
    return;
  }
  logger.info({ dir: config.checkoutDir }, 'cloning grounding checkout');
  // Shallow: the agent-worker only grounds against the current tree, never needs history.
  await runGit(
    [...authArgs(config), ...proxyGitArgs(config), 'clone', '--depth', '1', cloneUrl(config), config.checkoutDir],
    config,
  );
  logger.info('grounding checkout ready');
}

/** Fast-forward the checkout; a failure is logged, not fatal (grounding is best-effort). */
export async function pullLatest(config: AgentWorkerConfig): Promise<void> {
  try {
    await runGit(['-C', config.checkoutDir, ...authArgs(config), ...proxyGitArgs(config), 'pull', '--ff-only'], config);
    logger.debug('grounding checkout pulled');
  } catch (err) {
    // err is already sanitized by runGit, so this is safe to log verbatim.
    logger.warn({ err }, 'git pull failed — grounding against stale checkout');
  }
}

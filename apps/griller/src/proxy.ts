import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import type { GrillerConfig } from './config';
import { logger } from './logger';

/**
 * Force all in-process egress through the squid proxy (D-044 / the Sortie egress
 * pattern). Two layers are needed because Node's global `fetch` does NOT honor
 * HTTP(S)_PROXY on its own:
 *
 *  1. `NODE_USE_ENV_PROXY=1` (Node 24+) — makes the runtime's fetch respect the
 *     proxy env vars; set in the container env. The Claude Agent SDK's own HTTP
 *     also picks this up.
 *  2. An undici `EnvHttpProxyAgent` global dispatcher — belt-and-suspenders for any
 *     direct `fetch`/undici use in our code (e.g. custom tools).
 *
 * In local dev (no HTTPS_PROXY) this is a no-op and egress is direct.
 */
export function installProxy(config: GrillerConfig): void {
  if (!config.httpsProxy) {
    logger.info('no HTTPS_PROXY set — direct egress (local dev)');
    return;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info({ proxy: config.httpsProxy }, 'routing egress through squid proxy');
}

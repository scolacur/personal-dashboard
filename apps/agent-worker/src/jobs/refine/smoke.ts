import { loadConfig } from '../../shared/config';
import { installProxy } from '../../shared/proxy';
import { ensureCheckout } from '../../shared/checkout';
import { buildContextPack } from '../../shared/context-pack';
import { runGrillTurn } from './session';
import { logger } from '../../shared/logger';

/**
 * Manual smoke test (`npm run smoke -w apps/agent-worker`). NOT part of `npm run verify` —
 * it needs a live ANTHROPIC_API_KEY + network. Proves the agent-worker grounds against the
 * real repo: the plan it returns should reference actual files in the checkout.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('set ANTHROPIC_API_KEY to run the agent-worker smoke test');
  }
  installProxy(config);
  await ensureCheckout(config);
  const contextPack = buildContextPack(config.checkoutDir);

  const { text, sessionId } = await runGrillTurn({
    config,
    contextPack,
    prompt:
      'Ticket: "Add a dark-mode toggle to the dashboard shell." Plan first — ask any clarifying ' +
      'questions and reference the ACTUAL files you would touch, grounded in this repo.',
  });

  logger.info({ sessionId }, 'grill turn complete');
  process.stdout.write(`\n${text}\n`);
}

main().catch((err) => {
  logger.error({ err }, 'smoke failed');
  process.exit(1);
});

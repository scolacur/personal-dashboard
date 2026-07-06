import { loadConfig } from './config';
import { installProxy } from './proxy';
import { ensureCheckout } from './checkout';
import { buildContextPack } from './context-pack';
import { runGrillTurn } from './session';
import { logger } from './logger';

/**
 * Manual smoke test (`npm run smoke -w apps/griller`). NOT part of `npm run verify` —
 * it needs a live ANTHROPIC_API_KEY + network. Proves the griller grounds against the
 * real repo: the plan it returns should reference actual files in the checkout.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('set ANTHROPIC_API_KEY to run the griller smoke test');
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

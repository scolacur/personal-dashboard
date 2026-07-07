import pino from 'pino';

// pino to match the project logging convention (PROJECT.md §2). LOG_PRETTY in dev.
export const logger = pino(
  process.env.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {},
);

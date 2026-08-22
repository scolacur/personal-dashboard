import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentWorkerConfig } from '../../shared/config';
import { gitNetworkArgs, inFlightRunCount, redactToken } from './index';

/**
 * The drain's view of "in flight" (PD-498). These run against a real schema rather than an injected
 * count, because the bug this guards was invisible to every test that injected one.
 */
describe('inFlightRunCount', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_tickets (id INTEGER PRIMARY KEY, status TEXT, agent_state TEXT);
      CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, ticket_id INTEGER, status TEXT, started_at INTEGER);
    `);
  });

  function ticket(id: number, status: string, agentState: string | null): void {
    db.prepare('INSERT INTO agent_tickets (id, status, agent_state) VALUES (?, ?, ?)').run(id, status, agentState);
  }
  function run(id: number, ticketId: number, status: string): void {
    db.prepare('INSERT INTO agent_runs (id, ticket_id, status, started_at) VALUES (?, ?, ?, 0)').run(id, ticketId, status);
  }

  it('is zero on an empty board', () => {
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('counts a run whose ticket is still working', () => {
    ticket(1, 'queue', 'working');
    run(10, 1, 'running');
    expect(inFlightRunCount(db)).toBe(1);
  });

  it('ignores a finished run', () => {
    ticket(1, 'queue', 'working');
    run(10, 1, 'handed-off');
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('ignores a stuck `running` row whose ticket finished long ago', () => {
    // The real one, from the NAS on 2026-08-22: a run left `running` since 2026-07-16 against a
    // ticket completed five weeks earlier with agent_state NULL. `orphanedRunningRuns` only reaches
    // runs whose ticket is `working`, so nothing ever closes it. Counting it would pin the drain
    // above zero forever and make every cycle time out.
    ticket(467, 'completed', null);
    run(2, 467, 'running');
    expect(inFlightRunCount(db)).toBe(0);
  });

  it('counts only the genuinely live runs when both kinds are present', () => {
    ticket(467, 'completed', null);
    run(2, 467, 'running'); // the orphan
    ticket(500, 'queue', 'working');
    run(11, 500, 'running'); // genuinely in flight
    expect(inFlightRunCount(db)).toBe(1);
  });

  it('ignores a run whose ticket row is gone entirely', () => {
    run(12, 999, 'running');
    expect(inFlightRunCount(db)).toBe(0);
  });
});

describe('redactToken', () => {
  const TOKEN = 'ghp_supersecrettoken';

  it('strips the raw token', () => {
    expect(redactToken(`fatal: auth failed for ${TOKEN}`, TOKEN)).toBe('fatal: auth failed for ***');
  });

  it('strips the base64 Authorization form, which is what actually appears in argv', () => {
    // This is the shape that leaks: the token travels as `-c http.extraHeader=Authorization:
    // Basic <b64>`, and execFile's error embeds the whole argv.
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(redactToken(`Command failed: git -c http.extraHeader=Authorization: Basic ${b64} push`, TOKEN)).not.toContain(
      b64,
    );
  });

  it('leaves text alone when there is no token configured', () => {
    expect(redactToken('nothing secret here', '')).toBe('nothing secret here');
  });

  it('strips every occurrence, not just the first', () => {
    expect(redactToken(`${TOKEN} and again ${TOKEN}`, TOKEN)).toBe('*** and again ***');
  });
});

describe('gitNetworkArgs', () => {
  const base = {
    robot: { writeToken: 'ghp_tok', botName: 'b', botEmail: 'e' },
    httpsProxy: 'http://egress-proxy:3128',
  } as unknown as AgentWorkerConfig;

  it('carries the token as a header, never in a URL', () => {
    // A token in the remote URL lands in .git/config, which lives on a shared volume. An
    // http.extraHeader override is per-invocation and never persisted (same rule as checkout.ts).
    const args = gitNetworkArgs(base);
    expect(args.join(' ')).toContain('http.extraHeader=Authorization: Basic');
    expect(args.join(' ')).not.toContain('https://ghp_tok@');
  });

  it('passes the proxy inline as well as via env', () => {
    expect(gitNetworkArgs(base).join(' ')).toContain('http.proxy=http://egress-proxy:3128');
  });

  it('is empty when neither a token nor a proxy is configured', () => {
    expect(gitNetworkArgs({ robot: { writeToken: '' }, httpsProxy: '' } as unknown as AgentWorkerConfig)).toEqual([]);
  });
});

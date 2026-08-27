import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  COUNTER_UNAVAILABLE_GUIDANCE,
  DECISION_ALLOCATE_TOOL_NAME,
  allocateForAgent,
  buildDecisionToolServer,
} from './decision-tool';
import { ROBOT_TOOLS } from './session';

let db: Database.Database;

function serverBootstrap(target: Database.Database, seed = 79): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS decision_id_counter (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      last_num INTEGER NOT NULL
    );
  `);
  target.prepare('INSERT OR IGNORE INTO decision_id_counter (id, last_num) VALUES (1, ?)').run(seed);
}

beforeEach(() => {
  db = new Database(':memory:');
});

describe(DECISION_ALLOCATE_TOOL_NAME, () => {
  it('is an MCP tool, so it stays out of D-068’s ROBOT_TOOLS allowlist', () => {
    // Same reading `docs-tool.spec.ts` pins for mcp__docs__fetch: `tools` governs BUILT-IN tools,
    // and MCP servers are supplied separately via `mcpServers`. Adding this name to ROBOT_TOOLS
    // would be a category error, and would read as though D-068's list had been reopened.
    expect(DECISION_ALLOCATE_TOOL_NAME).toBe('mcp__decisions__allocate');
    expect([...ROBOT_TOOLS] as string[]).not.toContain(DECISION_ALLOCATE_TOOL_NAME);
    expect([...ROBOT_TOOLS] as string[]).not.toContain('allocate');
  });

  it('returns an allocated id and tells the agent what to do with it', () => {
    serverBootstrap(db, 79);
    const res = allocateForAgent(db, 220, 'Some decision');

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('D-080');
    // The instruction half matters as much as the number: an id with no filename convention
    // attached is how a decision ends up written somewhere the index will never find it.
    expect(text).toContain('DECISIONS/D-080-');
    expect(text).toContain('# D-080:');
  });

  it('gives a second call a different id', () => {
    serverBootstrap(db);
    const first = allocateForAgent(db, 220).content[0].text;
    const second = allocateForAgent(db, 220).content[0].text;
    expect(first).toContain('D-080');
    expect(second).toContain('D-081');
  });

  it('works without a title — the title is for the log, not a gate', () => {
    serverBootstrap(db);
    const res = allocateForAgent(db, 220);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('D-080');
  });

  it('refuses with guidance when the counter does not exist', () => {
    const res = allocateForAgent(db, 220);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(COUNTER_UNAVAILABLE_GUIDANCE);
  });

  it('never allocates from a database it had to create', () => {
    // The refusal must not be a silent seed. A worker that bootstrapped its own counter would
    // start from a number it cannot know is free and re-issue live ids.
    allocateForAgent(db, 220);
    const tables = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'decision_id_counter'")
      .get() as { n: number };
    expect(tables.n).toBe(0);
  });
});

describe('buildDecisionToolServer', () => {
  it('registers under the `decisions` server name the session wires it as', () => {
    // The fully-qualified `mcp__decisions__allocate` is server key + tool name, so this name and
    // the key in session.ts's `mcpServers` must agree or the tool the prompt names does not exist.
    const server = buildDecisionToolServer(db, 220) as unknown as { name: string; type: string };
    expect(server.name).toBe('decisions');
    expect(server.type).toBe('sdk');
  });
});

describe('COUNTER_UNAVAILABLE_GUIDANCE', () => {
  it('routes to an ask_human park, not to a retry loop or a hand-picked number', () => {
    // The two failure modes a bare "unavailable" reliably produces. The second is the one this
    // entire epic exists to prevent, so it is called out by name.
    expect(COUNTER_UNAVAILABLE_GUIDANCE).toMatch(/Do NOT retry/);
    expect(COUNTER_UNAVAILABLE_GUIDANCE).toMatch(/Do NOT pick a number yourself/);
    expect(COUNTER_UNAVAILABLE_GUIDANCE).toContain('.robot/ask-human');
    expect(COUNTER_UNAVAILABLE_GUIDANCE).toMatch(/does not count against the ticket/);
  });
});

import { describe, it, expect } from 'vitest';
import type { SyncHookJSONOutput, PreToolUseHookSpecificOutput } from '@anthropic-ai/claude-agent-sdk';
import { type AgentWorkerConfig, loadRobotConfig, loadEvaluatorConfig, loadMaintenanceConfig } from '../../shared/config';
import { ASK_TOOL_NAME } from './ask-tool';
import { BOARD_TOOL_NAMES } from './board-tools';
import { PROPOSE_TOOL_NAME } from './propose-tool';
import { REFINE_EXPLORER_AGENT, refineAgentToolHook, refineOptions } from './session';

const CONFIG = {
  model: 'claude-opus-4-8',
  checkoutDir: '/co',
  refineMaxTurns: 30,
  robot: loadRobotConfig({}),
  evaluator: loadEvaluatorConfig({}),
  maintenance: loadMaintenanceConfig({}),
} as unknown as AgentWorkerConfig;

/** Fire the PreToolUse hook the way the CLI does and return its PreToolUse decision. */
async function decide(toolName: string, toolInput: Record<string, unknown>) {
  const out = (await refineAgentToolHook({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  })) as SyncHookJSONOutput;
  return out.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
}

describe('Refine sub-agents run in the foreground, as the explorer only (PD-844)', () => {
  it('forces run_in_background false when the explorer asks for the background', async () => {
    const d = await decide('Agent', {
      subagent_type: REFINE_EXPLORER_AGENT,
      description: 'find widgets',
      prompt: 'p',
      run_in_background: true,
      isolation: 'remote',
    });
    expect(d?.permissionDecision).toBe('allow');
    expect(d?.updatedInput).toEqual({
      subagent_type: REFINE_EXPLORER_AGENT,
      description: 'find widgets',
      prompt: 'p',
      run_in_background: false,
    });
  });

  it('sets run_in_background false explicitly when the explorer omits it (the SDK default is background)', async () => {
    const d = await decide('Agent', { subagent_type: REFINE_EXPLORER_AGENT, description: 'd', prompt: 'p' });
    expect(d?.permissionDecision).toBe('allow');
    expect(d?.updatedInput?.run_in_background).toBe(false);
  });

  it('denies a generic or missing sub-agent type, so propose_commit/ask_questions stay out of reach', async () => {
    for (const subagent_type of ['general-purpose', 'Explore', 'fork', undefined]) {
      const d = await decide('Agent', { subagent_type, description: 'd', prompt: 'p', run_in_background: false });
      expect(d?.permissionDecision).toBe('deny');
      expect(d?.permissionDecisionReason).toContain(REFINE_EXPLORER_AGENT);
    }
  });

  it('applies to the legacy Task name too', async () => {
    expect((await decide('Task', { subagent_type: 'general-purpose', prompt: 'p' }))?.permissionDecision).toBe('deny');
  });

  it('leaves every other tool to the normal permission flow', async () => {
    expect(await refineAgentToolHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} })).toEqual({});
  });
});

describe('refineOptions locks down the toolset (PD-844)', () => {
  const opts = refineOptions(CONFIG, 'ctx', undefined, () => {}, false, () => {}, {} as never);

  it('makes Bash, Edit, Write, NotebookEdit, WebFetch and WebSearch unavailable', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
      expect(opts.disallowedTools).toContain(tool);
      expect(opts.allowedTools).not.toContain(tool);
    }
  });

  it('removes the background-control tools but keeps Agent', () => {
    for (const tool of ['TaskOutput', 'TaskStop', 'Monitor', 'SendMessage', 'ScheduleWakeup']) {
      expect(opts.disallowedTools).toContain(tool);
    }
    expect(opts.disallowedTools).not.toContain('Agent');
  });

  it('keeps the existing permission behaviour: dontAsk with the read-only + refine allowlist', () => {
    expect(opts.permissionMode).toBe('dontAsk');
    expect(opts.allowedTools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', PROPOSE_TOOL_NAME, ASK_TOOL_NAME]));
  });

  it('wires the Agent hook as PreToolUse', () => {
    expect(opts.hooks.PreToolUse[0].matcher).toBe('Agent|Task');
    expect(opts.hooks.PreToolUse[0].hooks).toContain(refineAgentToolHook);
  });

  it('defines the explorer as read-only + board tools, never propose_commit or ask_questions', () => {
    const explorer = opts.agents[REFINE_EXPLORER_AGENT];
    expect(explorer.tools).toEqual(['Read', 'Grep', 'Glob', ...BOARD_TOOL_NAMES]);
    expect(explorer.tools).not.toContain(PROPOSE_TOOL_NAME);
    expect(explorer.tools).not.toContain(ASK_TOOL_NAME);
    expect(explorer.background).toBe(false);
    expect(explorer.prompt).toMatch(/main/);
    expect(explorer.prompt).toMatch(/5 minutes/);
    expect(explorer.prompt).toMatch(/unmerged pull requests/);
    expect(explorer.prompt).toMatch(/git\s+history/);
  });
});

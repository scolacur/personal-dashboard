import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDeployStatus, getDeployInfo, resetDeployStatusForTest } from './deploy-status';

const ORIGINAL_APP_VERSION = process.env.APP_VERSION;

beforeEach(() => {
  resetDeployStatusForTest();
});

afterEach(() => {
  if (ORIGINAL_APP_VERSION === undefined) {
    delete process.env.APP_VERSION;
  } else {
    process.env.APP_VERSION = ORIGINAL_APP_VERSION;
  }
  resetDeployStatusForTest();
});

describe('getDeployInfo before init', () => {
  it('returns startedAt as a number', () => {
    delete process.env.APP_VERSION;
    const info = getDeployInfo();
    expect(typeof info.startedAt).toBe('number');
    expect(info.startedAt).toBeGreaterThan(0);
  });
});

describe('initDeployStatus with no sha', () => {
  it('sets sha=null and nulls all fetched fields when APP_VERSION is unset', async () => {
    delete process.env.APP_VERSION;
    await initDeployStatus();
    const info = getDeployInfo();
    expect(info.sha).toBeNull();
    expect(info.commitMessage).toBeNull();
    expect(info.commitDate).toBeNull();
    expect(info.workflowRunUrl).toBeNull();
    expect(typeof info.startedAt).toBe('number');
  });

  it('sets sha=null when APP_VERSION is "dev"', async () => {
    process.env.APP_VERSION = 'dev';
    await initDeployStatus();
    const info = getDeployInfo();
    expect(info.sha).toBeNull();
  });
});

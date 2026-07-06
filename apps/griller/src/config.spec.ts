import { describe, it, expect } from 'vitest';
import { loadConfig, dbPathFor } from './config';

describe('loadConfig', () => {
  it('applies sensible defaults (Opus, PD repo, /data checkout)', () => {
    const c = loadConfig({});
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.githubRepo).toBe('scolacur/personal-dashboard');
    expect(c.checkoutDir).toBe('/data/griller-checkout');
    expect(c.githubReadToken).toBe('');
    expect(c.httpsProxy).toBe('');
    expect(c.pullIntervalMs).toBe(5 * 60_000);
  });

  it('reads overrides from env', () => {
    const c = loadConfig({
      GRILLER_MODEL: 'claude-sonnet-4-6',
      GRILLER_GITHUB_REPO: 'me/other',
      GITHUB_READ_TOKEN: 'tok',
      GRILLER_CHECKOUT_DIR: '/co',
      DATA_DIR: '/d',
      GRILLER_PULL_INTERVAL_MS: '1000',
      HTTPS_PROXY: 'http://egress-proxy:3128',
    });
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.githubRepo).toBe('me/other');
    expect(c.githubReadToken).toBe('tok');
    expect(c.checkoutDir).toBe('/co');
    expect(c.pullIntervalMs).toBe(1000);
    expect(c.httpsProxy).toBe('http://egress-proxy:3128');
    expect(dbPathFor(c)).toBe('/d/dashboard.db');
  });

  it('falls back to lowercase https_proxy', () => {
    expect(loadConfig({ https_proxy: 'http://p:3128' }).httpsProxy).toBe('http://p:3128');
  });
});

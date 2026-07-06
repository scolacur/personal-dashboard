import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';
import { proxyGitArgs, cloneUrl } from './checkout';

describe('proxyGitArgs', () => {
  it('is empty without a proxy (dev)', () => {
    expect(proxyGitArgs(loadConfig({}))).toEqual([]);
  });

  it('passes the proxy inline for http + https', () => {
    const c = loadConfig({ HTTPS_PROXY: 'http://egress-proxy:3128' });
    expect(proxyGitArgs(c)).toEqual([
      '-c',
      'http.proxy=http://egress-proxy:3128',
      '-c',
      'https.proxy=http://egress-proxy:3128',
    ]);
  });
});

describe('cloneUrl', () => {
  it('inlines the read token when present', () => {
    const c = loadConfig({ GITHUB_READ_TOKEN: 'ghp_x', GRILLER_GITHUB_REPO: 'me/repo' });
    expect(cloneUrl(c)).toBe('https://x-access-token:ghp_x@github.com/me/repo.git');
  });

  it('omits auth when no token (public clone)', () => {
    const c = loadConfig({ GRILLER_GITHUB_REPO: 'me/repo' });
    expect(cloneUrl(c)).toBe('https://github.com/me/repo.git');
  });
});

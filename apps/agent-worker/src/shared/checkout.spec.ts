import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';
import { proxyGitArgs, cloneUrl, authArgs, authHeaderValue } from './checkout';

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
  it('is a plain token-free URL (auth goes via a header, never the URL / .git/config)', () => {
    const withTok = loadConfig({ GITHUB_READ_TOKEN: 'ghp_x', AGENT_WORKER_GITHUB_REPO: 'me/repo' });
    const noTok = loadConfig({ AGENT_WORKER_GITHUB_REPO: 'me/repo' });
    expect(cloneUrl(withTok)).toBe('https://github.com/me/repo.git');
    expect(cloneUrl(noTok)).toBe('https://github.com/me/repo.git');
    expect(cloneUrl(withTok)).not.toContain('ghp_x');
  });
});

describe('authArgs / authHeaderValue', () => {
  it('attaches the token as a base64 Authorization header override (not persisted to config)', () => {
    const c = loadConfig({ GITHUB_READ_TOKEN: 'ghp_secret', AGENT_WORKER_GITHUB_REPO: 'me/repo' });
    const b64 = Buffer.from('x-access-token:ghp_secret').toString('base64');
    expect(authHeaderValue('ghp_secret')).toBe(b64);
    expect(authArgs(c)).toEqual(['-c', `http.extraHeader=Authorization: Basic ${b64}`]);
    // The raw token itself never appears in the args (only its base64 header form).
    expect(authArgs(c).join(' ')).not.toContain('ghp_secret');
  });

  it('is empty with no token (public clone)', () => {
    expect(authArgs(loadConfig({ AGENT_WORKER_GITHUB_REPO: 'me/repo' }))).toEqual([]);
    expect(authHeaderValue('')).toBe('');
  });
});

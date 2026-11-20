import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCapturePath, registerVisualCaptureRoutes } from './visual-captures-routes';

describe('visual capture routes (PD-773)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vc-'));
    mkdirSync(path.join(dir, 'visual-captures', 'pr-12', 'abc1234'), { recursive: true });
    writeFileSync(path.join(dir, 'visual-captures', 'pr-12', 'abc1234', 'home-phone-dark.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves a capture with an image type', async () => {
    const app = Fastify();
    registerVisualCaptureRoutes(app, dir);
    const res = await app.inject({ url: '/api/visual-captures/pr-12/abc1234/home-phone-dark.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('refuses anything outside the pattern, including traversal', async () => {
    const app = Fastify();
    registerVisualCaptureRoutes(app, dir);
    for (const url of [
      '/api/visual-captures/pr-12/abc1234/..%2F..%2F..%2Fsecret.txt',
      '/api/visual-captures/..%2F/abc1234/x.png',
      '/api/visual-captures/pr-12/ABC1234/home-phone-dark.png',
      '/api/visual-captures/pr-12/abc1234/missing.png',
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
    expect(isCapturePath('pr-1', 'abc1234', 'a.svg')).toBe(false);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAuthStore } from './auth.js';

describe('MemoryAuthStore', () => {
  it('creates a one-time PKCE authorization bound to the browser session', () => {
    let now = 1_000;
    const auth = new MemoryAuthStore(10_000, () => now);
    const authorization = auth.begin('browser-session-a');

    expect(authorization.state).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(authorization.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const consumed = auth.consume(authorization.state, 'browser-session-a');
    expect(consumed).toBeDefined();
    expect(
      createHash('sha256').update(consumed!.verifier).digest('base64url'),
    ).toBe(authorization.challenge);
    expect(auth.consume(authorization.state, 'browser-session-a')).toBeUndefined();

    now += 1;
  });

  it('rejects the wrong browser session and consumes the pending state', () => {
    const auth = new MemoryAuthStore(10_000);
    const authorization = auth.begin('browser-session-a');

    expect(auth.consume(authorization.state, 'browser-session-b')).toBeUndefined();
    expect(auth.consume(authorization.state, 'browser-session-a')).toBeUndefined();
  });

  it('clears every pending authorization bound to a browser session', () => {
    const auth = new MemoryAuthStore(10_000);
    const first = auth.begin('browser-session-a');
    const second = auth.begin('browser-session-a');
    const other = auth.begin('browser-session-b');

    expect(auth.clearPending('browser-session-a')).toBe(2);
    expect(auth.consume(first.state, 'browser-session-a')).toBeUndefined();
    expect(auth.consume(second.state, 'browser-session-a')).toBeUndefined();
    expect(auth.consume(other.state, 'browser-session-b')).toBeDefined();
  });

  it('expires pending authorizations and access credentials', () => {
    let now = 10_000;
    const auth = new MemoryAuthStore(500, () => now);
    const authorization = auth.begin('browser-session-a');
    auth.setCredential({
      accessToken: 'secret-token',
      username: 'SaturdayCthuns',
      expiresAt: now + 1_000,
    });

    now += 500;
    expect(auth.consume(authorization.state, 'browser-session-a')).toBeUndefined();
    expect(auth.getCredential()?.username).toBe('SaturdayCthuns');

    now += 500;
    expect(auth.getCredential()).toBeUndefined();
  });
});

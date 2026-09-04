import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from './config.js';
import { isSafeOAuthValue, LichessClient } from './lichess.js';

function makeConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 5173,
    origin: 'http://127.0.0.1:5173',
    dataDir: 'unused',
    lichessBaseUrl: 'https://lichess.org',
    lichessUsername: 'SaturdayCthuns',
    oauthClientId: 'opening-trainer.local',
    oauthCallbackPath: '/api/auth/callback',
    oauthPendingTtlMs: 600_000,
    requestTimeoutMs: 120_000,
    production: false,
  };
}

describe('LichessClient', () => {
  it('builds the official OAuth2 PKCE authorization request', () => {
    const client = new LichessClient(makeConfig());
    const authorization = new URL(client.authorizationUrl('state-value', 'pkce-challenge'));

    expect(authorization.origin + authorization.pathname).toBe('https://lichess.org/oauth');
    expect(Object.fromEntries(authorization.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'opening-trainer.local',
      redirect_uri: 'http://127.0.0.1:5173/api/auth/callback',
      code_challenge_method: 'S256',
      code_challenge: 'pkce-challenge',
      scope: 'study:read',
      username: 'SaturdayCthuns',
      state: 'state-value',
    });
  });

  it('exchanges punctuation-bearing OAuth codes and accepts a valid bearer token', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://lichess.org/api/token');
      expect(init?.method).toBe('POST');
      const form = new URLSearchParams(init?.body as URLSearchParams);
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'authorization_code',
        code: 'code-._~+/=',
        code_verifier: 'verifier-._~',
        redirect_uri: 'http://127.0.0.1:5173/api/auth/callback',
        client_id: 'opening-trainer.local',
      });
      return Response.json({
        token_type: 'Bearer',
        access_token: 'token-._~+/=',
        expires_in: 3_600,
      });
    });
    const client = new LichessClient(makeConfig(), fetchMock as typeof fetch);

    await expect(client.exchangeCode('code-._~+/=', 'verifier-._~')).resolves.toEqual({
      token_type: 'Bearer',
      access_token: 'token-._~+/=',
      expires_in: 3_600,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses authenticated study list and PGN export endpoints', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-token');
      if (url.pathname === '/api/study/by/SaturdayCthuns') {
        expect(new Headers(init?.headers).get('Accept')).toBe('application/x-ndjson');
        return new Response(
          `${JSON.stringify({ id: 'study01', name: 'Private study', createdAt: 10, updatedAt: 20 })}\n`,
          { headers: { 'Content-Type': 'application/x-ndjson' } },
        );
      }
      expect(url.pathname).toBe('/api/study/study01.pgn');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        clocks: 'false',
        comments: 'true',
        variations: 'true',
        orientation: 'true',
      });
      return new Response('[Event "Private study"]\n\n*');
    });
    const client = new LichessClient(makeConfig(), fetchMock as typeof fetch);

    await expect(client.studiesByUser('private-token')).resolves.toEqual([
      { id: 'study01', name: 'Private study', createdAt: 10, updatedAt: 20 },
    ]);
    await expect(client.studyPgn('study01', 'private-token')).resolves.toContain('Private study');
  });
});

describe('isSafeOAuthValue', () => {
  it('allows visible OAuth punctuation but rejects controls and oversized values', () => {
    expect(isSafeOAuthValue('abc-._~+/=')).toBe(true);
    expect(isSafeOAuthValue('abc\ndef')).toBe(false);
    expect(isSafeOAuthValue('abc def')).toBe(false);
    expect(isSafeOAuthValue('12345', 4)).toBe(false);
  });
});

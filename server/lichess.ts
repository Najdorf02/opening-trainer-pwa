import type { ServerConfig } from './config';

export interface LichessStudyMetadata {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface OAuthTokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
}

export interface LichessAccount {
  id: string;
  username: string;
}

export class LichessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LichessApiError';
  }
}

export class LichessClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL('/oauth', this.config.lichessBaseUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.oauthClientId,
      redirect_uri: new URL(this.config.oauthCallbackPath, `${this.config.origin}/`).toString(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: 'study:read',
      username: this.config.lichessUsername,
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, verifier: string): Promise<OAuthTokenResponse> {
    const response = await this.request('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: new URL(this.config.oauthCallbackPath, `${this.config.origin}/`).toString(),
        client_id: this.config.oauthClientId,
      }),
    });
    const payload = await response.json() as Partial<OAuthTokenResponse>;
    if (
      payload.token_type !== 'Bearer'
      || typeof payload.access_token !== 'string'
      || !isSafeOAuthValue(payload.access_token, 4_096)
      || !Number.isFinite(payload.expires_in)
      || Number(payload.expires_in) <= 0
    ) {
      throw new LichessApiError('Lichess returned an invalid OAuth token response.', 502);
    }
    return payload as OAuthTokenResponse;
  }

  async account(accessToken: string): Promise<LichessAccount> {
    const response = await this.request('/api/account', {
      headers: this.bearerHeaders(accessToken, 'application/json'),
    });
    const payload = await response.json() as Partial<LichessAccount>;
    if (typeof payload.id !== 'string' || typeof payload.username !== 'string') {
      throw new LichessApiError('Lichess returned an invalid account response.', 502);
    }
    return payload as LichessAccount;
  }

  async revoke(accessToken: string): Promise<void> {
    await this.request('/api/token', {
      method: 'DELETE',
      headers: this.bearerHeaders(accessToken),
    });
  }

  async studiesByUser(accessToken: string): Promise<LichessStudyMetadata[]> {
    const username = encodeURIComponent(this.config.lichessUsername);
    const response = await this.request(`/api/study/by/${username}`, {
      headers: this.bearerHeaders(accessToken, 'application/x-ndjson'),
    });
    const body = await response.text();
    const studies: LichessStudyMetadata[] = [];
    for (const [index, line] of body.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new LichessApiError(`Lichess study list contained invalid JSON at line ${index + 1}.`, 502);
      }
      const study = raw as Partial<LichessStudyMetadata>;
      if (
        typeof study.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(study.id)
        || typeof study.name !== 'string'
        || !Number.isFinite(study.createdAt)
        || !Number.isFinite(study.updatedAt)
      ) {
        throw new LichessApiError('Lichess returned invalid study metadata.', 502);
      }
      studies.push(study as LichessStudyMetadata);
    }
    return studies;
  }

  async studyPgn(studyId: string, accessToken: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(studyId)) {
      throw new Error('Invalid study ID.');
    }
    const query = new URLSearchParams({
      clocks: 'false',
      comments: 'true',
      variations: 'true',
      orientation: 'true',
    });
    const response = await this.request(`/api/study/${encodeURIComponent(studyId)}.pgn?${query}`, {
      headers: this.bearerHeaders(accessToken, 'application/x-chess-pgn'),
    });
    return response.text();
  }

  private bearerHeaders(accessToken: string, accept?: string): HeadersInit {
    return {
      Authorization: `Bearer ${accessToken}`,
      ...(accept ? { Accept: accept } : {}),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.lichessBaseUrl), {
        ...init,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof LichessApiError) throw error;
      throw new LichessApiError('Could not reach Lichess.', 502);
    }
    if (!response.ok) {
      const retryAfter = readRetryAfter(response.headers.get('Retry-After'));
      throw new LichessApiError(
        response.status === 429 ? 'Lichess rate limit reached.' : 'Lichess rejected the request.',
        response.status,
        retryAfter,
      );
    }
    return response;
  }
}

function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
  return undefined;
}

export function isSafeOAuthValue(value: string, maxLength = 2_048): boolean {
  return value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/u.test(value);
}

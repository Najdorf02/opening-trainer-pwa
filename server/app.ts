import express, { type NextFunction, type Request, type Response } from 'express';
import type { ServerConfig } from './config';
import { MemoryAuthStore, randomUrlSafe } from './auth';
import {
  ChessComApiError,
  ChessComClient,
  ChessComValidationError,
  parseChessComGamesQuery,
  type ChessComGamesGateway,
} from './chesscom.js';
import { isSafeOAuthValue, LichessApiError, LichessClient } from './lichess';
import {
  OpeningDataError,
  OpeningPracticeClient,
  OpeningPracticeValidationError,
  parseEvaluationBody,
  parseExplorerQuery,
  type OpeningPracticeGateway,
} from './opening-practice.js';
import {
  NotConnectedError,
  StudySyncService,
  SyncInProgressError,
  SyncRateLimitedError,
} from './sync';
import type { StudyStorage } from './storage';

const SESSION_COOKIE = 'opening_trainer_session';

export interface AppDependencies {
  config: ServerConfig;
  auth: MemoryAuthStore;
  lichess: LichessClient;
  storage: StudyStorage;
  sync: StudySyncService;
  openingPractice?: OpeningPracticeGateway;
  chessCom?: ChessComGamesGateway;
}

export function createApp(dependencies: AppDependencies): express.Express {
  const { config, auth, lichess, sync } = dependencies;
  const openingPractice = dependencies.openingPractice ?? new OpeningPracticeClient({
    lichessBaseUrl: config.lichessBaseUrl,
  });
  const chessCom = dependencies.chessCom ?? new ChessComClient();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(validateLocalRequest(config));
  app.use(express.json({ limit: '16kb' }));

  const statusHandler = (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    const credential = auth.getCredential();
    if (!credential) return response.json({ connected: false });
    return response.json({
      connected: true,
      username: credential.username,
      expiresAt: new Date(credential.expiresAt).toISOString(),
    });
  };

  const loginHandler = (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    const previousSessionId = readCookie(request, SESSION_COOKIE);
    if (previousSessionId) auth.clearPending(previousSessionId);
    const sessionId = randomUrlSafe(32);
    const pkce = auth.begin(sessionId);
    setSessionCookie(response, sessionId, config);
    return response.json({ authorizationUrl: lichess.authorizationUrl(pkce.state, pkce.challenge) });
  };

  const logoutHandler = async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (sessionId) auth.clearPending(sessionId);
    clearSessionCookie(response, config);
    const credential = auth.clearCredential();
    if (credential) {
      try {
        await lichess.revoke(credential.accessToken);
      } catch {
        // Local logout must still succeed; the long-lived token is no longer retained.
      }
    }
    return response.json({});
  };

  app.get('/api/auth/status', statusHandler);
  app.post('/api/auth/login', loginHandler);
  app.delete('/api/auth/logout', logoutHandler);

  app.get(config.oauthCallbackPath, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const state = readQueryString(request.query.state);
    const sessionId = readCookie(request, SESSION_COOKIE);
    const pending = state && sessionId ? auth.consume(state, sessionId) : undefined;
    if (!pending) return renderAuthResult(response, config, 'error', 'state');
    if (readQueryString(request.query.error)) {
      return renderAuthResult(response, config, 'error', 'denied');
    }
    const code = readQueryString(request.query.code);
    if (!code || !isSafeOAuthValue(code)) {
      return renderAuthResult(response, config, 'error', 'code');
    }
    let uncommittedAccessToken: string | undefined;
    try {
      const token = await lichess.exchangeCode(code, pending.verifier);
      uncommittedAccessToken = token.access_token;
      const account = await lichess.account(token.access_token);
      if (account.username.toLocaleLowerCase('en-US') !== config.lichessUsername.toLocaleLowerCase('en-US')) {
        await revokeQuietly(lichess, token.access_token);
        return renderAuthResult(response, config, 'error', 'account');
      }
      auth.setCredential({
        accessToken: token.access_token,
        username: config.lichessUsername,
        expiresAt: Date.now() + token.expires_in * 1_000,
      });
      uncommittedAccessToken = undefined;
      return renderAuthResult(response, config, 'success');
    } catch {
      if (uncommittedAccessToken) await revokeQuietly(lichess, uncommittedAccessToken);
      return renderAuthResult(response, config, 'error', 'lichess');
    }
  });

  app.post('/api/sync', async (_request, response) => response.json(await sync.sync()));

  app.get('/api/library', async (_request, response) => {
    const catalog = await sync.library();
    return response.json({
      studies: catalog.studies.map((study) => ({
        id: study.id,
        name: study.name,
        orientation: study.orientation,
        updatedAt: study.updatedAt,
        chapters: study.chapters.map((chapter) => ({
          id: chapter.id,
          name: chapter.name,
          orientation: chapter.orientation,
          cardCount: chapter.cardCount,
          lineCount: chapter.lineCount,
          sourceUrl: chapter.sourceUrl,
        })),
      })),
      sample: false,
    });
  });

  app.get('/api/repertoires', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    return response.json({ studies: await sync.repertoires() });
  });

  app.get('/api/chapters/:id', async (request, response) => {
    const chapter = await sync.chapter(request.params.id);
    if (!chapter) return response.status(404).json({ error: { code: 'not_found', message: 'Chapter not found.' } });
    return response.json(chapter);
  });

  app.get('/api/opening-practice/explorer', async (request, response) => {
    const credential = auth.getCredential();
    if (!credential) throw new NotConnectedError();
    const result = await openingPractice.explore(
      parseExplorerQuery(request.query as Record<string, unknown>),
      credential.accessToken,
    );
    response.setHeader('Cache-Control', 'private, max-age=15');
    return response.json(result);
  });

  app.post('/api/opening-practice/evaluate', async (request, response) => {
    const parsed = parseEvaluationBody(request.body);
    response.setHeader('Cache-Control', 'no-store');
    return response.json(await openingPractice.evaluate(
      parsed.fen,
      parsed.move,
      parsed.maximumCentipawnLoss,
    ));
  });

  app.get('/api/chesscom/games', async (request, response) => {
    const parsed = parseChessComGamesQuery(request.query as Record<string, unknown>);
    response.setHeader('Cache-Control', 'private, max-age=60');
    return response.json(await chessCom.games(parsed));
  });

  // Compatibility aliases for early clients; the short routes above are canonical.
  app.get('/api/auth/lichess/status', statusHandler);
  app.post('/api/auth/lichess/start', loginHandler);
  app.delete('/api/auth/lichess', logoutHandler);
  app.post('/api/sync/lichess', async (_request, response) => response.json(await sync.sync()));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'API route not found.' } });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ChessComValidationError) {
      return response.status(400).json({ error: { code: 'invalid_request', message: error.message } });
    }
    if (error instanceof ChessComApiError) {
      const status = error.status === 404 || error.status === 410
        ? 404
        : error.status === 429
          ? 503
          : 502;
      if (error.retryAfterSeconds !== undefined) response.setHeader('Retry-After', error.retryAfterSeconds);
      return response.status(status).json({
        error: {
          code: error.status === 404
            ? 'chesscom_player_not_found'
            : error.status === 410
              ? 'chesscom_player_unavailable'
              : error.status === 429
                ? 'chesscom_rate_limited'
                : 'chesscom_error',
          message: error.message,
        },
      });
    }
    if (error instanceof OpeningPracticeValidationError) {
      return response.status(400).json({ error: { code: 'invalid_request', message: error.message } });
    }
    if (error instanceof OpeningDataError) {
      const status = error.status === 429 ? 503 : error.status === 401 || error.status === 403 ? 401 : 502;
      if (error.retryAfterSeconds !== undefined) response.setHeader('Retry-After', error.retryAfterSeconds);
      return response.status(status).json({
        error: {
          code: error.status === 429
            ? 'opening_data_rate_limited'
            : status === 401
              ? 'opening_data_unauthorized'
              : 'opening_data_error',
          message: error.message,
        },
      });
    }
    if (error instanceof NotConnectedError) {
      return response.status(401).json({ error: { code: 'not_connected', message: error.message } });
    }
    if (error instanceof SyncInProgressError) {
      return response.status(409).json({ error: { code: 'sync_in_progress', message: error.message } });
    }
    if (error instanceof SyncRateLimitedError) {
      response.setHeader('Retry-After', error.retryAfterSeconds ?? 60);
      return response.status(503).json({
        error: {
          code: 'rate_limited',
          message: error.message,
          rateLimitedUntil: error.rateLimitedUntil,
        },
      });
    }
    if (error instanceof LichessApiError) {
      const status = error.status === 429 ? 503 : error.status === 401 || error.status === 403 ? 401 : 502;
      if (error.retryAfterSeconds !== undefined) response.setHeader('Retry-After', error.retryAfterSeconds);
      return response.status(status).json({
        error: {
          code: error.status === 429 ? 'rate_limited' : 'lichess_error',
          message: error.message,
        },
      });
    }
    console.error('Opening Trainer request failed:', error instanceof Error ? error.message : 'unknown error');
    return response.status(500).json({ error: { code: 'internal_error', message: 'The request failed.' } });
  });

  return app;
}

function validateLocalRequest(config: ServerConfig) {
  const allowedHost = new URL(config.origin).host.toLocaleLowerCase('en-US');
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestHost = request.headers.host?.toLocaleLowerCase('en-US');
    if (requestHost !== allowedHost) {
      response.status(403).json({ error: { code: 'invalid_host', message: 'Invalid local host.' } });
      return;
    }
    const origin = request.headers.origin;
    const changesState = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (changesState && !origin) {
      response.status(403).json({ error: { code: 'missing_origin', message: 'Request origin is required.' } });
      return;
    }
    if (origin && origin !== config.origin) {
      response.status(403).json({ error: { code: 'invalid_origin', message: 'Invalid request origin.' } });
      return;
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (
      (changesState && fetchSite !== undefined && fetchSite !== 'same-origin')
      || (fetchSite === 'cross-site' && request.path !== config.oauthCallbackPath)
    ) {
      response.status(403).json({ error: { code: 'cross_site', message: 'Cross-site request rejected.' } });
      return;
    }
    next();
  };
}

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key === name && /^[A-Za-z0-9_-]{20,128}$/.test(value)) return value;
  }
  return undefined;
}

function setSessionCookie(response: Response, sessionId: string, config: ServerConfig): void {
  response.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(config.oauthPendingTtlMs / 1_000)}`,
    ...(config.origin.startsWith('https:') ? ['Secure'] : []),
  ].join('; '));
}

function clearSessionCookie(response: Response, config: ServerConfig): void {
  response.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(config.origin.startsWith('https:') ? ['Secure'] : []),
  ].join('; '));
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function revokeQuietly(lichess: LichessClient, accessToken: string): Promise<void> {
  try {
    await lichess.revoke(accessToken);
  } catch {
    // The token is intentionally discarded even if remote revocation fails.
  }
}

function renderAuthResult(
  response: Response,
  config: ServerConfig,
  result: 'success' | 'error',
  reason?: string,
): void {
  const target = new URL('/', config.origin);
  target.searchParams.set('auth', result);
  target.searchParams.set('lichess', result === 'success' ? 'connected' : 'error');
  if (reason) target.searchParams.set('reason', reason);
  const targetPath = `${target.pathname}${target.search}`;
  const scriptTarget = JSON.stringify(targetPath).replaceAll('<', '\\u003c');
  const linkTarget = targetPath
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const nonce = randomUrlSafe(18);

  // Finish the cross-site OAuth navigation here. A fresh navigation initiated by
  // this local page is same-origin; an HTTP redirect would remain cross-site and
  // be rejected by validateLocalRequest according to Fetch Metadata semantics.
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.status(200).type('html').send(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Opening Trainer</title>
</head>
<body>
  <p>Opening Trainer로 돌아가는 중입니다.</p>
  <script nonce="${nonce}">window.location.replace(${scriptTarget});</script>
  <noscript><a href="${linkTarget}">Opening Trainer로 돌아가기</a></noscript>
</body>
</html>`);
}

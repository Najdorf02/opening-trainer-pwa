import path from 'node:path';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

export interface ServerConfig {
  host: string;
  port: number;
  origin: string;
  dataDir: string;
  lichessBaseUrl: string;
  lichessUsername: string;
  oauthClientId: string;
  oauthCallbackPath: string;
  oauthPendingTtlMs: number;
  requestTimeoutMs: number;
  production: boolean;
}

function readPort(raw: string | undefined): number {
  const port = Number(raw ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new Error('OPENING_TRAINER_ORIGIN must be an HTTP loopback URL served by this app.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OPENING_TRAINER_ORIGIN must contain only scheme, loopback host, and port.');
  }
  return url.origin;
}

function validateOriginMatchesListener(origin: string, host: string, port: number): void {
  const url = new URL(origin);
  const originPort = url.port ? Number(url.port) : 80;
  const hostMatches = url.hostname === host || (host === '127.0.0.1' && url.hostname === 'localhost');
  if (!hostMatches || originPort !== port) {
    throw new Error('OPENING_TRAINER_ORIGIN must match the local server host and PORT.');
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const port = readPort(env.PORT);
  const host = '127.0.0.1';
  const origin = normalizeOrigin(env.OPENING_TRAINER_ORIGIN ?? `http://${host}:${port}`);
  validateOriginMatchesListener(origin, host, port);

  return {
    host,
    port,
    origin,
    dataDir: path.resolve(cwd, env.OPENING_TRAINER_DATA_DIR ?? '.data'),
    lichessBaseUrl: 'https://lichess.org',
    lichessUsername: 'SaturdayCthuns',
    oauthClientId: env.LICHESS_CLIENT_ID?.trim() || 'opening-trainer.local',
    oauthCallbackPath: '/api/auth/callback',
    oauthPendingTtlMs: 10 * 60 * 1_000,
    // Large studies can take Lichess noticeably longer to assemble as PGN.
    requestTimeoutMs: 120_000,
    production: env.NODE_ENV === 'production',
  };
}

export function oauthRedirectUri(config: ServerConfig): string {
  return new URL(config.oauthCallbackPath, `${config.origin}/`).toString();
}

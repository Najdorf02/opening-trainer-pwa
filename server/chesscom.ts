export const DEFAULT_CHESSCOM_USERNAME = 'Yshaarrj';
export const DEFAULT_CHESSCOM_MONTHS = 3;
export const MAX_CHESSCOM_MONTHS = 12;

const DEFAULT_BASE_URL = 'https://api.chess.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_USER_AGENT = 'Opening-Trainer/0.1 (Chess.com user: Yshaarrj)';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

export interface ChessComGamesRequest {
  username: string;
  months: number;
}

export interface ChessComGamePlayer {
  username: string;
  rating?: number;
  result: string;
}

export interface ChessComGame {
  id: string;
  url: string;
  pgn: string;
  endTime: number;
  timeClass: string;
  timeControl: string;
  rated: boolean;
  rules: string;
  white: ChessComGamePlayer;
  black: ChessComGamePlayer;
}

export interface ChessComGamesResponse {
  username: string;
  fetchedAt: string;
  archivesChecked: number;
  games: ChessComGame[];
}

export interface ChessComGamesGateway {
  games(request: ChessComGamesRequest): Promise<ChessComGamesResponse>;
}

export interface ChessComClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ArchiveMonth {
  year: string;
  month: string;
}

export class ChessComValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChessComValidationError';
  }
}

export class ChessComApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ChessComApiError';
  }
}

export class ChessComClient implements ChessComGamesGateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly archiveCache: TimedCache<ArchiveMonth[]>;
  private readonly monthCache: TimedCache<ChessComGame[]>;
  private outboundRequestTail: Promise<void> = Promise.resolve();
  private rateLimitedUntil = 0;

  constructor(options: ChessComClientOptions = {}) {
    this.baseUrl = normalizeHttpsBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('Chess.com timeout must be between 100 and 60000 milliseconds.');
    }
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    if (
      this.userAgent.length < 1
      || this.userAgent.length > 256
      || !/^[\x20-\x7e]+$/u.test(this.userAgent)
    ) {
      throw new Error('Chess.com User-Agent must contain printable ASCII characters.');
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.archiveCache = new TimedCache(cacheTtlMs, 64, this.now);
    this.monthCache = new TimedCache(cacheTtlMs, 256, this.now);
  }

  async games(request: ChessComGamesRequest): Promise<ChessComGamesResponse> {
    const normalized = validateGamesRequest(request);
    const pathUsername = normalized.username.toLocaleLowerCase('en-US');
    const archives = await this.archives(pathUsername);
    const selected = recentArchives(archives, normalized.months, this.now());
    const games: ChessComGame[] = [];

    // Chess.com asks PubAPI consumers to make serial, rather than parallel,
    // requests. Keep this loop sequential even though months are independent.
    for (const archive of selected) {
      games.push(...await this.month(pathUsername, archive));
    }

    const uniqueGames = new Map<string, ChessComGame>();
    for (const game of games) uniqueGames.set(game.id, game);
    return {
      username: normalized.username,
      fetchedAt: new Date(this.now()).toISOString(),
      archivesChecked: selected.length,
      games: [...uniqueGames.values()].sort((left, right) => (
        right.endTime - left.endTime || left.id.localeCompare(right.id)
      )),
    };
  }

  private archives(username: string): Promise<ArchiveMonth[]> {
    return this.archiveCache.getOrLoad(username, async () => {
      const url = new URL(`/pub/player/${encodeURIComponent(username)}/games/archives`, this.baseUrl);
      const payload = await this.enqueueRequest(() => this.requestJson(url));
      return parseArchives(payload, this.baseUrl, username);
    });
  }

  private month(username: string, archive: ArchiveMonth): Promise<ChessComGame[]> {
    const cacheKey = `${username}/${archive.year}/${archive.month}`;
    return this.monthCache.getOrLoad(cacheKey, async () => {
      const url = new URL(
        `/pub/player/${encodeURIComponent(username)}/games/${archive.year}/${archive.month}`,
        this.baseUrl,
      );
      const payload = await this.enqueueRequest(() => this.requestJson(url));
      return parseMonthlyGames(payload);
    });
  }

  private async enqueueRequest<T>(request: () => Promise<T>): Promise<T> {
    const pending = this.outboundRequestTail.then(request, request);
    this.outboundRequestTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async requestJson(url: URL): Promise<unknown> {
    const now = this.now();
    if (this.rateLimitedUntil > now) {
      throw new ChessComApiError(
        'Chess.com public API rate limit reached.',
        429,
        Math.max(1, Math.ceil((this.rateLimitedUntil - now) / 1_000)),
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new ChessComApiError('Could not reach the Chess.com public API.', 502);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const retryAfterSeconds = response.status === 429
        ? readRetryAfter(response.headers.get('Retry-After'), this.now()) ?? 60
        : undefined;
      if (response.status === 429 && retryAfterSeconds !== undefined) {
        this.rateLimitedUntil = this.now() + retryAfterSeconds * 1_000;
      }
      throw new ChessComApiError(
        response.status === 404
          ? 'Chess.com player or game archive was not found.'
          : response.status === 410
            ? 'Chess.com player data is no longer available.'
            : response.status === 429
              ? 'Chess.com public API rate limit reached.'
              : 'Chess.com public API rejected the request.',
        response.status,
        retryAfterSeconds,
      );
    }

    const text = await readLimitedResponseText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ChessComApiError('Chess.com public API returned invalid JSON.', 502);
    }
  }
}

function recentArchives(
  archives: readonly ArchiveMonth[],
  months: number,
  now: number,
): ArchiveMonth[] {
  const current = new Date(now);
  const currentMonth = current.getUTCFullYear() * 12 + current.getUTCMonth();
  const firstMonth = currentMonth - months + 1;

  return archives.filter((archive) => {
    const archiveMonth = Number(archive.year) * 12 + Number(archive.month) - 1;
    return archiveMonth >= firstMonth && archiveMonth <= currentMonth;
  }).reverse();
}

export function parseChessComGamesQuery(query: Record<string, unknown>): ChessComGamesRequest {
  const username = query.username === undefined
    ? DEFAULT_CHESSCOM_USERNAME
    : readQueryString(query.username, 'username');
  const months = query.months === undefined
    ? DEFAULT_CHESSCOM_MONTHS
    : parseMonths(readQueryString(query.months, 'months'));
  return validateGamesRequest({ username, months });
}

function validateGamesRequest(request: ChessComGamesRequest): ChessComGamesRequest {
  if (typeof request.username !== 'string') {
    throw new ChessComValidationError('username must be a single Chess.com username.');
  }
  const username = request.username.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new ChessComValidationError('username must be a valid Chess.com username.');
  }
  if (!Number.isInteger(request.months) || request.months < 1 || request.months > MAX_CHESSCOM_MONTHS) {
    throw new ChessComValidationError(`months must be an integer between 1 and ${MAX_CHESSCOM_MONTHS}.`);
  }
  return { username, months: request.months };
}

function parseMonths(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new ChessComValidationError(`months must be an integer between 1 and ${MAX_CHESSCOM_MONTHS}.`);
  }
  return Number(value);
}

function parseArchives(payload: unknown, baseUrl: string, username: string): ArchiveMonth[] {
  if (!isObject(payload) || !Array.isArray(payload.archives) || payload.archives.length > 1_200) {
    throw invalidUpstream('archive list');
  }
  const origin = new URL(baseUrl).origin;
  const archives = new Map<string, ArchiveMonth>();
  for (const raw of payload.archives) {
    if (typeof raw !== 'string' || raw.length > 2_048) throw invalidUpstream('archive URL');
    let archiveUrl: URL;
    try {
      archiveUrl = new URL(raw);
    } catch {
      throw invalidUpstream('archive URL');
    }
    const match = /^\/pub\/player\/([^/]+)\/games\/(\d{4})\/(0[1-9]|1[0-2])\/?$/u.exec(archiveUrl.pathname);
    let archiveUsername: string;
    try {
      archiveUsername = match ? decodeURIComponent(match[1]) : '';
    } catch {
      throw invalidUpstream('archive URL');
    }
    if (
      archiveUrl.origin !== origin
      || !match
      || archiveUsername.toLocaleLowerCase('en-US') !== username
    ) {
      throw invalidUpstream('archive URL');
    }
    const archive = { year: match[2], month: match[3] };
    archives.set(`${archive.year}/${archive.month}`, archive);
  }
  return [...archives.values()].sort((left, right) => (
    left.year.localeCompare(right.year) || left.month.localeCompare(right.month)
  ));
}

function parseMonthlyGames(payload: unknown): ChessComGame[] {
  if (!isObject(payload) || !Array.isArray(payload.games) || payload.games.length > 10_000) {
    throw invalidUpstream('monthly games');
  }
  return payload.games.map((game, index) => parseGame(game, index));
}

function parseGame(value: unknown, index: number): ChessComGame {
  if (!isObject(value)) throw invalidUpstream(`game ${index + 1}`);
  const url = readUpstreamString(value.url, `game ${index + 1} URL`, 4_096);
  const uuid = value.uuid === undefined
    ? undefined
    : readUpstreamString(value.uuid, `game ${index + 1} id`, 256);
  if (!Number.isSafeInteger(value.end_time) || Number(value.end_time) < 0) {
    throw invalidUpstream(`game ${index + 1} end_time`);
  }
  if (typeof value.rated !== 'boolean') throw invalidUpstream(`game ${index + 1} rated`);

  return {
    id: uuid ?? url,
    url,
    pgn: readUpstreamString(value.pgn, `game ${index + 1} PGN`, MAX_RESPONSE_BYTES),
    endTime: Number(value.end_time),
    timeClass: readUpstreamString(value.time_class, `game ${index + 1} time_class`, 32),
    timeControl: readUpstreamString(value.time_control, `game ${index + 1} time_control`, 64),
    rated: value.rated,
    rules: readUpstreamString(value.rules, `game ${index + 1} rules`, 64),
    white: parsePlayer(value.white, `game ${index + 1} white player`),
    black: parsePlayer(value.black, `game ${index + 1} black player`),
  };
}

function parsePlayer(value: unknown, name: string): ChessComGamePlayer {
  if (!isObject(value)) throw invalidUpstream(name);
  const rating = value.rating;
  if (rating !== undefined && (!Number.isSafeInteger(rating) || Number(rating) < 0 || Number(rating) > 10_000)) {
    throw invalidUpstream(`${name} rating`);
  }
  return {
    username: readUpstreamString(value.username, `${name} username`, 64),
    ...(rating === undefined ? {} : { rating: Number(rating) }),
    result: readUpstreamString(value.result, `${name} result`, 64),
  };
}

function readQueryString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 128) {
    throw new ChessComValidationError(`${name} must be a single string.`);
  }
  return value;
}

function readUpstreamString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw invalidUpstream(name);
  }
  return value;
}

function invalidUpstream(name: string): ChessComApiError {
  return new ChessComApiError(`Chess.com public API returned invalid ${name}.`, 502);
}

function normalizeHttpsBaseUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Chess.com base URL must use HTTPS, except for HTTP loopback tests.');
  }
  return url.origin;
}

function readRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1_000)) : undefined;
}

async function readLimitedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ChessComApiError('Chess.com public API response was too large.', 502);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size error if cancelling an already-broken stream fails.
        }
        throw new ChessComApiError('Chess.com public API response was too large.', 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof ChessComApiError) throw error;
    throw new ChessComApiError('Could not read the Chess.com public API response.', 502);
  } finally {
    reader.releaseLock();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class TimedCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maximumEntries: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new Error('Cache TTL must be non-negative.');
  }

  async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (cached) this.entries.delete(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = load().then((value) => {
      this.prune();
      while (this.entries.size >= this.maximumEntries) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

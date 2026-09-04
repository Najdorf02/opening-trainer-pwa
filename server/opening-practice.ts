import { Chess, type Color } from 'chess.js';
import {
  DEFAULT_SOUNDNESS_POLICY,
  type MoveEvaluationEvidence,
  type OpeningExplorerPosition,
} from '../shared/opening-practice.js';

export const DEFAULT_PRACTICE_SPEEDS = ['blitz', 'rapid', 'classical'] as const;
export const DEFAULT_PRACTICE_RATINGS = [1600, 1800, 2000, 2200, 2500] as const;
export const DEFAULT_MAX_CPL = 80;

export type OpeningSpeed =
  | 'ultraBullet'
  | 'bullet'
  | 'blitz'
  | 'rapid'
  | 'classical'
  | 'correspondence';

export interface OpeningExplorerRequest {
  fen: string;
  speeds: OpeningSpeed[];
  ratings: number[];
  moves: number;
}

export interface OpeningName {
  eco: string;
  name: string;
}

export interface OpeningExplorerResponse extends OpeningExplorerPosition {
  opening?: OpeningName;
}

export type EvaluationScore =
  | { type: 'cp'; value: number }
  | { type: 'mate'; value: number };

export interface CloudEvaluationSummary {
  depth: number;
  score: EvaluationScore;
}

export interface CloudBestMove {
  uci: string;
  san?: string;
  score: EvaluationScore;
}

export type EvaluationUnavailableReason =
  | 'position_not_cached'
  | 'child_not_cached'
  | 'insufficient_depth'
  | 'upstream_unavailable';

export type OpeningPracticeEvaluationResponse =
  | {
    status: 'graded';
    verdict: 'pass' | 'fail';
    passed: boolean;
    reason:
      | 'engine-within-threshold'
      | 'engine-loss-too-large'
      | 'engine-forced-mate-lost';
    move: { uci: string; san: string };
    centipawnLoss: number;
    thresholdCp: number;
    depth: number;
    before: CloudEvaluationSummary;
    after: CloudEvaluationSummary;
    bestMoves: CloudBestMove[];
  }
  | {
    status: 'unavailable';
    reason: EvaluationUnavailableReason;
    move: { uci: string; san: string };
  };

export interface OpeningPracticeGateway {
  explore(request: OpeningExplorerRequest, accessToken: string): Promise<OpeningExplorerResponse>;
  evaluate(fen: string, move: string, maximumCentipawnLoss?: number): Promise<OpeningPracticeEvaluationResponse>;
}

export interface OpeningPracticeClientOptions {
  explorerBaseUrl?: string;
  lichessBaseUrl?: string;
  timeoutMs?: number;
  explorerCacheTtlMs?: number;
  cloudCacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CloudVariation {
  score: EvaluationScore;
  moves: string[];
}

interface CloudEvaluation {
  depth: number;
  variations: CloudVariation[];
}

const SPEEDS = new Set<OpeningSpeed>([
  'ultraBullet',
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'correspondence',
]);
const RATINGS = new Set([0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500]);
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MATE_SCORE = 100_000;

export class OpeningPracticeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningPracticeValidationError';
  }
}

export class OpeningDataError extends Error {
  constructor(
    message: string,
    readonly source: 'explorer' | 'cloud',
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OpeningDataError';
  }
}

export class OpeningPracticeClient implements OpeningPracticeGateway {
  private readonly explorerBaseUrl: string;
  private readonly lichessBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly explorerCache: TimedCache<OpeningExplorerResponse>;
  private readonly cloudCache: TimedCache<CloudEvaluation | undefined>;
  private outboundRequestTail: Promise<void> = Promise.resolve();

  constructor(options: OpeningPracticeClientOptions = {}) {
    this.explorerBaseUrl = normalizeHttpsBaseUrl(
      options.explorerBaseUrl ?? 'https://explorer.lichess.org',
      'Explorer',
    );
    this.lichessBaseUrl = normalizeHttpsBaseUrl(
      options.lichessBaseUrl ?? 'https://lichess.org',
      'Lichess',
    );
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('Opening data timeout must be between 100 and 60000 milliseconds.');
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const now = options.now ?? Date.now;
    this.explorerCache = new TimedCache(options.explorerCacheTtlMs ?? 30_000, 256, now);
    this.cloudCache = new TimedCache(options.cloudCacheTtlMs ?? 5 * 60_000, 512, now);
  }

  async explore(
    request: OpeningExplorerRequest,
    accessToken: string,
  ): Promise<OpeningExplorerResponse> {
    const normalized = validateExplorerRequest(request);
    if (!isSafeBearerToken(accessToken)) {
      throw new OpeningPracticeValidationError('A valid Lichess access token is required.');
    }
    const query = new URLSearchParams({
      variant: 'standard',
      fen: normalized.fen,
      speeds: normalized.speeds.join(','),
      ratings: normalized.ratings.join(','),
      moves: String(normalized.moves),
      topGames: '0',
      recentGames: '0',
      history: 'false',
    });
    const cacheKey = query.toString();
    return this.explorerCache.getOrLoad(cacheKey, async () => {
      const payload = await this.enqueueRequest(
        () => this.requestJson(
          new URL(`/lichess?${query}`, this.explorerBaseUrl),
          'explorer',
          { Authorization: `Bearer ${accessToken}` },
        ),
      );
      return parseExplorerResponse(payload, normalized.fen);
    });
  }

  async evaluate(
    fen: string,
    move: string,
    maximumCentipawnLoss = DEFAULT_MAX_CPL,
  ): Promise<OpeningPracticeEvaluationResponse> {
    const position = parseFen(fen);
    const threshold = validateMaximumCentipawnLoss(maximumCentipawnLoss);
    const normalizedMove = normalizeUci(move);
    const mover = position.turn();
    const played = playUci(position, normalizedMove);
    const moveDescription = { uci: normalizedMove, san: played.san };
    const childFen = position.fen();

    let before: CloudEvaluation | undefined;
    try {
      before = await this.cloudEvaluation(canonicalFen(fen));
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      return { status: 'unavailable', reason: 'upstream_unavailable', move: moveDescription };
    }
    if (!before) {
      return { status: 'unavailable', reason: 'position_not_cached', move: moveDescription };
    }
    if (before.depth < DEFAULT_SOUNDNESS_POLICY.minimumEngineDepth) {
      return { status: 'unavailable', reason: 'insufficient_depth', move: moveDescription };
    }

    let after: CloudEvaluation | undefined;
    try {
      after = await this.cloudEvaluation(childFen);
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      return { status: 'unavailable', reason: 'upstream_unavailable', move: moveDescription };
    }
    if (!after) {
      return { status: 'unavailable', reason: 'child_not_cached', move: moveDescription };
    }
    if (after.depth < DEFAULT_SOUNDNESS_POLICY.minimumEngineDepth) {
      return { status: 'unavailable', reason: 'insufficient_depth', move: moveDescription };
    }

    const beforeBest = selectBestVariation(before.variations, mover);
    const afterBest = selectBestVariation(after.variations, opposite(mover));
    if (!beforeBest || !afterBest) {
      return { status: 'unavailable', reason: 'upstream_unavailable', move: moveDescription };
    }
    const loss = centipawnLoss(beforeBest.score, afterBest.score, mover);
    const forcedMateLost = favorableMate(beforeBest.score, mover) && !favorableMate(afterBest.score, mover);
    const passed = !forcedMateLost && loss <= threshold;
    const evidence: MoveEvaluationEvidence = {
      depth: Math.min(before.depth, after.depth),
      centipawnLoss: loss,
      forcedMateLost,
    };

    return {
      status: 'graded',
      verdict: passed ? 'pass' : 'fail',
      passed,
      reason: forcedMateLost
        ? 'engine-forced-mate-lost'
        : passed
          ? 'engine-within-threshold'
          : 'engine-loss-too-large',
      move: moveDescription,
      centipawnLoss: evidence.centipawnLoss ?? 0,
      thresholdCp: threshold,
      depth: evidence.depth,
      before: { depth: before.depth, score: beforeBest.score },
      after: { depth: after.depth, score: afterBest.score },
      bestMoves: before.variations.map((variation) => describeBestMove(fen, variation)),
    };
  }

  private async cloudEvaluation(fen: string): Promise<CloudEvaluation | undefined> {
    const query = new URLSearchParams({ fen, multiPv: '5', variant: 'standard' });
    const cacheKey = query.toString();
    return this.cloudCache.getOrLoad(cacheKey, async () => {
      const url = new URL(`/api/cloud-eval?${query}`, this.lichessBaseUrl);
      const payload = await this.enqueueRequest(
        () => this.requestJson(url, 'cloud', undefined, true),
      );
      return payload === undefined ? undefined : parseCloudEvaluation(payload);
    });
  }

  private async enqueueRequest<T>(request: () => Promise<T>): Promise<T> {
    const pending = this.outboundRequestTail.then(request, request);
    this.outboundRequestTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async requestJson(
    url: URL,
    source: 'explorer' | 'cloud',
    extraHeaders?: Record<string, string>,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          ...extraHeaders,
        },
        signal: controller.signal,
      });
    } catch {
      throw new OpeningDataError(`Could not reach Lichess ${source}.`, source, 502);
    } finally {
      clearTimeout(timeout);
    }
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new OpeningDataError(
        response.status === 429
          ? `Lichess ${source} rate limit reached.`
          : `Lichess ${source} rejected the request.`,
        source,
        response.status,
        readRetryAfter(response.headers.get('Retry-After')),
      );
    }
    const text = await readLimitedResponseText(response, source);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpeningDataError(`Lichess ${source} returned invalid JSON.`, source, 502);
    }
  }
}

export function parseExplorerQuery(query: Record<string, unknown>): OpeningExplorerRequest {
  const fen = readSingleString(query.fen, 'fen');
  return validateExplorerRequest({
    fen,
    speeds: query.speeds === undefined
      ? [...DEFAULT_PRACTICE_SPEEDS]
      : parseCsv(query.speeds, 'speeds') as OpeningSpeed[],
    ratings: query.ratings === undefined
      ? [...DEFAULT_PRACTICE_RATINGS]
      : parseCsv(query.ratings, 'ratings').map((rating) => parseDecimalInteger(rating, 'ratings')),
    moves: query.moves === undefined
      ? 12
      : parseDecimalInteger(readSingleString(query.moves, 'moves'), 'moves'),
  });
}

export function parseEvaluationBody(body: unknown): {
  fen: string;
  move: string;
  maximumCentipawnLoss: number;
} {
  if (!isObject(body)) throw new OpeningPracticeValidationError('A JSON object is required.');
  const fen = readSingleString(body.fen, 'fen');
  const move = readSingleString(body.move, 'move');
  const maximumCentipawnLoss = body.maxCpl === undefined
    ? DEFAULT_MAX_CPL
    : validateMaximumCentipawnLoss(body.maxCpl);
  const chess = parseFen(fen);
  playUci(chess, normalizeUci(move));
  return { fen: canonicalFen(fen), move: normalizeUci(move), maximumCentipawnLoss };
}

function validateExplorerRequest(request: OpeningExplorerRequest): OpeningExplorerRequest {
  const fen = canonicalFen(request.fen);
  if (!Array.isArray(request.speeds) || request.speeds.length < 1 || request.speeds.length > SPEEDS.size) {
    throw new OpeningPracticeValidationError('speeds must contain one or more supported speeds.');
  }
  const speeds = unique(request.speeds);
  if (speeds.some((speed) => !SPEEDS.has(speed))) {
    throw new OpeningPracticeValidationError('speeds contains an unsupported value.');
  }
  if (!Array.isArray(request.ratings) || request.ratings.length < 1 || request.ratings.length > RATINGS.size) {
    throw new OpeningPracticeValidationError('ratings must contain one or more supported rating groups.');
  }
  const ratings = unique(request.ratings);
  if (ratings.some((rating) => !RATINGS.has(rating))) {
    throw new OpeningPracticeValidationError('ratings contains an unsupported value.');
  }
  if (!Number.isInteger(request.moves) || request.moves < 1 || request.moves > 24) {
    throw new OpeningPracticeValidationError('moves must be an integer between 1 and 24.');
  }
  return { fen, speeds, ratings, moves: request.moves };
}

function parseExplorerResponse(payload: unknown, fen: string): OpeningExplorerResponse {
  if (!isObject(payload) || !Array.isArray(payload.moves)) {
    throw new OpeningDataError('Lichess explorer returned an invalid response.', 'explorer', 502);
  }
  const results = {
    whiteWins: readCount(payload.white, 'white', 'explorer'),
    draws: readCount(payload.draws, 'draws', 'explorer'),
    blackWins: readCount(payload.black, 'black', 'explorer'),
  };
  const moves = payload.moves.map((raw, index) => {
    if (!isObject(raw)) {
      throw new OpeningDataError(`Lichess explorer move ${index + 1} was invalid.`, 'explorer', 502);
    }
    const uci = readUci(raw.uci, `moves[${index}].uci`, 'explorer');
    const board = parseFen(fen);
    let played;
    try {
      played = playUci(board, uci);
    } catch {
      throw new OpeningDataError(`Lichess explorer move ${index + 1} was illegal.`, 'explorer', 502);
    }
    const averageRating = readCount(raw.averageRating, `moves[${index}].averageRating`, 'explorer');
    return {
      uci,
      san: played.san,
      averageRating,
      results: {
        whiteWins: readCount(raw.white, `moves[${index}].white`, 'explorer'),
        draws: readCount(raw.draws, `moves[${index}].draws`, 'explorer'),
        blackWins: readCount(raw.black, `moves[${index}].black`, 'explorer'),
      },
    };
  });
  const opening = parseOpening(payload.opening);
  return { fen, results, moves, ...(opening ? { opening } : {}) };
}

function parseOpening(value: unknown): OpeningName | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isObject(value)
    || typeof value.eco !== 'string'
    || !/^[A-E][0-9]{2}$/u.test(value.eco)
    || typeof value.name !== 'string'
    || value.name.length < 1
    || value.name.length > 256
  ) {
    throw new OpeningDataError('Lichess explorer returned invalid opening metadata.', 'explorer', 502);
  }
  return { eco: value.eco, name: value.name };
}

function parseCloudEvaluation(payload: unknown): CloudEvaluation {
  if (!isObject(payload) || !Number.isSafeInteger(payload.depth) || Number(payload.depth) < 1 || !Array.isArray(payload.pvs)) {
    throw new OpeningDataError('Lichess cloud evaluation was invalid.', 'cloud', 502);
  }
  const variations = payload.pvs.map((raw, index) => {
    if (!isObject(raw) || typeof raw.moves !== 'string') {
      throw new OpeningDataError(`Lichess cloud variation ${index + 1} was invalid.`, 'cloud', 502);
    }
    const moves = raw.moves.trim() ? raw.moves.trim().split(/\s+/u) : [];
    if (moves.length === 0 || moves.some((move) => !UCI_PATTERN.test(move))) {
      throw new OpeningDataError(`Lichess cloud variation ${index + 1} had invalid moves.`, 'cloud', 502);
    }
    const hasCp = Number.isSafeInteger(raw.cp);
    const hasMate = Number.isSafeInteger(raw.mate) && Number(raw.mate) !== 0;
    if (hasCp === hasMate) {
      throw new OpeningDataError(`Lichess cloud variation ${index + 1} had an invalid score.`, 'cloud', 502);
    }
    const score: EvaluationScore = hasCp
      ? { type: 'cp', value: Number(raw.cp) }
      : { type: 'mate', value: Number(raw.mate) };
    return { score, moves };
  });
  if (variations.length === 0 || variations.length > 5) {
    throw new OpeningDataError('Lichess cloud evaluation had no usable variations.', 'cloud', 502);
  }
  return { depth: Number(payload.depth), variations };
}

function describeBestMove(fen: string, variation: CloudVariation): CloudBestMove {
  const uci = variation.moves[0];
  try {
    const played = playUci(parseFen(fen), uci);
    return { uci, san: played.san, score: variation.score };
  } catch {
    // Cloud PVs may use Chess960-compatible king-to-rook castling notation.
    return { uci, score: variation.score };
  }
}

function selectBestVariation(variations: CloudVariation[], sideToMove: Color): CloudVariation | undefined {
  return variations.reduce<CloudVariation | undefined>((best, variation) => {
    if (!best) return variation;
    const score = numericScore(variation.score);
    const bestScore = numericScore(best.score);
    return sideToMove === 'w'
      ? score > bestScore ? variation : best
      : score < bestScore ? variation : best;
  }, undefined);
}

function centipawnLoss(before: EvaluationScore, after: EvaluationScore, mover: Color): number {
  const signedLoss = mover === 'w'
    ? numericScore(before) - numericScore(after)
    : numericScore(after) - numericScore(before);
  return Math.max(0, Math.round(signedLoss));
}

function numericScore(score: EvaluationScore): number {
  if (score.type === 'cp') return Math.max(-50_000, Math.min(50_000, score.value));
  const distance = Math.min(99_999, Math.abs(score.value));
  return Math.sign(score.value) * (MATE_SCORE - distance);
}

function favorableMate(score: EvaluationScore, mover: Color): boolean {
  return score.type === 'mate' && (mover === 'w' ? score.value > 0 : score.value < 0);
}

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function canonicalFen(fen: string): string {
  return parseFen(fen).fen();
}

function parseFen(value: unknown): Chess {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new OpeningPracticeValidationError('fen must be a valid standard chess FEN.');
  }
  try {
    return new Chess(value);
  } catch {
    throw new OpeningPracticeValidationError('fen must be a valid standard chess FEN.');
  }
}

function normalizeUci(value: string): string {
  const move = value.trim().toLowerCase();
  if (!UCI_PATTERN.test(move)) {
    throw new OpeningPracticeValidationError('move must be a legal UCI move.');
  }
  return move;
}

function playUci(chess: Chess, uci: string) {
  try {
    const played = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci[4] } : {}),
    });
    if (!played) throw new Error('illegal move');
    return played;
  } catch {
    throw new OpeningPracticeValidationError('move must be legal in the supplied position.');
  }
}

function validateMaximumCentipawnLoss(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 20 || value > 300) {
    throw new OpeningPracticeValidationError('maxCpl must be an integer between 20 and 300.');
  }
  return value;
}

function parseDecimalInteger(value: string, name: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new OpeningPracticeValidationError(`${name} must contain decimal integers.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new OpeningPracticeValidationError(`${name} must contain safe decimal integers.`);
  }
  return parsed;
}

function parseCsv(value: unknown, name: string): string[] {
  const raw = readSingleString(value, name);
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0 || values.some((item) => item.length > 32)) {
    throw new OpeningPracticeValidationError(`${name} must be a comma-separated list.`);
  }
  return values;
}

function readSingleString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new OpeningPracticeValidationError(`${name} must be a single string.`);
  }
  return value;
}

function readUci(value: unknown, name: string, source: 'explorer' | 'cloud'): string {
  if (typeof value !== 'string' || !UCI_PATTERN.test(value)) {
    throw new OpeningDataError(`Lichess ${source} returned invalid ${name}.`, source, 502);
  }
  return value;
}

function readCount(value: unknown, name: string, source: 'explorer' | 'cloud'): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OpeningDataError(`Lichess ${source} returned invalid ${name}.`, source, 502);
  }
  return Number(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeBearerToken(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && /^[\x21-\x7e]+$/u.test(value);
}

function isRateLimitError(error: unknown): error is OpeningDataError {
  return error instanceof OpeningDataError && error.status === 429;
}

function normalizeHttpsBaseUrl(raw: string, name: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} base URL must use HTTPS, except for HTTP loopback tests.`);
  }
  return url.origin;
}

function readRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

async function readLimitedResponseText(
  response: Response,
  source: 'explorer' | 'cloud',
): Promise<string> {
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
        throw new OpeningDataError(`Lichess ${source} response was too large.`, source, 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof OpeningDataError) throw error;
    throw new OpeningDataError(`Could not read Lichess ${source} response.`, source, 502);
  } finally {
    reader.releaseLock();
  }
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

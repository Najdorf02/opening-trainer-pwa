import { Chess, type Square } from 'chess.js';
import stockfishScriptUrl from 'stockfish/bin/stockfish-18-lite-single.js?url';
import stockfishWasmUrl from 'stockfish/bin/stockfish-18-lite-single.wasm?url';
import stockfishLicenseUrl from 'stockfish/Copying.txt?url';
import type { EvaluationScore, OpeningEvaluationMove, OpeningMoveEvaluation } from './types.js';

const MATE_SCORE = 100_000;
const MAX_CP_SCORE = 50_000;

export const LOCAL_ENGINE_DEFAULTS = Object.freeze({
  suggestionDepth: 14,
  suggestionMultiPv: 5,
  suggestionMaximumCentipawnLoss: 45,
  evaluationDepth: 16,
  evaluationMaximumCentipawnLoss: 80,
  startupTimeoutMs: 30_000,
  searchTimeoutMs: 30_000,
});

export const LOCAL_ENGINE_NOTICE = Object.freeze({
  name: 'Stockfish.js lite single-threaded',
  version: '18.0.8',
  license: 'GPL-3.0',
  licenseUrl: stockfishLicenseUrl,
  sourceUrl: 'https://github.com/nmrugg/stockfish.js/tree/v18.0.0',
  upstreamSourceUrl: 'https://github.com/official-stockfish/Stockfish',
});

export interface LocalEngineCandidate {
  uci: string;
  /** UCI score from the root side-to-move's point of view. */
  score: EvaluationScore;
  depth: number;
  pv: string[];
  centipawnLoss: number;
}

export interface LocalMoveSuggestion {
  uci: string;
  score: EvaluationScore;
  depth: number;
  /** MultiPV moves within maxCpl of best, always including the best move. */
  candidates: LocalEngineCandidate[];
}

export interface LocalMoveSuggestionOptions {
  depth?: number;
  multiPv?: number;
  maxCpl?: number;
  signal?: AbortSignal;
  random?: () => number;
}

export interface LocalMoveEvaluationInput {
  fen: string;
  uci: string;
  san?: string;
}

export interface LocalMoveEvaluationOptions {
  depth?: number;
  maxCpl?: number;
  signal?: AbortSignal;
}

export type LocalEngineErrorCode =
  | 'disposed'
  | 'invalid-position'
  | 'invalid-move'
  | 'no-legal-move'
  | 'timeout'
  | 'worker-error';

export class LocalEngineError extends Error {
  constructor(
    readonly code: LocalEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalEngineError';
  }
}

/** Minimal surface implemented by browser Workers and fake test workers. */
export interface LocalEngineWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: string): void;
  terminate(): void;
}

export interface LocalStockfishEngineOptions {
  workerFactory?: () => LocalEngineWorker;
  startupTimeoutMs?: number;
  searchTimeoutMs?: number;
}

interface InfoLine {
  depth: number;
  multiPv: number;
  score: EvaluationScore;
  pv: string[];
  bound: boolean;
}

interface SearchResult {
  bestMove: string;
  lines: InfoLine[];
}

interface Waiter {
  generation: number;
  accept: (line: string) => boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

interface QueueEntry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  queuedAbort?: () => void;
  started: boolean;
  settled: boolean;
}

function createDefaultWorker(): LocalEngineWorker {
  if (typeof Worker === 'undefined') {
    throw new LocalEngineError('worker-error', 'Web Workers are unavailable in this browser.');
  }
  // The distributed classic-script loader decodes hash field 1 as its WASM URL.
  // Its internal auxiliary Workers add the `worker` marker themselves.
  const url = `${stockfishScriptUrl}#${encodeURIComponent(stockfishWasmUrl)}`;
  return new Worker(url, { name: 'opening-trainer-stockfish' }) as unknown as LocalEngineWorker;
}

export class LocalStockfishEngine {
  private readonly workerFactory: () => LocalEngineWorker;
  private readonly startupTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  private worker: LocalEngineWorker | null = null;
  private generation = 0;
  private ready = false;
  private multiPv = 1;
  private waiter: Waiter | null = null;
  private queue: QueueEntry[] = [];
  private current: QueueEntry | null = null;
  private pumping = false;
  private disposed = false;

  constructor(options: LocalStockfishEngineOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
    this.startupTimeoutMs = positive(options.startupTimeoutMs, 30_000, 'startupTimeoutMs');
    this.searchTimeoutMs = positive(options.searchTimeoutMs, 30_000, 'searchTimeoutMs');
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  suggest(fen: string, options: LocalMoveSuggestionOptions = {}): Promise<LocalMoveSuggestion> {
    const position = validPosition(fen, true).fen();
    const depth = integer(options.depth, 14, 1, 30, 'depth');
    const multiPv = integer(options.multiPv, 5, 1, 10, 'multiPv');
    const maxCpl = numberInRange(options.maxCpl, 45, 0, 5_000, 'maxCpl');

    return this.enqueue(async () => {
      const result = await this.search(position, depth, multiPv, undefined, options.signal);
      const best = bestLine(result);
      const candidates = uniqueLines(result.lines)
        .map((line): LocalEngineCandidate => ({
          uci: line.pv[0],
          score: line.score,
          depth: line.depth,
          pv: [...line.pv],
          centipawnLoss: scoreLoss(best.score, line.score),
        }))
        .filter((candidate) => candidate.uci === best.pv[0]
          || (!losesMate(best.score, candidate.score) && candidate.centipawnLoss <= maxCpl));

      if (!candidates.some((candidate) => candidate.uci === best.pv[0])) {
        candidates.unshift({
          uci: best.pv[0], score: best.score, depth: best.depth, pv: [...best.pv], centipawnLoss: 0,
        });
      }
      const selected = weightedChoice(candidates, maxCpl, options.random ?? Math.random);
      return { uci: selected.uci, score: selected.score, depth: selected.depth, candidates };
    }, options.signal);
  }

  evaluate(
    input: LocalMoveEvaluationInput,
    options: LocalMoveEvaluationOptions = {},
  ): Promise<OpeningMoveEvaluation> {
    const move = validMove(input);
    const depth = integer(options.depth, 16, 1, 30, 'depth');
    const maxCpl = numberInRange(options.maxCpl, 80, 0, 5_000, 'maxCpl');

    return this.enqueue(async () => {
      const root = await this.search(move.fen, depth, 5, undefined, options.signal);
      const best = bestLine(root);
      // A constrained search from the same root preserves UCI's side-to-move
      // perspective. No white/black score inversion is needed.
      const played = move.uci === best.pv[0]
        ? best
        : bestLine(await this.search(move.fen, depth, 1, [move.uci], options.signal));
      const loss = scoreLoss(best.score, played.score);
      const forcedMateLost = losesMate(best.score, played.score);
      const passed = !forcedMateLost && loss <= maxCpl;
      const bestMoves: OpeningEvaluationMove[] = uniqueLines(root.lines).map((line) => ({
        uci: line.pv[0],
        san: sanFor(move.fen, line.pv[0]),
        score: line.score,
      }));

      return {
        status: 'graded',
        verdict: passed ? 'pass' : 'fail',
        passed,
        reason: forcedMateLost
          ? 'engine-forced-mate-lost'
          : passed ? 'engine-within-threshold' : 'engine-loss-too-large',
        move: { uci: move.uci, san: move.san },
        centipawnLoss: loss,
        thresholdCp: maxCpl,
        depth: Math.min(best.depth, played.depth),
        before: { depth: best.depth, score: best.score },
        // Existing response shape; this is the played move's same-root score.
        after: { depth: played.depth, score: played.score },
        bestMoves,
      };
    }, options.signal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new LocalEngineError('disposed', 'The local chess engine was disposed.');
    for (const entry of this.queue.splice(0)) {
      entry.queuedAbort && entry.signal?.removeEventListener('abort', entry.queuedAbort);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
    }
    if (this.current && !this.current.settled) {
      this.current.settled = true;
      this.current.reject(error);
    }
    this.restart(error);
  }

  private enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new LocalEngineError('disposed', 'The local chess engine was disposed.'));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        run,
        resolve: (value) => resolve(value as T),
        reject,
        signal,
        started: false,
        settled: false,
      };
      if (signal) {
        entry.queuedAbort = () => {
          if (entry.started || entry.settled) return;
          entry.settled = true;
          signal.removeEventListener('abort', entry.queuedAbort!);
          reject(cancelled());
        };
        signal.addEventListener('abort', entry.queuedAbort, { once: true });
      }
      this.queue.push(entry);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const entry = this.queue.shift()!;
        entry.queuedAbort && entry.signal?.removeEventListener('abort', entry.queuedAbort);
        if (entry.settled) continue;
        entry.started = true;
        if (this.disposed) {
          entry.settled = true;
          entry.reject(new LocalEngineError('disposed', 'The local chess engine was disposed.'));
          continue;
        }
        if (entry.signal?.aborted) {
          entry.settled = true;
          entry.reject(cancelled());
          continue;
        }
        this.current = entry;
        try {
          const value = await entry.run();
          if (!entry.settled) {
            entry.settled = true;
            entry.resolve(value);
          }
        } catch (error) {
          if (!entry.settled) {
            entry.settled = true;
            entry.reject(error);
          }
        } finally {
          if (this.current === entry) this.current = null;
        }
      }
    } finally {
      this.pumping = false;
      if (this.queue.length) void this.pump();
    }
  }

  private async search(
    fen: string,
    depth: number,
    multiPv: number,
    searchMoves: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    await this.ensureReady(signal);
    await this.setMultiPv(multiPv, signal);
    const records = new Map<number, InfoLine>();
    let bestMove = '';
    this.post(`position fen ${fen}`);
    const suffix = searchMoves?.length ? ` searchmoves ${searchMoves.join(' ')}` : '';
    await this.wait(
      `go depth ${depth}${suffix}`,
      (line) => {
        const info = parseInfo(line);
        if (info) {
          const old = records.get(info.multiPv);
          if (!old || info.depth > old.depth || (info.depth === old.depth && old.bound && !info.bound)) {
            records.set(info.multiPv, info);
          }
        }
        const match = /^bestmove\s+(\S+)/.exec(line);
        if (!match) return false;
        bestMove = match[1].toLowerCase();
        return true;
      },
      this.searchTimeoutMs,
      signal,
      'Stockfish search timed out.',
    );
    if (!bestMove || bestMove === '(none)' || bestMove === '0000') {
      throw new LocalEngineError('no-legal-move', 'The position has no legal move to analyse.');
    }
    const lines = [...records.values()]
      .filter((line) => line.pv.length)
      .sort((a, b) => a.multiPv - b.multiPv);
    if (!lines.length) {
      this.restart();
      throw new LocalEngineError('worker-error', 'Stockfish returned no evaluation score.');
    }
    return { bestMove, lines };
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.worker && this.ready) return;
    this.createWorker();
    await this.wait('uci', (line) => line === 'uciok', this.startupTimeoutMs, signal, 'Stockfish startup timed out.');
    this.post('setoption name Hash value 16');
    await this.wait('isready', (line) => line === 'readyok', this.startupTimeoutMs, signal, 'Stockfish startup timed out.');
    this.multiPv = 1;
    this.ready = true;
  }

  private async setMultiPv(value: number, signal?: AbortSignal): Promise<void> {
    if (value === this.multiPv) return;
    this.post(`setoption name MultiPV value ${value}`);
    await this.wait('isready', (line) => line === 'readyok', this.startupTimeoutMs, signal, 'Stockfish option change timed out.');
    this.multiPv = value;
  }

  private createWorker(): void {
    if (this.worker) return;
    if (this.disposed) throw new LocalEngineError('disposed', 'The local chess engine was disposed.');
    let worker: LocalEngineWorker;
    try {
      worker = this.workerFactory();
    } catch (cause) {
      if (cause instanceof LocalEngineError) throw cause;
      throw new LocalEngineError('worker-error', 'Stockfish Worker could not be created.', { cause });
    }
    const generation = ++this.generation;
    worker.onmessage = (event) => this.onMessage(generation, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (generation === this.generation) {
        this.restart(new LocalEngineError('worker-error', event.message || 'Stockfish Worker failed.'));
      }
    };
    this.worker = worker;
  }

  private onMessage(generation: number, data: unknown): void {
    if (generation !== this.generation || typeof data !== 'string') return;
    for (const raw of data.split(/\r?\n/)) {
      const line = raw.trim();
      const waiter = this.waiter;
      if (!line || !waiter || waiter.generation !== generation) continue;
      try {
        if (waiter.accept(line)) {
          this.finish(waiter);
          return;
        }
      } catch (error) {
        this.finish(waiter, error);
        return;
      }
    }
  }

  private wait(
    command: string,
    accept: (line: string) => boolean,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    timeoutMessage: string,
  ): Promise<void> {
    if (signal?.aborted) {
      const error = cancelled();
      this.restart(error);
      return Promise.reject(error);
    }
    if (!this.worker) return Promise.reject(new LocalEngineError('worker-error', 'Stockfish Worker is unavailable.'));
    if (this.waiter) return Promise.reject(new LocalEngineError('worker-error', 'Concurrent engine command detected.'));

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => this.restart(cancelled());
      const waiter: Waiter = {
        generation: this.generation,
        accept,
        resolve,
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      this.waiter = waiter;
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (this.waiter === waiter) this.restart(new LocalEngineError('timeout', timeoutMessage));
      }, timeoutMs);
      try {
        this.worker!.postMessage(command);
      } catch (cause) {
        this.restart(new LocalEngineError('worker-error', 'Stockfish rejected a command.', { cause }));
      }
    });
  }

  private finish(waiter: Waiter, error?: unknown): void {
    if (this.waiter !== waiter) return;
    this.waiter = null;
    waiter.cleanup();
    error === undefined ? waiter.resolve() : waiter.reject(error);
  }

  private post(command: string): void {
    try {
      this.worker?.postMessage(command);
    } catch (cause) {
      const error = new LocalEngineError('worker-error', 'Stockfish rejected a command.', { cause });
      this.restart(error);
      throw error;
    }
  }

  /** Invalidates the current generation; the next queued request creates a new Worker. */
  private restart(error?: unknown): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      waiter.cleanup();
      waiter.reject(error ?? new LocalEngineError('worker-error', 'Stockfish was restarted.'));
    }
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    this.multiPv = 1;
    ++this.generation;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }
}

let singleton: LocalStockfishEngine | null = null;

function shared(): LocalStockfishEngine {
  if (!singleton || singleton.isDisposed) singleton = new LocalStockfishEngine();
  return singleton;
}

export function suggestLocalMove(
  fen: string,
  options?: LocalMoveSuggestionOptions,
): Promise<LocalMoveSuggestion> {
  return shared().suggest(fen, options);
}

export function evaluateLocalMove(
  input: LocalMoveEvaluationInput,
  options?: LocalMoveEvaluationOptions,
): Promise<OpeningMoveEvaluation> {
  return shared().evaluate(input, options);
}

export function disposeLocalEngine(): void {
  singleton?.dispose();
  singleton = null;
}

function parseInfo(line: string): InfoLine | undefined {
  if (!line.startsWith('info ')) return undefined;
  const tokens = line.split(/\s+/);
  const di = tokens.indexOf('depth');
  const si = tokens.indexOf('score');
  const pi = tokens.indexOf('pv');
  const mi = tokens.indexOf('multipv');
  if (di < 0 || si < 0 || pi < 0) return undefined;
  const depth = Number(tokens[di + 1]);
  const multiPv = mi < 0 ? 1 : Number(tokens[mi + 1]);
  const type = tokens[si + 1];
  const value = Number(tokens[si + 2]);
  const pv = tokens.slice(pi + 1).map((move) => move.toLowerCase());
  if (!Number.isSafeInteger(depth) || depth < 1
    || !Number.isSafeInteger(multiPv) || multiPv < 1
    || !Number.isSafeInteger(value) || (type !== 'cp' && type !== 'mate')
    || !pv[0] || !uciShape(pv[0])) return undefined;
  return {
    depth,
    multiPv,
    score: { type, value },
    pv,
    bound: tokens.includes('lowerbound') || tokens.includes('upperbound'),
  };
}

function bestLine(result: SearchResult): InfoLine {
  const line = result.lines.find((candidate) => candidate.pv[0] === result.bestMove)
    ?? result.lines.find((candidate) => candidate.multiPv === 1)
    ?? result.lines[0];
  if (!line) throw new LocalEngineError('worker-error', 'Stockfish returned no principal variation.');
  return line;
}

function uniqueLines(lines: InfoLine[]): InfoLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line.pv[0])) return false;
    seen.add(line.pv[0]);
    return true;
  });
}

function numericScore(score: EvaluationScore): number {
  if (score.type === 'cp') return Math.max(-MAX_CP_SCORE, Math.min(MAX_CP_SCORE, score.value));
  const distance = Math.min(MATE_SCORE - 1, Math.abs(score.value));
  return Math.sign(score.value) * (MATE_SCORE - distance);
}

function scoreLoss(best: EvaluationScore, candidate: EvaluationScore): number {
  return Math.max(0, Math.round(numericScore(best) - numericScore(candidate)));
}

function losesMate(best: EvaluationScore, candidate: EvaluationScore): boolean {
  return best.type === 'mate' && best.value > 0
    && !(candidate.type === 'mate' && candidate.value > 0);
}

function weightedChoice(
  candidates: LocalEngineCandidate[],
  maxCpl: number,
  random: () => number,
): LocalEngineCandidate {
  if (!candidates.length) throw new LocalEngineError('worker-error', 'Stockfish returned no candidates.');
  if (candidates.length === 1) return candidates[0];
  const weights = candidates.map((candidate) => maxCpl === 0
    ? (candidate.centipawnLoss === 0 ? 1 : 0)
    : Math.exp(-candidate.centipawnLoss / Math.max(1, maxCpl)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new LocalEngineError('worker-error', 'random must return a number in [0, 1).');
  }
  let cursor = sample * total;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor -= weights[index];
    if (cursor < 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
}

function validPosition(fen: string, requireMove: boolean): Chess {
  if (typeof fen !== 'string' || !fen || fen.length > 128 || /[\r\n]/.test(fen)) {
    throw new LocalEngineError('invalid-position', 'fen must be a valid standard chess FEN.');
  }
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch (cause) {
    throw new LocalEngineError('invalid-position', 'fen must be a valid standard chess FEN.', { cause });
  }
  if (requireMove && game.isGameOver()) {
    throw new LocalEngineError('no-legal-move', 'The position has no legal move to analyse.');
  }
  return game;
}

function validMove(input: LocalMoveEvaluationInput): { fen: string; uci: string; san: string } {
  if (!input || typeof input !== 'object') {
    throw new LocalEngineError('invalid-move', 'A FEN and legal UCI move are required.');
  }
  const game = validPosition(input.fen, true);
  const fen = game.fen();
  const uci = typeof input.uci === 'string' ? input.uci.trim().toLowerCase() : '';
  if (!uciShape(uci)) throw new LocalEngineError('invalid-move', 'uci must be a legal coordinate move.');
  try {
    const move = game.move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] } : {}),
    });
    if (!move) throw new Error('illegal move');
    return {
      fen,
      uci,
      san: typeof input.san === 'string' && input.san.trim() ? input.san.trim() : move.san,
    };
  } catch (cause) {
    throw new LocalEngineError('invalid-move', 'uci must be legal in the supplied position.', { cause });
  }
}

function sanFor(fen: string, uci: string): string | undefined {
  try {
    return new Chess(fen).move({
      from: uci.slice(0, 2) as Square,
      to: uci.slice(2, 4) as Square,
      ...(uci[4] ? { promotion: uci[4] } : {}),
    })?.san;
  } catch {
    return undefined;
  }
}

function uciShape(value: string): boolean {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);
}

function integer(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new LocalEngineError('worker-error', `${name} must be an integer from ${min} to ${max}.`);
  }
  return result;
}

function numberInRange(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new LocalEngineError('worker-error', `${name} must be from ${min} to ${max}.`);
  }
  return result;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new LocalEngineError('worker-error', `${name} must be positive.`);
  }
  return result;
}

function cancelled(): DOMException {
  return new DOMException('The local engine request was cancelled.', 'AbortError');
}

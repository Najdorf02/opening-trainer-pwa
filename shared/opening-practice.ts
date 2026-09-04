/**
 * Domain policy for free-form opening practice.
 *
 * This module deliberately knows nothing about Lichess URLs or response shapes.
 * A server adapter supplies normalized explorer statistics and, when available,
 * a normalized engine assessment. That keeps this mode independent from the
 * fixed-line repertoire trainer.
 */

export type PracticeSide = "white" | "black";

/** How a practice session obtains the opponent's moves. */
export type OpeningPracticeSourceMode = "auto" | "engine";

/** Result of the Explorer attempt for the current position. */
export type ExplorerLookupOutcome = "move" | "empty" | "failure" | "skipped";

export type OpponentMoveSource = "database" | "engine" | "complete";

export type OpponentMoveSourceReason =
  | "game-over"
  | "engine-only"
  | "database-move"
  | "database-empty"
  | "database-failed"
  | "database-circuit-open";

export interface OpponentMoveSourceRequest {
  mode: OpeningPracticeSourceMode;
  explorerOutcome: ExplorerLookupOutcome;
  /** True after an Explorer request has failed earlier in this session. */
  explorerCircuitOpen?: boolean;
  /** Checkmate, stalemate, insufficient material, or another terminal state. */
  gameOver?: boolean;
}

export interface OpponentMoveSourceDecision {
  source: OpponentMoveSource;
  reason: OpponentMoveSourceReason;
  /** Persist this for the rest of the session to avoid repeated failing calls. */
  openExplorerCircuit: boolean;
}

/**
 * Chooses between a historical move and an engine move after an Explorer
 * attempt. A transport/upstream failure opens a session circuit breaker;
 * an ordinary empty book position falls back only for the current position.
 */
export function decideOpponentMoveSource(
  request: OpponentMoveSourceRequest,
): OpponentMoveSourceDecision {
  const explorerCircuitOpen = Boolean(request.explorerCircuitOpen);

  if (request.gameOver) {
    return {
      source: "complete",
      reason: "game-over",
      openExplorerCircuit: explorerCircuitOpen,
    };
  }

  if (request.mode === "engine") {
    return {
      source: "engine",
      reason: "engine-only",
      openExplorerCircuit: explorerCircuitOpen,
    };
  }

  if (explorerCircuitOpen) {
    return {
      source: "engine",
      reason: "database-circuit-open",
      openExplorerCircuit: true,
    };
  }

  if (request.explorerOutcome === "move") {
    return {
      source: "database",
      reason: "database-move",
      openExplorerCircuit: false,
    };
  }

  if (request.explorerOutcome === "failure") {
    return {
      source: "engine",
      reason: "database-failed",
      openExplorerCircuit: true,
    };
  }

  return {
    source: "engine",
    reason: request.explorerOutcome === "empty" ? "database-empty" : "database-circuit-open",
    openExplorerCircuit: false,
  };
}

export interface OpeningGameResults {
  whiteWins: number;
  draws: number;
  blackWins: number;
}

export interface OpeningExplorerMove {
  uci: string;
  san: string;
  results: OpeningGameResults;
  averageRating?: number;
}

export interface OpeningExplorerPosition {
  fen: string;
  results: OpeningGameResults;
  moves: readonly OpeningExplorerMove[];
}

/** Adapter boundary for a historical opening database such as Lichess Explorer. */
export interface OpeningExplorerPort {
  lookup(request: { fen: string }): Promise<OpeningExplorerPosition>;
}

/**
 * The evaluator adapter must normalize this as loss against its best move from
 * the perspective of the player who moved. Zero is best; larger is worse.
 */
export interface MoveEvaluationEvidence {
  depth: number;
  centipawnLoss?: number;
  forcedMateLost?: boolean;
}

/** Adapter boundary for cloud or local engine analysis. */
export interface MoveSoundnessPort {
  evaluate(request: {
    fenBefore: string;
    playedUci: string;
  }): Promise<MoveEvaluationEvidence | undefined>;
}

export interface OpponentMovePolicy {
  /** Ignore moves with fewer historical games than this. */
  minimumGames: number;
  /** Ignore moves below this share of games in the position. */
  minimumPlayRate: number;
  /** Limit the random pool after sorting by historical game count. */
  maximumCandidates: number;
  /** 1 follows frequency exactly; values below 1 add realistic variety. */
  frequencyExponent: number;
}

export const DEFAULT_OPPONENT_MOVE_POLICY: Readonly<OpponentMovePolicy> =
  Object.freeze({
    minimumGames: 10,
    minimumPlayRate: 0.01,
    maximumCandidates: 12,
    frequencyExponent: 0.85,
  });

export interface WeightedOpponentMove {
  move: OpeningExplorerMove;
  games: number;
  playRate: number;
  probability: number;
}

export interface OpponentMoveChoice extends WeightedOpponentMove {
  eligibleMoveCount: number;
}

export function gameCount(results: OpeningGameResults): number {
  validateResults(results);
  return results.whiteWins + results.draws + results.blackWins;
}

/** Score from the perspective of the side that made the move. */
export function scoreRate(
  results: OpeningGameResults,
  mover: PracticeSide,
): number | undefined {
  const games = gameCount(results);
  if (games === 0) return undefined;
  const wins = mover === "white" ? results.whiteWins : results.blackWins;
  return (wins + results.draws / 2) / games;
}

export function buildOpponentMovePool(
  position: OpeningExplorerPosition,
  policyOverrides: Partial<OpponentMovePolicy> = {},
): WeightedOpponentMove[] {
  const policy = resolveOpponentPolicy(policyOverrides);
  const positionGames = gameCount(position.results);
  if (positionGames === 0) return [];

  const eligible = position.moves
    .map((move, order) => {
      const games = gameCount(move.results);
      return {
        move,
        games,
        playRate: Math.min(1, games / positionGames),
        order,
      };
    })
    .filter(
      (candidate) =>
        candidate.games >= policy.minimumGames &&
        candidate.playRate >= policy.minimumPlayRate,
    )
    .sort((left, right) => right.games - left.games || left.order - right.order)
    .slice(0, policy.maximumCandidates);

  const weighted = eligible.map((candidate) => ({
    ...candidate,
    weight: candidate.games ** policy.frequencyExponent,
  }));
  const totalWeight = weighted.reduce(
    (total, candidate) => total + candidate.weight,
    0,
  );

  return weighted.map(({ move, games, playRate, weight }) => ({
    move,
    games,
    playRate,
    probability: weight / totalWeight,
  }));
}

/**
 * Selects a database move with a supplied RNG so sessions and tests can be
 * reproducible. The RNG must return a value in [0, 1).
 */
export function selectOpponentMove(
  position: OpeningExplorerPosition,
  policyOverrides: Partial<OpponentMovePolicy> = {},
  random: () => number = Math.random,
): OpponentMoveChoice | undefined {
  const pool = buildOpponentMovePool(position, policyOverrides);
  if (pool.length === 0) return undefined;

  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new Error("Opponent move RNG must return a number in [0, 1).");
  }

  let cumulative = 0;
  const selected =
    pool.find((candidate) => {
      cumulative += candidate.probability;
      return roll < cumulative;
    }) ?? pool[pool.length - 1];

  return { ...selected, eligibleMoveCount: pool.length };
}

export interface SoundnessPolicy {
  /** Maximum engine loss still treated as a usable opening move. */
  maximumCentipawnLoss: number;
  /** Ignore shallow engine evidence and fall back to database support. */
  minimumEngineDepth: number;
  /** Minimum historical sample for conservative database-only acceptance. */
  minimumDatabaseGames: number;
  /** Minimum historical play share for database-only acceptance. */
  minimumDatabasePlayRate: number;
  /** Maximum score-rate gap from the best sufficiently sampled response. */
  maximumDatabaseScoreRateLoss: number;
}

export const DEFAULT_SOUNDNESS_POLICY: Readonly<SoundnessPolicy> = Object.freeze({
  maximumCentipawnLoss: 80,
  minimumEngineDepth: 16,
  minimumDatabaseGames: 100,
  minimumDatabasePlayRate: 0.005,
  maximumDatabaseScoreRateLoss: 0.06,
});

export type SoundnessVerdict = "pass" | "fail" | "inconclusive";

export type SoundnessReason =
  | "illegal-move"
  | "engine-within-threshold"
  | "engine-loss-too-large"
  | "engine-forced-mate-lost"
  | "database-supported"
  | "move-not-in-database"
  | "database-sample-too-small"
  | "database-performance-gap";

export interface SoundnessAssessment {
  verdict: SoundnessVerdict;
  reason: SoundnessReason;
  basis: "legality" | "engine" | "database" | "none";
  playedUci: string;
  centipawnLoss?: number;
  engineDepth?: number;
  databaseGames?: number;
  databasePlayRate?: number;
  databaseScoreRate?: number;
  referenceScoreRate?: number;
}

export interface SoundnessRequest {
  legal: boolean;
  mover: PracticeSide;
  playedUci: string;
  position: OpeningExplorerPosition;
  engine?: MoveEvaluationEvidence;
}

/**
 * Judges a free-form response without comparing it to a memorized line.
 *
 * Reliable engine evidence is authoritative. Database results are deliberately
 * only a positive fallback: a well-supported competitive move can pass, but a
 * rare move is inconclusive rather than automatically wrong.
 */
export function assessMoveSoundness(
  request: SoundnessRequest,
  policyOverrides: Partial<SoundnessPolicy> = {},
): SoundnessAssessment {
  const policy = resolveSoundnessPolicy(policyOverrides);
  const playedUci = normalizeUci(request.playedUci);

  if (!request.legal) {
    return {
      verdict: "fail",
      reason: "illegal-move",
      basis: "legality",
      playedUci,
    };
  }

  const engine = request.engine;
  if (engine) validateEngineEvidence(engine);
  if (engine && engine.depth >= policy.minimumEngineDepth) {
    if (engine.forcedMateLost) {
      return {
        verdict: "fail",
        reason: "engine-forced-mate-lost",
        basis: "engine",
        playedUci,
        engineDepth: engine.depth,
      };
    }
    if (engine.centipawnLoss !== undefined) {
      return {
        verdict:
          engine.centipawnLoss <= policy.maximumCentipawnLoss ? "pass" : "fail",
        reason:
          engine.centipawnLoss <= policy.maximumCentipawnLoss
            ? "engine-within-threshold"
            : "engine-loss-too-large",
        basis: "engine",
        playedUci,
        centipawnLoss: engine.centipawnLoss,
        engineDepth: engine.depth,
      };
    }
  }

  const positionGames = gameCount(request.position.results);
  const matchingMove = request.position.moves.find(
    (move) => normalizeUci(move.uci) === playedUci,
  );
  if (!matchingMove) {
    return {
      verdict: "inconclusive",
      reason: "move-not-in-database",
      basis: "none",
      playedUci,
      engineDepth: engine?.depth,
    };
  }

  const databaseGames = gameCount(matchingMove.results);
  const databasePlayRate =
    positionGames === 0 ? 0 : Math.min(1, databaseGames / positionGames);
  const databaseScoreRate = scoreRate(matchingMove.results, request.mover);
  const commonDetails = {
    playedUci,
    engineDepth: engine?.depth,
    databaseGames,
    databasePlayRate,
    databaseScoreRate,
  };
  if (
    databaseGames < policy.minimumDatabaseGames ||
    databasePlayRate < policy.minimumDatabasePlayRate ||
    databaseScoreRate === undefined
  ) {
    return {
      verdict: "inconclusive",
      reason: "database-sample-too-small",
      basis: "database",
      ...commonDetails,
    };
  }

  const referenceScoreRate = request.position.moves
    .filter((move) => {
      const games = gameCount(move.results);
      const playRate = positionGames === 0 ? 0 : games / positionGames;
      return (
        games >= policy.minimumDatabaseGames &&
        playRate >= policy.minimumDatabasePlayRate
      );
    })
    .map((move) => scoreRate(move.results, request.mover))
    .filter((rate): rate is number => rate !== undefined)
    .reduce((best, rate) => Math.max(best, rate), databaseScoreRate);

  if (
    referenceScoreRate - databaseScoreRate <=
    policy.maximumDatabaseScoreRateLoss
  ) {
    return {
      verdict: "pass",
      reason: "database-supported",
      basis: "database",
      ...commonDetails,
      referenceScoreRate,
    };
  }

  return {
    verdict: "inconclusive",
    reason: "database-performance-gap",
    basis: "database",
    ...commonDetails,
    referenceScoreRate,
  };
}

function resolveOpponentPolicy(
  overrides: Partial<OpponentMovePolicy>,
): OpponentMovePolicy {
  const policy = { ...DEFAULT_OPPONENT_MOVE_POLICY, ...overrides };
  if (!Number.isInteger(policy.minimumGames) || policy.minimumGames < 1) {
    throw new Error("minimumGames must be a positive integer.");
  }
  if (
    !Number.isFinite(policy.minimumPlayRate) ||
    policy.minimumPlayRate < 0 ||
    policy.minimumPlayRate > 1
  ) {
    throw new Error("minimumPlayRate must be between 0 and 1.");
  }
  if (
    !Number.isInteger(policy.maximumCandidates) ||
    policy.maximumCandidates < 1
  ) {
    throw new Error("maximumCandidates must be a positive integer.");
  }
  if (
    !Number.isFinite(policy.frequencyExponent) ||
    policy.frequencyExponent <= 0
  ) {
    throw new Error("frequencyExponent must be greater than zero.");
  }
  return policy;
}

function resolveSoundnessPolicy(
  overrides: Partial<SoundnessPolicy>,
): SoundnessPolicy {
  const policy = { ...DEFAULT_SOUNDNESS_POLICY, ...overrides };
  if (
    !Number.isFinite(policy.maximumCentipawnLoss) ||
    policy.maximumCentipawnLoss < 0
  ) {
    throw new Error("maximumCentipawnLoss must be non-negative.");
  }
  if (!Number.isInteger(policy.minimumEngineDepth) || policy.minimumEngineDepth < 1) {
    throw new Error("minimumEngineDepth must be a positive integer.");
  }
  if (
    !Number.isInteger(policy.minimumDatabaseGames) ||
    policy.minimumDatabaseGames < 1
  ) {
    throw new Error("minimumDatabaseGames must be a positive integer.");
  }
  if (
    !Number.isFinite(policy.minimumDatabasePlayRate) ||
    policy.minimumDatabasePlayRate < 0 ||
    policy.minimumDatabasePlayRate > 1
  ) {
    throw new Error("minimumDatabasePlayRate must be between 0 and 1.");
  }
  if (
    !Number.isFinite(policy.maximumDatabaseScoreRateLoss) ||
    policy.maximumDatabaseScoreRateLoss < 0 ||
    policy.maximumDatabaseScoreRateLoss > 1
  ) {
    throw new Error("maximumDatabaseScoreRateLoss must be between 0 and 1.");
  }
  return policy;
}

function normalizeUci(uci: string): string {
  return uci.trim().toLowerCase();
}

function validateResults(results: OpeningGameResults): void {
  for (const value of [results.whiteWins, results.draws, results.blackWins]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Opening game results must be non-negative safe integers.");
    }
  }
}

function validateEngineEvidence(evidence: MoveEvaluationEvidence): void {
  if (!Number.isInteger(evidence.depth) || evidence.depth < 1) {
    throw new Error("Engine depth must be a positive integer.");
  }
  if (
    evidence.centipawnLoss !== undefined &&
    (!Number.isFinite(evidence.centipawnLoss) || evidence.centipawnLoss < 0)
  ) {
    throw new Error("Engine centipawn loss must be non-negative.");
  }
}

import { Chess } from "chess.js";

import type { GameRepertoireReview, ReviewedGameMove } from "./game-review.js";
import { canonicalPositionKey } from "./repertoire.js";

export type MistakeSeverity = "best" | "good" | "inaccuracy" | "mistake" | "blunder";
export type MistakeTheme = "tactical" | "strategic" | "general";
export type MistakeThemeBasis =
  | "forced-mate"
  | "mate-line"
  | "forcing-best-move"
  | "forcing-pv"
  | "quiet-best-move"
  | "insufficient-evidence";

export type MistakeReasonKey =
  | "engine-best"
  | "sound-alternative"
  | "minor-inaccuracy"
  | "missed-tactical-chance"
  | "strategic-concession"
  | "general-mistake"
  | "forced-mate-lost";

export type UncoveredResponseKind = "strong" | "solid" | "missed-chance";

export interface EngineReviewScore {
  type: "cp" | "mate";
  value: number;
}

/**
 * Structural subset of an OpeningEvaluationMove. `pv` is optional so adapters
 * that retain an engine principal variation can provide stronger tactical
 * evidence without making it a requirement for current evaluators.
 */
export interface EngineReviewCandidate {
  uci: string;
  san?: string;
  score: EngineReviewScore;
  pv?: readonly string[];
}

/**
 * Structural subset of the graded branch of OpeningMoveEvaluation. Keeping the
 * type here makes the shared review core independent from browser/UI modules.
 */
export interface GradedMoveEvaluation {
  status: "graded";
  verdict: "pass" | "fail";
  passed: boolean;
  reason: "engine-within-threshold" | "engine-loss-too-large" | "engine-forced-mate-lost";
  move: {
    uci: string;
    san: string;
  };
  centipawnLoss: number;
  thresholdCp: number;
  depth: number;
  before: {
    depth: number;
    score: EngineReviewScore;
  };
  after: {
    depth: number;
    score: EngineReviewScore;
  };
  bestMoves: readonly EngineReviewCandidate[];
}

export interface EvaluatedReviewedMove {
  move: ReviewedGameMove;
  evaluation: GradedMoveEvaluation;
}

export interface MistakeReviewThresholds {
  bestMaxCp: number;
  goodMaxCp: number;
  inaccuracyMaxCp: number;
  mistakeMaxCp: number;
}

export const DEFAULT_MISTAKE_REVIEW_THRESHOLDS: Readonly<MistakeReviewThresholds> = Object.freeze({
  bestMaxCp: 15,
  goodMaxCp: 50,
  inaccuracyMaxCp: 100,
  mistakeMaxCp: 200,
});

export const MISTAKE_SEVERITY_LABELS: Readonly<Record<MistakeSeverity, string>> = Object.freeze({
  best: "최선",
  good: "좋은 수",
  inaccuracy: "부정확",
  mistake: "실수",
  blunder: "큰 실수",
});

export const MISTAKE_THEME_LABELS: Readonly<Record<MistakeTheme, string>> = Object.freeze({
  tactical: "전술",
  // `strategic` is retained as the stable data key, but a quiet engine move
  // alone is only enough to nominate a position for strategic review.
  strategic: "전략 후보",
  general: "일반",
});

export const UNCOVERED_RESPONSE_LABELS: Readonly<Record<UncoveredResponseKind, string>> = Object.freeze({
  strong: "강한 대응",
  solid: "안정적인 대응",
  "missed-chance": "더 좋은 기회를 놓침",
});

export interface MistakeReasonCopy {
  title: string;
  detail: string;
}

/** Korean UI copy keyed by deterministic, storage-safe reason identifiers. */
export const MISTAKE_REASON_COPY: Readonly<Record<MistakeReasonKey, MistakeReasonCopy>> = Object.freeze({
  "engine-best": {
    title: "엔진의 최선에 가까운 수",
    detail: "평가 손실이 거의 없습니다.",
  },
  "sound-alternative": {
    title: "충분히 좋은 선택",
    detail: "최선 수와 약간 다르지만 포지션을 크게 해치지 않았습니다.",
  },
  "minor-inaccuracy": {
    title: "조금 더 정확한 수가 있었습니다",
    detail: "작은 평가 손실이 있어 추천 수와 비교해 볼 가치가 있습니다.",
  },
  "missed-tactical-chance": {
    title: "전술 기회를 놓쳤을 가능성",
    detail: "추천 수나 엔진 진행에서 체크, 잡기, 승격 같은 강제 수가 확인됩니다.",
  },
  "strategic-concession": {
    title: "전략적으로 검토할 후보",
    detail: "더 좋은 조용한 수가 있었지만, 엔진 수치만으로 실수의 원인을 전략이라고 단정하지 않습니다.",
  },
  "general-mistake": {
    title: "더 좋은 수를 놓쳤습니다",
    detail: "근거가 충분하지 않아 전술 또는 전략 실수로 단정하지 않습니다.",
  },
  "forced-mate-lost": {
    title: "강제 메이트 기회를 놓쳤습니다",
    detail: "엔진 판정상 가능했던 강제 메이트가 사라졌습니다.",
  },
});

export interface ClassifiedReviewedMove {
  move: ReviewedGameMove;
  evaluation: GradedMoveEvaluation;
  severity: MistakeSeverity;
  severityLabel: string;
  theme: MistakeTheme;
  themeLabel: string;
  themeBasis: MistakeThemeBasis;
  reasonKey: MistakeReasonKey;
  reason: MistakeReasonCopy;
  meaningfulError: boolean;
}

export interface UncoveredResponseAssessment {
  kind: UncoveredResponseKind;
  label: string;
  opponentMove: ReviewedGameMove;
  responseMove: ReviewedGameMove;
  review: ClassifiedReviewedMove;
}

export interface LearnFromMistakeMove {
  uci: string;
  san?: string;
  score: EngineReviewScore;
}

export interface LearnFromMistakeDrillItem {
  source: "engine-review";
  id: string;
  gameId: string;
  gameUrl?: string;
  playedAt?: string;
  ply: number;
  moveNumber: number;
  mover: "white" | "black";
  fen: string;
  positionKey: string;
  playedMove: {
    uci: string;
    san: string;
  };
  recommendedMoves: readonly LearnFromMistakeMove[];
  severity: Exclude<MistakeSeverity, "best" | "good">;
  severityLabel: string;
  theme: MistakeTheme;
  themeLabel: string;
  reasonKey: MistakeReasonKey;
  reason: MistakeReasonCopy;
}

interface ForcingTraits {
  capture: boolean;
  check: boolean;
  promotion: boolean;
}

function normalizedUci(uci: string): string {
  return uci.trim().toLowerCase();
}

function isUciShape(uci: string): boolean {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalizedUci(uci));
}

function applyUci(chess: Chess, uci: string): ReturnType<Chess["move"]> | undefined {
  const normalized = normalizedUci(uci);
  if (!isUciShape(normalized)) {
    return undefined;
  }

  try {
    return (
      chess.move({
        from: normalized.slice(0, 2),
        to: normalized.slice(2, 4),
        promotion: normalized.slice(4, 5) || undefined,
      }) ?? undefined
    );
  } catch {
    return undefined;
  }
}

function sanForcingTraits(san?: string): ForcingTraits {
  const value = san?.trim() ?? "";
  return {
    capture: value.includes("x"),
    check: /[+#]$/.test(value),
    promotion: value.includes("="),
  };
}

function boardForcingTraits(fen: string, uci: string): ForcingTraits | undefined {
  try {
    const chess = new Chess(fen);
    const played = applyUci(chess, uci);
    if (!played) {
      return undefined;
    }

    return {
      capture: played.isCapture(),
      check: chess.inCheck(),
      promotion: played.isPromotion(),
    };
  } catch {
    return undefined;
  }
}

function mergeTraits(...traits: Array<ForcingTraits | undefined>): ForcingTraits {
  return {
    capture: traits.some((item) => item?.capture),
    check: traits.some((item) => item?.check),
    promotion: traits.some((item) => item?.promotion),
  };
}

function hasForcingTrait(traits: ForcingTraits): boolean {
  return traits.capture || traits.check || traits.promotion;
}

function pvHasForcingSequence(fen: string, pv: readonly string[]): boolean {
  if (pv.length === 0) {
    return false;
  }

  try {
    const chess = new Chess(fen);
    let forcingPlies = 0;
    const inspected = pv.slice(0, 4);

    for (let index = 0; index < inspected.length; index += 1) {
      const played = applyUci(chess, inspected[index]);
      if (!played) {
        return false;
      }

      const forcing = played.isCapture() || played.isPromotion() || chess.inCheck();
      if (index === 0 && forcing) {
        return true;
      }
      if (forcing) {
        forcingPlies += 1;
      }
    }

    // A single later capture is common in ordinary positional lines. Requiring
    // two forcing plies keeps the tactical label deliberately conservative.
    return forcingPlies >= 2;
  } catch {
    return false;
  }
}

function resolveTheme(
  move: ReviewedGameMove,
  evaluation: GradedMoveEvaluation,
  severity: MistakeSeverity,
): { theme: MistakeTheme; basis: MistakeThemeBasis } {
  if (evaluation.reason === "engine-forced-mate-lost") {
    return { theme: "tactical", basis: "forced-mate" };
  }

  if (
    evaluation.before.score.type === "mate" ||
    evaluation.after.score.type === "mate" ||
    evaluation.bestMoves.some((candidate) => candidate.score.type === "mate")
  ) {
    return { theme: "tactical", basis: "mate-line" };
  }

  const best = evaluation.bestMoves[0];
  if (best) {
    const forcing = mergeTraits(sanForcingTraits(best.san), boardForcingTraits(move.beforeFen, best.uci));
    if (hasForcingTrait(forcing)) {
      return { theme: "tactical", basis: "forcing-best-move" };
    }

    if (best.pv && pvHasForcingSequence(move.beforeFen, best.pv)) {
      return { theme: "tactical", basis: "forcing-pv" };
    }

    if (isMeaningfulSeverity(severity)) {
      return { theme: "strategic", basis: "quiet-best-move" };
    }
  }

  return { theme: "general", basis: "insufficient-evidence" };
}

function validateThresholds(thresholds: MistakeReviewThresholds): void {
  const values = [
    thresholds.bestMaxCp,
    thresholds.goodMaxCp,
    thresholds.inaccuracyMaxCp,
    thresholds.mistakeMaxCp,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Mistake review thresholds must be finite, non-negative numbers.");
  }
  if (
    thresholds.bestMaxCp > thresholds.goodMaxCp ||
    thresholds.goodMaxCp > thresholds.inaccuracyMaxCp ||
    thresholds.inaccuracyMaxCp > thresholds.mistakeMaxCp
  ) {
    throw new Error("Mistake review thresholds must be in ascending order.");
  }
}

export function severityFromEvaluation(
  evaluation: GradedMoveEvaluation,
  thresholds: MistakeReviewThresholds = DEFAULT_MISTAKE_REVIEW_THRESHOLDS,
): MistakeSeverity {
  validateThresholds(thresholds);
  if (evaluation.reason === "engine-forced-mate-lost") {
    return "blunder";
  }

  const loss = evaluation.centipawnLoss;
  if (!Number.isFinite(loss) || loss < 0) {
    throw new Error("centipawnLoss must be a finite, non-negative number.");
  }
  if (loss <= thresholds.bestMaxCp) return "best";
  if (loss <= thresholds.goodMaxCp) return "good";
  if (loss <= thresholds.inaccuracyMaxCp) return "inaccuracy";
  if (loss <= thresholds.mistakeMaxCp) return "mistake";
  return "blunder";
}

export function isMeaningfulSeverity(
  severity: MistakeSeverity,
): severity is Exclude<MistakeSeverity, "best" | "good"> {
  return severity === "inaccuracy" || severity === "mistake" || severity === "blunder";
}

function reasonKeyFor(
  evaluation: GradedMoveEvaluation,
  severity: MistakeSeverity,
  theme: MistakeTheme,
): MistakeReasonKey {
  if (evaluation.reason === "engine-forced-mate-lost") return "forced-mate-lost";
  if (severity === "best") return "engine-best";
  if (severity === "good") return "sound-alternative";
  if (theme === "tactical") return "missed-tactical-chance";
  if (theme === "strategic") return "strategic-concession";
  if (severity === "inaccuracy") return "minor-inaccuracy";
  return "general-mistake";
}

export function classifyReviewedMove(
  move: ReviewedGameMove,
  evaluation: GradedMoveEvaluation,
  thresholds: MistakeReviewThresholds = DEFAULT_MISTAKE_REVIEW_THRESHOLDS,
): ClassifiedReviewedMove {
  if (normalizedUci(move.uci) !== normalizedUci(evaluation.move.uci)) {
    throw new Error(`Evaluation move ${evaluation.move.uci} does not match reviewed move ${move.uci}.`);
  }

  const severity = severityFromEvaluation(evaluation, thresholds);
  const resolvedTheme = resolveTheme(move, evaluation, severity);
  const reasonKey = reasonKeyFor(evaluation, severity, resolvedTheme.theme);

  return {
    move,
    evaluation,
    severity,
    severityLabel: MISTAKE_SEVERITY_LABELS[severity],
    theme: resolvedTheme.theme,
    themeLabel: MISTAKE_THEME_LABELS[resolvedTheme.theme],
    themeBasis: resolvedTheme.basis,
    reasonKey,
    reason: MISTAKE_REASON_COPY[reasonKey],
    meaningfulError: isMeaningfulSeverity(severity),
  };
}

export function classifyReviewedMoves(
  evaluatedMoves: readonly EvaluatedReviewedMove[],
  thresholds: MistakeReviewThresholds = DEFAULT_MISTAKE_REVIEW_THRESHOLDS,
): ClassifiedReviewedMove[] {
  return evaluatedMoves.map(({ move, evaluation }) => classifyReviewedMove(move, evaluation, thresholds));
}

/**
 * Selects every move made by the user in the game. Repertoire coverage still
 * powers the dedicated theory-deviation summary, while engine review examines
 * the complete game so tactical and positional mistakes inside known theory
 * are not silently skipped.
 */
export function selectUserMovesForEngineReview(review: GameRepertoireReview): ReviewedGameMove[] {
  return review.moves.filter((move) => move.isUserMove);
}

function evaluatedMoveAtPly(
  evaluatedMoves: readonly EvaluatedReviewedMove[],
  move: ReviewedGameMove,
): EvaluatedReviewedMove | undefined {
  return evaluatedMoves.find(
    (entry) => entry.move.ply === move.ply && normalizedUci(entry.move.uci) === normalizedUci(move.uci),
  );
}

/** Grades the user's move immediately following the first uncovered opponent move. */
export function assessResponseAfterOpponentUncovered(
  review: GameRepertoireReview,
  evaluatedMoves: readonly EvaluatedReviewedMove[],
  thresholds: MistakeReviewThresholds = DEFAULT_MISTAKE_REVIEW_THRESHOLDS,
): UncoveredResponseAssessment | undefined {
  const uncovered = review.firstOpponentUncovered;
  if (!uncovered) {
    return undefined;
  }

  const opponentMove = review.moves.find(
    (move) => move.ply === uncovered.ply && !move.isUserMove,
  );
  const responseMove = review.moves.find(
    (move) => move.ply === uncovered.ply + 1 && move.isUserMove,
  );
  if (!opponentMove || !responseMove) {
    return undefined;
  }

  const evaluated = evaluatedMoveAtPly(evaluatedMoves, responseMove);
  if (!evaluated) {
    return undefined;
  }

  const classified = classifyReviewedMove(responseMove, evaluated.evaluation, thresholds);
  const kind: UncoveredResponseKind =
    classified.severity === "best"
      ? "strong"
      : classified.severity === "good"
        ? "solid"
        : "missed-chance";

  return {
    kind,
    label: UNCOVERED_RESPONSE_LABELS[kind],
    opponentMove,
    responseMove,
    review: classified,
  };
}

function legalRecommendedMoves(
  move: ReviewedGameMove,
  candidates: readonly EngineReviewCandidate[],
): LearnFromMistakeMove[] {
  const playedUci = normalizedUci(move.uci);
  const seen = new Set<string>();
  const result: LearnFromMistakeMove[] = [];

  for (const candidate of candidates) {
    const uci = normalizedUci(candidate.uci);
    if (!uci || uci === playedUci || seen.has(uci)) {
      continue;
    }

    try {
      const chess = new Chess(move.beforeFen);
      const played = applyUci(chess, uci);
      if (!played) {
        continue;
      }
    } catch {
      continue;
    }

    seen.add(uci);
    result.push({
      uci,
      san: candidate.san,
      score: candidate.score,
    });
  }

  return result;
}

/**
 * Converts engine-confirmed inaccuracies or worse from the entire game into
 * immediately replayable positions. Items without a distinct, legal
 * recommended move are deliberately omitted.
 */
export function createLearnFromMistakesDrillItems(
  review: GameRepertoireReview,
  evaluatedMoves: readonly EvaluatedReviewedMove[],
  thresholds: MistakeReviewThresholds = DEFAULT_MISTAKE_REVIEW_THRESHOLDS,
): LearnFromMistakeDrillItem[] {
  const eligiblePlies = new Set(selectUserMovesForEngineReview(review).map((move) => move.ply));
  const items: LearnFromMistakeDrillItem[] = [];

  for (const evaluated of evaluatedMoves) {
    const { move } = evaluated;
    if (!move.isUserMove || !eligiblePlies.has(move.ply)) {
      continue;
    }

    const classified = classifyReviewedMove(move, evaluated.evaluation, thresholds);
    if (!classified.meaningfulError || !isMeaningfulSeverity(classified.severity)) {
      continue;
    }

    const recommendedMoves = legalRecommendedMoves(move, evaluated.evaluation.bestMoves);
    if (recommendedMoves.length === 0) {
      continue;
    }

    items.push({
      source: "engine-review",
      id: `engine-review:${review.meta.id}:${move.ply}`,
      gameId: review.meta.id,
      gameUrl: review.meta.url,
      playedAt: review.meta.playedAt,
      ply: move.ply,
      moveNumber: move.moveNumber,
      mover: move.mover,
      fen: move.beforeFen,
      positionKey: canonicalPositionKey(move.beforeFen),
      playedMove: {
        uci: normalizedUci(move.uci),
        san: move.san,
      },
      recommendedMoves,
      severity: classified.severity,
      severityLabel: classified.severityLabel,
      theme: classified.theme,
      themeLabel: classified.themeLabel,
      reasonKey: classified.reasonKey,
      reason: classified.reason,
    });
  }

  return items.sort((left, right) => left.ply - right.ply);
}

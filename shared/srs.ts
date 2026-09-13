import type {
  RepertoireChapter,
  RepertoireStudy,
} from "./repertoire.js";
import type { SessionCardGrade, SessionSrsGrade } from "./trainer.js";

export const SRS_PROGRESS_VERSION = 1 as const;
export const SRS_DAY_MS = 24 * 60 * 60 * 1_000;
export const SRS_AGAIN_DELAY_MS = 10 * 60 * 1_000;
export const SRS_MASTERY_THRESHOLD = 80;

/**
 * Conservative intervals for the two grades emitted by ChapterTrainer.
 * A lapse restarts the interval ladder, while the separate mastery score keeps
 * some credit for a card that had previously been learned.
 */
export const SRS_GOOD_INTERVAL_DAYS = [
  1,
  3,
  7,
  14,
  30,
  60,
  120,
  240,
  365,
] as const;

export interface SrsCardRecord {
  cardId: string;
  studyId: string;
  chapterId: string;
  firstReviewedAt: number;
  lastReviewedAt: number;
  dueAt: number;
  /** Zero while a failed card is in the short relearning step. */
  intervalDays: number;
  reviewCount: number;
  successCount: number;
  lapseCount: number;
  consecutiveGood: number;
  /** Current recall confidence from 0 through 100. */
  mastery: number;
  totalResponseMs: number;
  lastGrade: SessionSrsGrade;
}

export interface SrsProgress {
  version: typeof SRS_PROGRESS_VERSION;
  updatedAt: number;
  /** Durable records are addressed directly by the parser's stable card ID. */
  cards: Record<string, SrsCardRecord>;
}

/** Minimal persistence contract; IndexedDB/local implementations live outside core. */
export interface SrsProgressStorage {
  load(): Promise<SrsProgress | undefined>;
  save(progress: SrsProgress): Promise<void>;
}

export interface SrsCardContext {
  studyId: string;
  chapterId: string;
}

export interface SrsCardDefinition extends SrsCardContext {
  cardId: string;
  moveId: string;
  fromNodeId: string;
  fen: string;
  positionKey: string;
  uci: string;
  san: string;
}

export interface DueSrsCard extends SrsCardDefinition {
  record: SrsCardRecord;
}

export interface SrsSummary {
  totalCards: number;
  newCards: number;
  reviewedCards: number;
  dueCards: number;
  learningCards: number;
  masteredCards: number;
  masteryPercent: number;
  totalReviews: number;
  totalLapses: number;
  /** Earliest scheduled time, including cards that are already overdue. */
  earliestDueAt: number | null;
  /** Earliest scheduled time strictly after `now`. */
  nextDueAt: number | null;
}

export type SrsScopeSource = RepertoireChapter | RepertoireStudy;

export class InvalidSrsProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSrsProgressError";
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite timestamp.`);
  }
}

function assertSessionGrade(grade: SessionCardGrade): void {
  if (!grade.cardId) throw new Error("An SRS grade must have a card ID.");
  if (grade.grade !== "again" && grade.grade !== "good") {
    throw new Error(`Unsupported SRS grade: ${String(grade.grade)}.`);
  }
  assertTimestamp(grade.firstAttemptAt, "firstAttemptAt");
  assertTimestamp(grade.lastAttemptAt, "lastAttemptAt");
  if (grade.lastAttemptAt < grade.firstAttemptAt) {
    throw new Error("lastAttemptAt cannot precede firstAttemptAt.");
  }
  if (!Number.isFinite(grade.totalResponseMs) || grade.totalResponseMs < 0) {
    throw new Error("totalResponseMs must be a non-negative finite number.");
  }
}

function nextGoodIntervalDays(consecutiveGood: number): number {
  const index = Math.min(
    Math.max(0, consecutiveGood - 1),
    SRS_GOOD_INTERVAL_DAYS.length - 1,
  );
  return SRS_GOOD_INTERVAL_DAYS[index];
}

function nextGoodMastery(
  previous: SrsCardRecord | undefined,
  consecutiveGood: number,
): number {
  const streakFloor = [0, 20, 35, 50, 65, 80, 90, 100][
    Math.min(consecutiveGood, 7)
  ];
  return Math.min(
    100,
    Math.max(streakFloor, (previous?.mastery ?? 5) + 15),
  );
}

function contextOf(
  chapter: Pick<RepertoireChapter, "id" | "studyId"> | SrsCardContext,
): SrsCardContext {
  return {
    studyId: chapter.studyId,
    chapterId: "id" in chapter ? chapter.id : chapter.chapterId,
  };
}

/** Create an empty, serializable progress document with an explicit clock. */
export function createSrsProgress(now = Date.now()): SrsProgress {
  assertTimestamp(now, "now");
  return { version: SRS_PROGRESS_VERSION, updatedAt: now, cards: {} };
}

/**
 * Calculate one card update without mutating the previous record.
 * Reapplying an already-recorded or older grade is intentionally idempotent.
 */
export function gradeSrsCard(
  previous: SrsCardRecord | undefined,
  context: SrsCardContext,
  grade: SessionCardGrade,
): SrsCardRecord {
  assertSessionGrade(grade);
  if (!context.studyId || !context.chapterId) {
    throw new Error("An SRS card needs both studyId and chapterId.");
  }
  if (previous && previous.cardId !== grade.cardId) {
    throw new Error("The previous SRS record belongs to another card.");
  }
  if (
    previous &&
    (previous.studyId !== context.studyId ||
      previous.chapterId !== context.chapterId)
  ) {
    throw new Error(`Card ${grade.cardId} belongs to another chapter.`);
  }
  if (previous && grade.lastAttemptAt <= previous.lastReviewedAt) {
    return { ...previous };
  }

  const isGood = grade.grade === "good";
  const consecutiveGood = isGood ? (previous?.consecutiveGood ?? 0) + 1 : 0;
  const intervalDays = isGood ? nextGoodIntervalDays(consecutiveGood) : 0;
  const mastery = isGood
    ? nextGoodMastery(previous, consecutiveGood)
    : Math.max(0, (previous?.mastery ?? 0) - 35);
  const dueAt = isGood
    ? grade.lastAttemptAt + intervalDays * SRS_DAY_MS
    : grade.lastAttemptAt + SRS_AGAIN_DELAY_MS;

  return {
    cardId: grade.cardId,
    studyId: context.studyId,
    chapterId: context.chapterId,
    firstReviewedAt: previous?.firstReviewedAt ?? grade.firstAttemptAt,
    lastReviewedAt: grade.lastAttemptAt,
    dueAt,
    intervalDays,
    reviewCount: (previous?.reviewCount ?? 0) + 1,
    successCount: (previous?.successCount ?? 0) + (isGood ? 1 : 0),
    lapseCount: (previous?.lapseCount ?? 0) + (isGood ? 0 : 1),
    consecutiveGood,
    mastery,
    totalResponseMs:
      (previous?.totalResponseMs ?? 0) + grade.totalResponseMs,
    lastGrade: grade.grade,
  };
}

/** Persist all aggregate grades emitted by one ChapterTrainer session. */
export function applySessionCardGrades(
  progress: SrsProgress,
  chapter: Pick<RepertoireChapter, "id" | "studyId"> | SrsCardContext,
  grades: readonly SessionCardGrade[],
  now = Date.now(),
): SrsProgress {
  assertTimestamp(now, "now");
  const context = contextOf(chapter);
  const cards = { ...progress.cards };
  const seen = new Set<string>();
  let latestTimestamp = progress.updatedAt;

  for (const grade of grades) {
    if (seen.has(grade.cardId)) {
      throw new Error(`Duplicate session grade for card ${grade.cardId}.`);
    }
    seen.add(grade.cardId);
    cards[grade.cardId] = gradeSrsCard(cards[grade.cardId], context, grade);
    latestTimestamp = Math.max(latestTimestamp, grade.lastAttemptAt);
  }

  return {
    version: SRS_PROGRESS_VERSION,
    updatedAt: Math.max(now, latestTimestamp),
    cards,
  };
}

/** List each learnable move once, in the chapter's stable move order. */
export function listChapterSrsCards(
  chapter: RepertoireChapter,
): SrsCardDefinition[] {
  const seen = new Set<string>();
  const cards: SrsCardDefinition[] = [];
  for (const move of Object.values(chapter.moves)) {
    if (!move.cardId || move.trainingRole !== "train" || seen.has(move.cardId)) {
      continue;
    }
    const position = chapter.positions[move.fromNodeId];
    if (!position) continue;
    seen.add(move.cardId);
    cards.push({
      cardId: move.cardId,
      studyId: chapter.studyId,
      chapterId: chapter.id,
      moveId: move.id,
      fromNodeId: move.fromNodeId,
      fen: position.fen,
      positionKey: position.positionKey,
      uci: move.uci,
      san: move.san,
    });
  }
  return cards;
}

function chaptersFromSources(
  sources: readonly SrsScopeSource[],
): RepertoireChapter[] {
  return sources.flatMap((source) =>
    "chapters" in source ? source.chapters : [source],
  );
}

function uniqueDefinitions(
  chapters: readonly RepertoireChapter[],
): SrsCardDefinition[] {
  const seen = new Set<string>();
  const result: SrsCardDefinition[] = [];
  for (const chapter of chapters) {
    for (const card of listChapterSrsCards(chapter)) {
      if (seen.has(card.cardId)) continue;
      seen.add(card.cardId);
      result.push(card);
    }
  }
  return result;
}

function summarizeDefinitions(
  definitions: readonly SrsCardDefinition[],
  progress: SrsProgress,
  now: number,
): SrsSummary {
  assertTimestamp(now, "now");
  let newCards = 0;
  let dueCards = 0;
  let masteredCards = 0;
  let masteryTotal = 0;
  let totalReviews = 0;
  let totalLapses = 0;
  let earliestDueAt = Number.POSITIVE_INFINITY;
  let nextDueAt = Number.POSITIVE_INFINITY;

  for (const definition of definitions) {
    const record = progress.cards[definition.cardId];
    if (!record) {
      newCards += 1;
      continue;
    }
    masteryTotal += record.mastery;
    totalReviews += record.reviewCount;
    totalLapses += record.lapseCount;
    if (record.mastery >= SRS_MASTERY_THRESHOLD) masteredCards += 1;
    if (record.dueAt <= now) dueCards += 1;
    earliestDueAt = Math.min(earliestDueAt, record.dueAt);
    if (record.dueAt > now) nextDueAt = Math.min(nextDueAt, record.dueAt);
  }

  const totalCards = definitions.length;
  const reviewedCards = totalCards - newCards;
  return {
    totalCards,
    newCards,
    reviewedCards,
    dueCards,
    learningCards: reviewedCards - masteredCards,
    masteredCards,
    masteryPercent:
      totalCards === 0 ? 0 : Math.round(masteryTotal / totalCards),
    totalReviews,
    totalLapses,
    earliestDueAt:
      earliestDueAt === Number.POSITIVE_INFINITY ? null : earliestDueAt,
    nextDueAt: nextDueAt === Number.POSITIVE_INFINITY ? null : nextDueAt,
  };
}

export function getChapterSrsSummary(
  chapter: RepertoireChapter,
  progress: SrsProgress,
  now = Date.now(),
): SrsSummary {
  return summarizeDefinitions(listChapterSrsCards(chapter), progress, now);
}

export function getStudySrsSummary(
  study: RepertoireStudy,
  progress: SrsProgress,
  now = Date.now(),
): SrsSummary {
  return summarizeDefinitions(uniqueDefinitions(study.chapters), progress, now);
}

export function getGlobalSrsSummary(
  sources: readonly SrsScopeSource[],
  progress: SrsProgress,
  now = Date.now(),
): SrsSummary {
  return summarizeDefinitions(
    uniqueDefinitions(chaptersFromSources(sources)),
    progress,
    now,
  );
}

/** Due reviewed cards only; unseen cards stay in the separate `newCards` bucket. */
export function listDueSrsCards(
  sources: readonly SrsScopeSource[],
  progress: SrsProgress,
  now = Date.now(),
): DueSrsCard[] {
  assertTimestamp(now, "now");
  return uniqueDefinitions(chaptersFromSources(sources))
    .flatMap((definition) => {
      const record = progress.cards[definition.cardId];
      return record && record.dueAt <= now
        ? [{ ...definition, record: { ...record } }]
        : [];
    })
    .sort(
      (left, right) =>
        left.record.dueAt - right.record.dueAt ||
        left.cardId.localeCompare(right.cardId),
    );
}

function invalid(message: string): never {
  throw new InvalidSrsProgressError(message);
}

function finiteNumber(
  value: unknown,
  name: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(`${name} must be a finite number.`);
  }
  if (options.integer && !Number.isInteger(value)) {
    return invalid(`${name} must be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    return invalid(`${name} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    return invalid(`${name} must be at most ${options.max}.`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${name} must be a non-empty string.`);
  }
  return value;
}

function parseCardRecord(value: unknown, key: string): SrsCardRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`Card ${key} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  const cardId = nonEmptyString(candidate.cardId, `cards.${key}.cardId`);
  if (cardId !== key) return invalid(`Card key ${key} does not match its ID.`);
  const firstReviewedAt = finiteNumber(
    candidate.firstReviewedAt,
    `cards.${key}.firstReviewedAt`,
    { min: 0 },
  );
  const lastReviewedAt = finiteNumber(
    candidate.lastReviewedAt,
    `cards.${key}.lastReviewedAt`,
    { min: firstReviewedAt },
  );
  const reviewCount = finiteNumber(
    candidate.reviewCount,
    `cards.${key}.reviewCount`,
    { integer: true, min: 1 },
  );
  const successCount = finiteNumber(
    candidate.successCount,
    `cards.${key}.successCount`,
    { integer: true, min: 0 },
  );
  const lapseCount = finiteNumber(
    candidate.lapseCount,
    `cards.${key}.lapseCount`,
    { integer: true, min: 0 },
  );
  if (reviewCount !== successCount + lapseCount) {
    return invalid(`Card ${key} has inconsistent review counters.`);
  }
  const consecutiveGood = finiteNumber(
    candidate.consecutiveGood,
    `cards.${key}.consecutiveGood`,
    { integer: true, min: 0, max: successCount },
  );
  const lastGrade = candidate.lastGrade;
  if (lastGrade !== "again" && lastGrade !== "good") {
    return invalid(`Card ${key} has an unsupported last grade.`);
  }

  return {
    cardId,
    studyId: nonEmptyString(candidate.studyId, `cards.${key}.studyId`),
    chapterId: nonEmptyString(candidate.chapterId, `cards.${key}.chapterId`),
    firstReviewedAt,
    lastReviewedAt,
    dueAt: finiteNumber(candidate.dueAt, `cards.${key}.dueAt`, { min: 0 }),
    intervalDays: finiteNumber(
      candidate.intervalDays,
      `cards.${key}.intervalDays`,
      { min: 0, max: SRS_GOOD_INTERVAL_DAYS.at(-1) },
    ),
    reviewCount,
    successCount,
    lapseCount,
    consecutiveGood,
    mastery: finiteNumber(candidate.mastery, `cards.${key}.mastery`, {
      integer: true,
      min: 0,
      max: 100,
    }),
    totalResponseMs: finiteNumber(
      candidate.totalResponseMs,
      `cards.${key}.totalResponseMs`,
      { min: 0 },
    ),
    lastGrade,
  };
}

/** Validate and clone an unknown value read from durable storage. */
export function parseSrsProgress(value: unknown): SrsProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("SRS progress must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== SRS_PROGRESS_VERSION) {
    return invalid(`Unsupported SRS progress version: ${String(candidate.version)}.`);
  }
  const updatedAt = finiteNumber(candidate.updatedAt, "updatedAt", { min: 0 });
  if (
    !candidate.cards ||
    typeof candidate.cards !== "object" ||
    Array.isArray(candidate.cards)
  ) {
    return invalid("SRS cards must be an object.");
  }

  const cards: Record<string, SrsCardRecord> = {};
  for (const [key, value] of Object.entries(candidate.cards)) {
    const record = parseCardRecord(value, key);
    if (record.lastReviewedAt > updatedAt) {
      return invalid(`Card ${key} was reviewed after progress was updated.`);
    }
    cards[key] = record;
  }
  return { version: SRS_PROGRESS_VERSION, updatedAt, cards };
}

export function serializeSrsProgress(progress: SrsProgress): string {
  return JSON.stringify(parseSrsProgress(progress));
}

export function deserializeSrsProgress(serialized: string): SrsProgress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid("SRS progress is not valid JSON.");
  }
  return parseSrsProgress(parsed);
}

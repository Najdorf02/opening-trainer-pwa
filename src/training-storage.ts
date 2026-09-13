import type {
  GameReviewTrainingAggregate,
  GameReviewTrainingOccurrence,
  RepertoireChapterRef,
  RepertoireReviewMoveCandidate,
} from '../shared/game-review.js';
import { createSrsProgress, listChapterSrsCards, parseSrsProgress, type SrsProgress } from '../shared/srs.js';
import type { RepertoireChapter, RepertoireMove } from '../shared/repertoire.js';
import type { PromptMove, SerializedTrainerSession } from '../shared/trainer.js';
import type { StudyAnnotationMoment } from './study-annotations.js';
import type { Orientation } from './types.js';

export const TRAINING_STATE_VERSION = 1 as const;

const DATABASE_NAME = 'opening-room-training';
const DATABASE_VERSION = 1;
const STORE_NAME = 'documents';
const STATE_KEY = 'training-state';
const FALLBACK_KEY = 'opening-room.training-state.v1';
const CHECKPOINT_JOURNAL_KEY = 'opening-room.training-checkpoint.v1';

export type SavedTrainingMode = 'chapter' | 'today-review';

export interface SavedTrainerUiState {
  annotationMoments: StudyAnnotationMoment[];
  revealed?: PromptMove;
  knownAvoidMove?: RepertoireMove;
  lastMoveUci?: string;
  wrongCount: number;
  correctCount: number;
}

export interface SavedTrainingSession {
  studyId: string;
  chapterId: string;
  chapterName: string;
  orientation: Orientation;
  sample: boolean;
  mode: SavedTrainingMode;
  /** The exact temporary route set matters for restoring a due-card drill. */
  selectedLineIds: string[];
  /** Present for today's review so context moves do not alter their SRS dates. */
  selectedCardIds?: string[];
  savedAt: number;
  checkpoint: SerializedTrainerSession;
  ui: SavedTrainerUiState;
}

export interface TrainingState {
  version: typeof TRAINING_STATE_VERSION;
  updatedAt: number;
  srs: SrsProgress;
  activeSession?: SavedTrainingSession;
  reviewQueue: Record<string, GameReviewTrainingAggregate>;
}

interface TrainingCheckpointJournal {
  version: typeof TRAINING_STATE_VERSION;
  updatedAt: number;
  srs: SrsProgress;
  /** `null` is a tombstone so a completed session overrides an older IDB copy. */
  activeSession: SavedTrainingSession | null;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as T;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePromptMove(value: unknown): PromptMove | undefined {
  if (!isObject(value)) return undefined;
  const moveId = nonEmptyString(value.moveId);
  const uci = nonEmptyString(value.uci);
  const san = nonEmptyString(value.san);
  if (!moveId || !uci || !san || typeof value.isScheduled !== 'boolean') return undefined;
  return {
    moveId,
    uci,
    san,
    cardId: nonEmptyString(value.cardId),
    isScheduled: value.isScheduled,
  };
}

function parseMoveAnnotations(value: unknown): RepertoireMove['annotations'] | undefined {
  if (!isObject(value)) return undefined;
  const strings = (items: unknown): string[] => Array.isArray(items)
    ? items.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    comments: strings(value.comments),
    nags: strings(value.nags),
    arrows: strings(value.arrows),
    squares: strings(value.squares),
    evaluation: nonEmptyString(value.evaluation),
  };
}

function parseRepertoireMove(value: unknown): RepertoireMove | undefined {
  if (!isObject(value)) return undefined;
  const id = nonEmptyString(value.id);
  const fromNodeId = nonEmptyString(value.fromNodeId);
  const toNodeId = nonEmptyString(value.toNodeId);
  const uci = nonEmptyString(value.uci);
  const san = nonEmptyString(value.san);
  const annotations = parseMoveAnnotations(value.annotations);
  if (
    !id || !fromNodeId || !toNodeId || !uci || !san || !annotations ||
    !Number.isInteger(value.order) || (value.order as number) < 0 ||
    (value.trainingRole !== 'train' && value.trainingRole !== 'avoid')
  ) return undefined;
  return {
    id,
    fromNodeId,
    toNodeId,
    uci,
    san,
    order: value.order as number,
    trainingRole: value.trainingRole,
    cardId: nonEmptyString(value.cardId),
    annotations,
  };
}

function parseAnnotationMoment(value: unknown): StudyAnnotationMoment | undefined {
  if (!isObject(value)) return undefined;
  const fen = nonEmptyString(value.fen);
  if (!fen || !Number.isInteger(value.historyLength) || (value.historyLength as number) < 0) return undefined;
  const comments = Array.isArray(value.comments)
    ? value.comments.filter((item): item is string => typeof item === 'string')
    : [];
  const arrows = Array.isArray(value.arrows)
    ? value.arrows.flatMap((item) => {
        if (!isObject(item)) return [];
        const startSquare = nonEmptyString(item.startSquare);
        const endSquare = nonEmptyString(item.endSquare);
        const color = nonEmptyString(item.color);
        return startSquare && endSquare && color ? [{ startSquare, endSquare, color }] : [];
      })
    : [];
  const squares = Array.isArray(value.squares)
    ? value.squares.flatMap((item) => {
        if (!isObject(item)) return [];
        const square = nonEmptyString(item.square);
        const color = nonEmptyString(item.color);
        return square && color ? [{ square, color }] : [];
      })
    : [];
  return {
    fen,
    moveId: optionalString(value.moveId),
    uci: optionalString(value.uci),
    san: optionalString(value.san),
    historyLength: value.historyLength as number,
    comments,
    arrows,
    squares,
  };
}

function parseChapterRef(value: unknown): RepertoireChapterRef | undefined {
  if (!isObject(value)) return undefined;
  const studyId = nonEmptyString(value.studyId);
  const chapterId = nonEmptyString(value.chapterId);
  const chapterName = nonEmptyString(value.chapterName);
  const repertoireColor = value.repertoireColor;
  if (!studyId || !chapterId || !chapterName || (repertoireColor !== 'white' && repertoireColor !== 'black')) return undefined;
  return {
    studyId,
    studyName: nonEmptyString(value.studyName),
    chapterId,
    chapterName,
    repertoireColor,
    sourceUrl: nonEmptyString(value.sourceUrl),
  };
}

function parseReviewCandidate(value: unknown): RepertoireReviewMoveCandidate | undefined {
  if (!isObject(value)) return undefined;
  const moveId = nonEmptyString(value.moveId);
  const uci = nonEmptyString(value.uci);
  const san = nonEmptyString(value.san);
  if (!moveId || !uci || !san || !isObject(value.annotations) || !Array.isArray(value.chapters)) return undefined;
  const chapters = value.chapters.map(parseChapterRef).filter((item): item is RepertoireChapterRef => Boolean(item));
  const annotations = value.annotations;
  return {
    moveId,
    uci,
    san,
    cardId: nonEmptyString(value.cardId),
    annotations: {
      comments: Array.isArray(annotations.comments) ? annotations.comments.filter((item): item is string => typeof item === 'string') : [],
      nags: Array.isArray(annotations.nags) ? annotations.nags.filter((item): item is string => typeof item === 'string') : [],
      arrows: Array.isArray(annotations.arrows) ? annotations.arrows.filter((item): item is string => typeof item === 'string') : [],
      squares: Array.isArray(annotations.squares) ? annotations.squares.filter((item): item is string => typeof item === 'string') : [],
      evaluation: nonEmptyString(annotations.evaluation),
    },
    chapters,
  };
}

function parseReviewPosition(value: unknown): GameReviewTrainingAggregate | undefined {
  if (!isObject(value) || value.source !== 'chesscom-review') return undefined;
  const positionKey = nonEmptyString(value.positionKey);
  const fen = nonEmptyString(value.fen);
  const userColor = value.userColor;
  if (!positionKey || !fen || (userColor !== 'white' && userColor !== 'black')) return undefined;
  const correctMoves = Array.isArray(value.correctMoves)
    ? value.correctMoves.map(parseReviewCandidate).filter((item): item is RepertoireReviewMoveCandidate => Boolean(item))
    : [];
  if (correctMoves.length === 0) return undefined;
  const matchingChapters = Array.isArray(value.matchingChapters)
    ? value.matchingChapters.map(parseChapterRef).filter((item): item is RepertoireChapterRef => Boolean(item))
    : [];
  const occurrences: GameReviewTrainingOccurrence[] = Array.isArray(value.occurrences)
    ? value.occurrences.flatMap((entry) => {
        if (!isObject(entry) || !isObject(entry.playedMove)) return [];
        const gameId = nonEmptyString(entry.gameId);
        const uci = nonEmptyString(entry.playedMove.uci);
        const san = nonEmptyString(entry.playedMove.san);
        const reason = entry.reason;
        if (!gameId || !uci || !san || (reason !== 'move-not-covered' && reason !== 'known-avoid')) return [];
        return [{
          gameId,
          gameUrl: nonEmptyString(entry.gameUrl),
          playedAt: nonEmptyString(entry.playedAt),
          playedMove: { uci, san },
          reason,
        }];
      })
    : [];
  return {
    source: 'chesscom-review',
    positionKey,
    fen,
    userColor,
    correctMoves,
    matchingChapters,
    occurrences,
    occurrenceCount: occurrences.length,
  };
}

function parseSession(value: unknown): SavedTrainingSession | undefined {
  if (!isObject(value) || !isObject(value.ui) || !isObject(value.checkpoint)) return undefined;
  const studyId = nonEmptyString(value.studyId);
  const chapterId = nonEmptyString(value.chapterId);
  const chapterName = nonEmptyString(value.chapterName);
  const orientation = value.orientation;
  const mode = value.mode;
  const savedAt = value.savedAt;
  if (
    !studyId || !chapterId || !chapterName ||
    (orientation !== 'white' && orientation !== 'black') ||
    (mode !== 'chapter' && mode !== 'today-review') ||
    typeof value.sample !== 'boolean' ||
    typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt < 0 ||
    !Array.isArray(value.selectedLineIds)
  ) return undefined;
  const selectedLineIds = [...new Set(value.selectedLineIds.filter((item): item is string => typeof item === 'string' && item.length > 0))];
  if (selectedLineIds.length === 0) return undefined;
  const selectedCardIds = Array.isArray(value.selectedCardIds)
    ? [...new Set(value.selectedCardIds.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : undefined;
  if (mode === 'today-review' && !selectedCardIds?.length) return undefined;
  const ui = value.ui;
  return {
    studyId,
    chapterId,
    chapterName,
    orientation,
    sample: value.sample,
    mode,
    selectedLineIds,
    ...(selectedCardIds?.length ? { selectedCardIds } : {}),
    savedAt,
    checkpoint: clone(value.checkpoint) as unknown as SerializedTrainerSession,
    ui: {
      annotationMoments: Array.isArray(ui.annotationMoments)
        ? ui.annotationMoments.flatMap((moment) => parseAnnotationMoment(moment) ?? [])
        : [],
      revealed: parsePromptMove(ui.revealed),
      knownAvoidMove: parseRepertoireMove(ui.knownAvoidMove),
      lastMoveUci: nonEmptyString(ui.lastMoveUci),
      wrongCount: nonNegativeInteger(ui.wrongCount),
      correctCount: nonNegativeInteger(ui.correctCount),
    },
  };
}

export function createTrainingState(now = Date.now()): TrainingState {
  return {
    version: TRAINING_STATE_VERSION,
    updatedAt: now,
    srs: createSrsProgress(now),
    reviewQueue: {},
  };
}

/** Invalid optional documents are discarded without sacrificing valid SRS data. */
export function parseTrainingState(value: unknown, now = Date.now()): TrainingState {
  if (!isObject(value) || value.version !== TRAINING_STATE_VERSION) return createTrainingState(now);
  let srs: SrsProgress;
  try {
    srs = parseSrsProgress(value.srs);
  } catch {
    srs = createSrsProgress(now);
  }
  const reviewQueue: Record<string, GameReviewTrainingAggregate> = {};
  if (isObject(value.reviewQueue)) {
    for (const position of Object.values(value.reviewQueue)) {
      const parsed = parseReviewPosition(position);
      if (parsed) reviewQueue[parsed.positionKey] = parsed;
    }
  }
  return {
    version: TRAINING_STATE_VERSION,
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : now,
    srs,
    activeSession: parseSession(value.activeSession),
    reviewQueue,
  };
}

function parseTrainingCheckpointJournal(value: unknown): TrainingCheckpointJournal | undefined {
  if (
    !isObject(value) || value.version !== TRAINING_STATE_VERSION ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
  ) return undefined;

  let srs: SrsProgress;
  try {
    srs = parseSrsProgress(value.srs);
  } catch {
    return undefined;
  }
  const activeSession = value.activeSession === null ? null : parseSession(value.activeSession);
  if (activeSession === undefined) return undefined;
  return {
    version: TRAINING_STATE_VERSION,
    updatedAt: value.updatedAt,
    srs,
    activeSession,
  };
}

function chapterRefKey(ref: RepertoireChapterRef): string {
  return `${ref.studyId}\u0000${ref.chapterId}`;
}

function mergeChapterRefs(left: readonly RepertoireChapterRef[], right: readonly RepertoireChapterRef[]): RepertoireChapterRef[] {
  const refs = new Map(left.map((item) => [chapterRefKey(item), clone(item)]));
  for (const item of right) refs.set(chapterRefKey(item), clone(item));
  return [...refs.values()];
}

/**
 * Remove records that no longer identify a learnable move in a chapter whose
 * latest repertoire has been loaded. Records for other chapters are preserved:
 * an offline/sample library is not authoritative for studies it cannot see.
 */
export function pruneStaleSrsCards(
  progress: SrsProgress,
  chapters: readonly RepertoireChapter[],
  now = Date.now(),
): SrsProgress {
  const validCardsByChapter = new Map<string, Set<string>>();
  for (const chapter of chapters) {
    const key = `${chapter.studyId}\u0000${chapter.id}`;
    const validCards = validCardsByChapter.get(key) ?? new Set<string>();
    for (const card of listChapterSrsCards(chapter)) validCards.add(card.cardId);
    validCardsByChapter.set(key, validCards);
  }

  const cards = { ...progress.cards };
  let changed = false;
  for (const record of Object.values(progress.cards)) {
    const validCards = validCardsByChapter.get(`${record.studyId}\u0000${record.chapterId}`);
    if (!validCards || validCards.has(record.cardId)) continue;
    delete cards[record.cardId];
    changed = true;
  }
  return changed ? { ...progress, cards, updatedAt: Math.max(progress.updatedAt, now) } : progress;
}

export function mergeReviewPosition(
  previous: GameReviewTrainingAggregate | undefined,
  incoming: GameReviewTrainingAggregate,
): GameReviewTrainingAggregate {
  if (!previous || previous.positionKey !== incoming.positionKey) return clone(incoming);
  const moves = new Map(previous.correctMoves.map((move) => [move.uci, clone(move)]));
  for (const move of incoming.correctMoves) {
    const existing = moves.get(move.uci);
    if (!existing) {
      moves.set(move.uci, clone(move));
      continue;
    }
    // Keep cardId/moveId and the leading chapter from one representative. The
    // incoming candidate normally wins so refreshed study data replaces stale
    // IDs; if it has no card, retain the earlier trainable candidate instead.
    const useIncoming = Boolean(move.cardId) || !existing.cardId;
    const representative = clone(useIncoming ? move : existing);
    const other = useIncoming ? existing : move;
    moves.set(move.uci, {
      ...representative,
      chapters: mergeChapterRefs(representative.chapters, other.chapters),
    });
  }
  const occurrences = new Map(
    previous.occurrences.map((item) => [`${item.gameId}\u0000${item.playedMove.uci}`, clone(item)]),
  );
  for (const item of incoming.occurrences) {
    occurrences.set(`${item.gameId}\u0000${item.playedMove.uci}`, clone(item));
  }
  return {
    ...clone(incoming),
    correctMoves: [...moves.values()],
    matchingChapters: mergeChapterRefs(previous.matchingChapters, incoming.matchingChapters),
    occurrences: [...occurrences.values()].sort((a, b) => (b.playedAt ?? '').localeCompare(a.playedAt ?? '')),
    occurrenceCount: occurrences.size,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('훈련 저장소를 열지 못했습니다.'));
  });
}

async function loadFromIndexedDb(): Promise<unknown> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('훈련 기록을 읽지 못했습니다.'));
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => database.close();
  });
}

async function saveToIndexedDb(state: TrainingState): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(clone(state), STATE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('훈련 기록을 저장하지 못했습니다.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('훈련 기록 저장이 취소됐습니다.'));
  }).finally(() => database.close());
}

/**
 * Synchronously journal the data that changes while training. This closes the
 * durability gap where iOS can terminate a PWA before an IndexedDB transaction
 * (or an earlier queued save) has started or completed.
 */
export function saveTrainingCheckpointJournal(state: TrainingState): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const existingRaw = window.localStorage.getItem(CHECKPOINT_JOURNAL_KEY);
    if (existingRaw) {
      try {
        const existing = parseTrainingCheckpointJournal(JSON.parse(existingRaw) as unknown);
        // Full-state writes run through an async queue. By the time an older
        // queued write starts, a newer UI commit may already be in this
        // synchronous journal. Never let that older write roll it back.
        if (existing && existing.updatedAt > state.updatedAt) return true;
      } catch {
        // Replace malformed data with the current valid checkpoint below.
      }
    }
    const journal: TrainingCheckpointJournal = {
      version: TRAINING_STATE_VERSION,
      updatedAt: state.updatedAt,
      srs: state.srs,
      activeSession: state.activeSession ?? null,
    };
    window.localStorage.setItem(CHECKPOINT_JOURNAL_KEY, JSON.stringify(journal));
    return true;
  } catch {
    // IndexedDB remains the primary store when localStorage is blocked or full.
    return false;
  }
}

export async function loadTrainingState(now = Date.now()): Promise<TrainingState> {
  let indexedState: TrainingState | undefined;
  try {
    if (typeof indexedDB !== 'undefined') {
      const stored = await loadFromIndexedDb();
      if (isObject(stored) && stored.version === TRAINING_STATE_VERSION) {
        indexedState = parseTrainingState(stored, now);
      }
    }
  } catch {
    // Safari private browsing and hardened desktop policies may block IndexedDB.
  }

  let fallbackState: TrainingState | undefined;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(FALLBACK_KEY) : null;
    if (raw) {
      const stored = JSON.parse(raw) as unknown;
      if (isObject(stored) && stored.version === TRAINING_STATE_VERSION) {
        fallbackState = parseTrainingState(stored, now);
      }
    }
  } catch {
    // A malformed or unavailable fallback must not hide a valid IndexedDB copy.
  }

  const persistedState = indexedState && fallbackState
    ? (fallbackState.updatedAt > indexedState.updatedAt ? fallbackState : indexedState)
    : indexedState ?? fallbackState;

  let checkpointJournal: TrainingCheckpointJournal | undefined;
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CHECKPOINT_JOURNAL_KEY) : null;
    if (raw) checkpointJournal = parseTrainingCheckpointJournal(JSON.parse(raw) as unknown);
  } catch {
    // A malformed or unavailable journal must not hide the primary copy.
  }

  const state = persistedState ?? createTrainingState(now);
  if (!checkpointJournal || (persistedState && checkpointJournal.updatedAt < persistedState.updatedAt)) return state;

  const restored: TrainingState = {
    ...state,
    updatedAt: checkpointJournal.updatedAt,
    srs: checkpointJournal.srs,
  };
  if (checkpointJournal.activeSession) restored.activeSession = checkpointJournal.activeSession;
  else delete restored.activeSession;
  return restored;
}

export async function saveTrainingState(state: TrainingState): Promise<void> {
  // `updatedAt` identifies the logical commit. Advancing it again when an older
  // queued save starts could incorrectly outrank a newer synchronous journal.
  const normalized = parseTrainingState(state);
  saveTrainingCheckpointJournal(normalized);
  try {
    if (typeof indexedDB !== 'undefined') {
      await saveToIndexedDb(normalized);
      void navigator.storage?.persist?.().catch(() => false);
      return;
    }
  } catch {
    // Keep a smaller localStorage fallback for environments where IndexedDB fails.
  }
  window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(normalized));
}

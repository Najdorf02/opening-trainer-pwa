import { getSampleChapter, sampleLibrary } from './sample';
import type { RepertoireChapter, RepertoireStudy } from '../shared/repertoire.js';
import type {
  AuthStatus,
  ChessComGamesPayload,
  ChapterDetail,
  ChapterSummary,
  LibraryPayload,
  OpeningExplorerFilters,
  OpeningExplorerPayload,
  OpeningMoveEvaluation,
  Orientation,
  SyncResult,
  TrainingLine,
} from './types';

// Keep the runtime transport in sync with vite.config.ts even when a developer
// invokes `vite build --mode pwa` without the convenience npm script.
const IS_PWA = import.meta.env.MODE === 'pwa' || import.meta.env.VITE_PWA_MODE === 'true';

type BrowserApi = typeof import('./browser-api.js');
let browserApiPromise: Promise<BrowserApi> | undefined;

function browserApi(): Promise<BrowserApi> {
  browserApiPromise ??= import('./browser-api.js');
  return browserApiPromise;
}

export interface ApiErrorOptions {
  status: number;
  code?: string;
  /** Raw Retry-After header value (delay seconds or an HTTP date). */
  retryAfter?: string;
}

/** HTTP failure returned by this app's JSON API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: string;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as {
      error?: { code?: unknown; message?: unknown };
    } | undefined;
    const message = typeof body?.error?.message === 'string' && body.error.message
      ? body.error.message
      : `요청 실패 (${response.status})`;
    const code = typeof body?.error?.code === 'string' && body.error.code
      ? body.error.code
      : undefined;
    const retryAfter = response.headers.get('Retry-After') ?? undefined;
    throw new ApiError(message, { status: response.status, code, retryAfter });
  }
  return response.json() as Promise<T>;
}

/** Preserve the existing ApiError contract when a static PWA calls upstream APIs directly. */
async function browserRequest<T>(operation: (api: BrowserApi) => Promise<T>): Promise<T> {
  try {
    return await operation(await browserApi());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      const retryAfter = 'retryAfter' in error && typeof error.retryAfter === 'string'
        ? error.retryAfter
        : ('retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
          ? String(error.retryAfterSeconds)
          : undefined);
      throw new ApiError(error.message, { status: error.status, retryAfter });
    }
    throw error;
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  try {
    if (IS_PWA) return await browserRequest((api) => api.browserAuthStatus());
    return await request<AuthStatus>('/api/auth/status');
  } catch {
    return { connected: false };
  }
}

export async function beginLogin(): Promise<void> {
  if (IS_PWA) return browserRequest((api) => api.browserBeginLogin());
  const { authorizationUrl } = await request<{ authorizationUrl: string }>('/api/auth/login', { method: 'POST' });
  window.location.assign(authorizationUrl);
}

export async function logout(): Promise<void> {
  if (IS_PWA) return browserRequest((api) => api.browserLogout());
  await request('/api/auth/logout', { method: 'DELETE' });
}

function isOrientation(value: unknown): value is Orientation {
  return value === 'white' || value === 'black';
}

function normalizeLibrary(raw: unknown): LibraryPayload {
  const payload = raw as { studies?: Array<Record<string, unknown>>; sample?: boolean };
  if (!Array.isArray(payload?.studies)) throw new Error('연구 목록 형식이 올바르지 않습니다.');
  return {
    sample: Boolean(payload.sample),
    studies: payload.studies.map((study) => {
      const chapters = Array.isArray(study.chapters) ? study.chapters as Array<Record<string, unknown>> : [];
      return {
        id: String(study.id),
        name: String(study.name ?? '제목 없는 연구'),
        orientation: isOrientation(study.orientation) ? study.orientation : undefined,
        updatedAt: typeof study.updatedAt === 'string' ? study.updatedAt : undefined,
        chapters: chapters.map((chapter): ChapterSummary => ({
          id: String(chapter.id),
          studyId: String(chapter.studyId ?? study.id),
          name: String(chapter.name ?? '제목 없는 챕터'),
          orientation: isOrientation(chapter.orientation)
            ? chapter.orientation
            : (isOrientation(study.orientation) ? study.orientation : 'white'),
          cardCount: Number(chapter.cardCount ?? 0),
          lineCount: Number(chapter.lineCount ?? 0),
          sourceUrl: typeof chapter.sourceUrl === 'string' ? chapter.sourceUrl : undefined,
          lines: Array.isArray(chapter.lines) ? chapter.lines as TrainingLine[] : undefined,
        })),
      };
    }),
  };
}

export async function getLibrary(connected: boolean): Promise<LibraryPayload> {
  if (IS_PWA) {
    const cached = normalizeLibrary(await browserRequest((api) => api.browserLibrary()));
    return connected || cached.studies.length ? cached : sampleLibrary;
  }
  if (!connected) return sampleLibrary;
  return normalizeLibrary(await request('/api/library'));
}

/** Read the server-side Lichess cache even when OAuth is no longer connected. */
export async function getCachedLibrary(): Promise<LibraryPayload> {
  if (IS_PWA) return normalizeLibrary(await browserRequest((api) => api.browserLibrary()));
  return normalizeLibrary(await request('/api/library'));
}

/** Full repertoire graphs used for matching imported games in one request. */
export async function getCachedRepertoires(): Promise<RepertoireStudy[]> {
  if (IS_PWA) return browserRequest((api) => api.browserRepertoires());
  const payload = await request<{ studies: RepertoireStudy[] }>('/api/repertoires');
  if (!Array.isArray(payload.studies)) throw new Error('레퍼토리 캐시 형식이 올바르지 않습니다.');
  return payload.studies;
}

export async function syncStudies(): Promise<SyncResult> {
  if (IS_PWA) return browserRequest((api) => api.browserSyncStudies());
  return request<SyncResult>('/api/sync', { method: 'POST' });
}

function isRepertoireChapter(value: unknown): value is RepertoireChapter {
  if (!value || typeof value !== 'object') return false;
  const chapter = value as Partial<RepertoireChapter>;
  return typeof chapter.rootNodeId === 'string'
    && typeof chapter.rootFen === 'string'
    && Boolean(chapter.positions && chapter.positions[chapter.rootNodeId])
    && Boolean(chapter.moves && typeof chapter.moves === 'object')
    && Array.isArray(chapter.lines);
}

function repertoireToLines(repertoire: RepertoireChapter): TrainingLine[] {
  return [...repertoire.lines]
    .sort((left, right) => left.order - right.order)
    .map((line) => ({
      id: line.id,
      initialFen: repertoire.rootFen,
      moves: line.moveIds.map((moveId) => {
        const move = repertoire.moves[moveId];
        if (!move) throw new Error('레퍼토리 그래프의 수 참조가 올바르지 않습니다.');
        const promotion = move.uci[4] as 'q' | 'r' | 'b' | 'n' | undefined;
        return {
          from: move.uci.slice(0, 2),
          to: move.uci.slice(2, 4),
          san: move.san,
          ...(promotion ? { promotion } : {}),
        };
      }),
    }));
}

export async function getChapter(chapter: ChapterSummary, sample: boolean): Promise<ChapterDetail> {
  if (sample || chapter.id.startsWith('sample-')) {
    const found = getSampleChapter(chapter.id);
    if (!found) throw new Error('샘플 챕터를 찾지 못했습니다.');
    return found;
  }
  const raw = IS_PWA
    ? await browserRequest((api) => api.browserChapter(chapter.id))
    : await request<ChapterDetail | { chapter: ChapterDetail }>(`/api/chapters/${encodeURIComponent(chapter.id)}`);
  const detail = 'chapter' in raw ? raw.chapter : raw;
  if (!isRepertoireChapter(detail.repertoire)) {
    throw new Error('이 챕터는 이전 캐시 형식입니다. 연구를 다시 동기화해 주세요.');
  }
  const lines = Array.isArray(detail.lines) ? detail.lines : repertoireToLines(detail.repertoire);
  if (!lines.length) throw new Error('이 챕터에서 훈련 라인을 만들지 못했습니다.');
  return { ...chapter, ...detail, repertoire: detail.repertoire, lines };
}

export async function getOpeningExplorer(
  fen: string,
  filters: OpeningExplorerFilters,
): Promise<OpeningExplorerPayload> {
  if (IS_PWA) return browserRequest((api) => api.browserOpeningExplorer(fen, filters));
  const query = new URLSearchParams({
    fen,
    speeds: filters.speeds.join(','),
    ratings: filters.ratings.join(','),
    moves: String(filters.moves ?? 12),
  });
  return request<OpeningExplorerPayload>(`/api/opening-practice/explorer?${query}`);
}

export async function evaluateOpeningMove(
  fen: string,
  move: string,
  maxCpl = 80,
): Promise<OpeningMoveEvaluation> {
  if (IS_PWA) return browserRequest((api) => api.browserEvaluateOpeningMove(fen, move, maxCpl));
  return request<OpeningMoveEvaluation>('/api/opening-practice/evaluate', {
    method: 'POST',
    body: JSON.stringify({ fen, move, maxCpl }),
  });
}

export async function getChessComGames(
  username = 'Yshaarrj',
  months = 3,
): Promise<ChessComGamesPayload> {
  if (IS_PWA) return browserRequest((api) => api.browserChessComGames(username, months));
  const query = new URLSearchParams({ username, months: String(months) });
  return request<ChessComGamesPayload>(`/api/chesscom/games?${query}`);
}

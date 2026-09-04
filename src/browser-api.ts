import { ChessComApiError, ChessComClient } from '../server/chesscom.js';
import { LichessApiError, type LichessStudyMetadata } from '../server/lichess.js';
import {
  OpeningDataError,
  OpeningPracticeClient,
  type OpeningSpeed,
} from '../server/opening-practice.js';
import { parseStudyPgn } from '../server/parser.js';
import {
  CACHE_SCHEMA_VERSION,
  type CatalogDocument,
  type ChapterDetail,
  type ParsedStudy,
  type StoredStudy,
} from '../server/types.js';
import type { RepertoireStudy } from '../shared/repertoire.js';
import type {
  AuthStatus,
  ChessComGamesPayload,
  LibraryPayload,
  OpeningExplorerFilters,
  OpeningExplorerPayload,
  OpeningMoveEvaluation,
  SyncResult,
} from './types.js';

const OWNER = 'SaturdayCthuns';
const LICHESS_ORIGIN = 'https://lichess.org';
const OAUTH_CLIENT_ID = 'najdorf02.github.io/opening-trainer-pwa';
const OAUTH_PENDING_KEY = 'opening-room.oauth.pending.v1';
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const DB_NAME = 'opening-room-pwa';
const DB_VERSION = 1;
const RECORDS_STORE = 'records';
const CATALOG_KEY = 'catalog';
const CREDENTIAL_KEY = 'credential';
const RATE_LIMIT_KEY = 'rate-limit-until';

interface BrowserCredential {
  accessToken: string;
  username: string;
  expiresAt: number;
}

interface PendingAuthorization {
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

interface OAuthTokenResponse {
  token_type?: unknown;
  access_token?: unknown;
  expires_in?: unknown;
}

interface LichessAccountResponse {
  id?: unknown;
  username?: unknown;
}

let databasePromise: Promise<IDBDatabase> | undefined;
let callbackPromise: Promise<AuthStatus> | undefined;
let syncing = false;

const openingClient = new OpeningPracticeClient();
const chessComClient = new ChessComClient({
  // Browsers own the User-Agent header and some WebKit releases reject attempts
  // to set it. Keep the shared parser/client while stripping only that header.
  fetchImpl: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('User-Agent');
    return fetch(input, { ...init, headers });
  },
});

export interface BrowserApiFailure extends Error {
  status?: number;
  retryAfter?: string;
}

export async function browserAuthStatus(): Promise<AuthStatus> {
  if (hasOAuthCallback()) {
    callbackPromise ??= completeOAuthCallback();
    return callbackPromise;
  }
  const credential = await readCredential();
  return credentialStatus(credential);
}

export async function browserBeginLogin(): Promise<void> {
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = appRedirectUri();
  const pending: PendingAuthorization = {
    state,
    verifier,
    redirectUri,
    expiresAt: Date.now() + OAUTH_PENDING_TTL_MS,
  };
  localStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));

  const authorizationUrl = new URL('/oauth', LICHESS_ORIGIN);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: 'study:read',
    username: OWNER,
    state,
  }).toString();

  // iOS Home Screen apps keep storage separate from Safari. WebKit documents
  // window.open as the reliable way to keep a third-party OAuth flow in the
  // web-app context even though lichess.org is outside our manifest scope.
  const loginContext = window.open(authorizationUrl.toString(), '_self');
  if (!loginContext) window.location.assign(authorizationUrl);
}

export async function browserLogout(): Promise<void> {
  const credential = await readCredential();
  try {
    if (credential) {
      await lichessRequest('/api/token', {
        method: 'DELETE',
        headers: bearerHeaders(credential.accessToken),
      });
    }
  } finally {
    await deleteRecord(CREDENTIAL_KEY);
    localStorage.removeItem(OAUTH_PENDING_KEY);
  }
}

export async function browserLibrary(): Promise<LibraryPayload> {
  const catalog = await readCatalog();
  return { studies: catalog.studies, sample: false };
}

export async function browserRepertoires(): Promise<RepertoireStudy[]> {
  const catalog = await readCatalog();
  const parsed = await Promise.all(catalog.studies.map((study) => readParsedStudy(study.id)));
  return parsed.map((item) => ({
    id: item.study.id,
    name: item.study.name,
    chapters: item.chapters.map((chapter) => chapter.repertoire),
  }));
}

export async function browserChapter(chapterId: string): Promise<ChapterDetail> {
  const catalog = await readCatalog();
  const study = catalog.studies.find((item) => item.chapters.some((chapter) => chapter.id === chapterId));
  if (!study) throw new Error('캐시에서 챕터를 찾지 못했습니다. 연구를 다시 동기화해 주세요.');
  const parsed = await readParsedStudy(study.id);
  const chapter = parsed.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw new Error('캐시에서 챕터를 찾지 못했습니다. 연구를 다시 동기화해 주세요.');
  return chapter;
}

export async function browserSyncStudies(): Promise<SyncResult> {
  if (syncing) throw failure('이미 리체스 동기화를 진행하고 있습니다.', 409);
  const credential = await requireCredential();
  const rateLimitedUntil = await getRecord<number>(RATE_LIMIT_KEY);
  if (rateLimitedUntil && rateLimitedUntil > Date.now()) {
    const seconds = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1_000));
    throw failure(`${seconds}초 뒤에 다시 동기화해 주세요.`, 429, String(seconds));
  }

  syncing = true;
  try {
    const metadata = await studiesByUser(credential.accessToken);
    const current = await readCatalog();
    const currentById = new Map(current.studies.map((study) => [study.id, study]));
    const nextStudies: StoredStudy[] = [];
    const errors: SyncResult['errors'] = [];
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    // Lichess requests API consumers to make one request at a time.
    for (const remote of metadata) {
      const previous = currentById.get(remote.id);
      if (previous && Date.parse(previous.updatedAt) === remote.updatedAt) {
        try {
          // Browsers can evict individual IndexedDB records under storage
          // pressure. Do not permanently skip a study whose catalog survived
          // but whose parsed PGN blob did not.
          await readParsedStudy(remote.id);
          nextStudies.push(previous);
          skipped += 1;
          continue;
        } catch {
          // Fall through and repair the local copy from Lichess.
        }
      }
      try {
        const parsed = await importStudy(remote, credential.accessToken);
        await putRecord(studyKey(remote.id), parsed);
        nextStudies.push(parsed.study);
        imported += 1;
      } catch (error) {
        if (isAuthorizationFailure(error)) {
          await deleteRecord(CREDENTIAL_KEY);
          throw failure('리체스 연결이 만료되었습니다. 다시 연결해 주세요.', 401);
        }
        if (isRateLimitFailure(error)) {
          await rememberRateLimit(error);
          throw error;
        }
        if (statusOf(error) >= 500) throw error;
        failed += 1;
        errors.push({
          studyId: remote.id,
          studyName: remote.name,
          message: messageOf(error, '연구를 가져오지 못했습니다.').slice(0, 500),
        });
        if (previous) nextStudies.push(previous);
      }
    }

    const lastSyncAt = new Date().toISOString();
    const catalog: CatalogDocument = {
      version: CACHE_SCHEMA_VERSION,
      owner: OWNER,
      lastSyncAt,
      studies: nextStudies,
    };
    await putRecord(CATALOG_KEY, catalog);

    // Only remove stale blobs after the new catalog has been committed.
    const activeIds = new Set(nextStudies.map((study) => study.id));
    await Promise.all(current.studies
      .filter((study) => !activeIds.has(study.id))
      .map((study) => deleteRecord(studyKey(study.id))));
    await deleteRecord(RATE_LIMIT_KEY);
    void navigator.storage?.persist?.().catch(() => false);
    return { imported, skipped, failed, lastSyncAt, errors };
  } catch (error) {
    if (isAuthorizationFailure(error)) {
      await deleteRecord(CREDENTIAL_KEY);
      throw failure('리체스 연결이 만료되었습니다. 다시 연결해 주세요.', 401);
    }
    if (isRateLimitFailure(error)) await rememberRateLimit(error);
    throw error;
  } finally {
    syncing = false;
  }
}

export async function browserOpeningExplorer(
  fen: string,
  filters: OpeningExplorerFilters,
): Promise<OpeningExplorerPayload> {
  const credential = await requireCredential();
  return openingClient.explore({
    fen,
    speeds: filters.speeds as OpeningSpeed[],
    ratings: filters.ratings,
    moves: filters.moves ?? 12,
  }, credential.accessToken) as Promise<OpeningExplorerPayload>;
}

export async function browserEvaluateOpeningMove(
  fen: string,
  move: string,
  maxCpl = 80,
): Promise<OpeningMoveEvaluation> {
  return openingClient.evaluate(fen, move, maxCpl) as Promise<OpeningMoveEvaluation>;
}

export async function browserChessComGames(
  username: string,
  months: number,
): Promise<ChessComGamesPayload> {
  return chessComClient.games({ username, months });
}

async function completeOAuthCallback(): Promise<AuthStatus> {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const pending = readPendingAuthorization();
    // Consume the verifier before any network request so a callback cannot be replayed.
    localStorage.removeItem(OAUTH_PENDING_KEY);
    if (!state || !pending) throw new Error('리체스 연결 정보가 없거나 만료되었습니다.');
    if (pending.expiresAt <= Date.now() || !constantTimeEqual(pending.state, state)) {
      throw new Error('리체스 연결 요청이 만료되었거나 일치하지 않습니다.');
    }
    if (pending.redirectUri !== appRedirectUri()) {
      throw new Error('리체스 연결을 시작한 주소와 돌아온 주소가 다릅니다.');
    }
    if (params.has('error')) {
      throw new Error(params.get('error_description') || '리체스에서 연결을 취소했습니다.');
    }
    if (!code) throw new Error('리체스가 승인 코드를 보내지 않았습니다.');

    const tokenResponse = await lichessRequest('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    const token = await tokenResponse.json() as OAuthTokenResponse;
    if (
      token.token_type !== 'Bearer'
      || typeof token.access_token !== 'string'
      || !isSafeOAuthValue(token.access_token, 4_096)
      || !Number.isFinite(token.expires_in)
      || Number(token.expires_in) <= 0
    ) {
      throw failure('리체스가 올바르지 않은 로그인 응답을 보냈습니다.', 502);
    }

    const accountResponse = await lichessRequest('/api/account', {
      headers: bearerHeaders(token.access_token, 'application/json'),
    });
    const account = await accountResponse.json() as LichessAccountResponse;
    if (typeof account.id !== 'string' || typeof account.username !== 'string') {
      await revokeQuietly(token.access_token);
      throw failure('리체스 계정 정보를 확인하지 못했습니다.', 502);
    }
    if (account.username.toLocaleLowerCase('en-US') !== OWNER.toLocaleLowerCase('en-US')) {
      await revokeQuietly(token.access_token);
      throw new Error(`${OWNER} 계정으로 로그인해 주세요.`);
    }

    const credential: BrowserCredential = {
      accessToken: token.access_token,
      username: account.username,
      // Keep a small margin so an almost-expired token is never presented as connected.
      expiresAt: Date.now() + Number(token.expires_in) * 1_000 - 30_000,
    };
    await putRecord(CREDENTIAL_KEY, credential);
    replaceOAuthQuery('connected');
    return credentialStatus(credential);
  } catch (error) {
    localStorage.removeItem(OAUTH_PENDING_KEY);
    replaceOAuthQuery('error');
    return { connected: false };
  }
}

async function importStudy(metadata: LichessStudyMetadata, token: string): Promise<ParsedStudy> {
  const query = new URLSearchParams({
    clocks: 'false',
    comments: 'true',
    variations: 'true',
    orientation: 'true',
  });
  const response = await lichessRequest(`/api/study/${encodeURIComponent(metadata.id)}.pgn?${query}`, {
    headers: bearerHeaders(token, 'application/x-chess-pgn'),
  });
  const pgn = await response.text();
  const updatedAt = new Date(metadata.updatedAt).toISOString();
  const parsed = await parseStudyPgn(pgn, {
    studyId: metadata.id,
    studyName: metadata.name,
    updatedAt,
  });
  return {
    ...parsed,
    study: { ...parsed.study, id: metadata.id, name: metadata.name, updatedAt },
    chapters: parsed.chapters.map((chapter) => ({ ...chapter, studyId: metadata.id })),
  };
}

async function studiesByUser(token: string): Promise<LichessStudyMetadata[]> {
  const response = await lichessRequest(`/api/study/by/${encodeURIComponent(OWNER)}`, {
    headers: bearerHeaders(token, 'application/x-ndjson'),
  });
  const body = await response.text();
  const studies: LichessStudyMetadata[] = [];
  for (const [index, line] of body.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw failure(`리체스 연구 목록 ${index + 1}번째 줄을 읽지 못했습니다.`, 502);
    }
    const study = value as Partial<LichessStudyMetadata>;
    if (
      typeof study.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(study.id)
      || typeof study.name !== 'string'
      || !Number.isFinite(study.createdAt)
      || !Number.isFinite(study.updatedAt)
    ) {
      throw failure('리체스가 올바르지 않은 연구 목록을 보냈습니다.', 502);
    }
    studies.push(study as LichessStudyMetadata);
  }
  return studies;
}

async function lichessRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(path, LICHESS_ORIGIN), { ...init, signal: controller.signal });
  } catch {
    throw failure('리체스에 연결하지 못했습니다. 네트워크를 확인해 주세요.', 502);
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After') ?? undefined;
    throw failure(
      response.status === 429
        ? '리체스 요청 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.'
        : '리체스가 요청을 거부했습니다.',
      response.status,
      retryAfter,
    );
  }
  return response;
}

function bearerHeaders(token: string, accept?: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) };
}

async function requireCredential(): Promise<BrowserCredential> {
  const credential = await readCredential();
  if (!credential) throw failure('리체스 계정을 다시 연결해 주세요.', 401);
  return credential;
}

async function readCredential(): Promise<BrowserCredential | undefined> {
  const credential = await getRecord<BrowserCredential>(CREDENTIAL_KEY);
  if (!credential) return undefined;
  if (
    typeof credential.accessToken !== 'string'
    || !isSafeOAuthValue(credential.accessToken, 4_096)
    || typeof credential.username !== 'string'
    || credential.username.toLocaleLowerCase('en-US') !== OWNER.toLocaleLowerCase('en-US')
    || !Number.isFinite(credential.expiresAt)
    || credential.expiresAt <= Date.now()
  ) {
    await deleteRecord(CREDENTIAL_KEY);
    return undefined;
  }
  return credential;
}

function credentialStatus(credential: BrowserCredential | undefined): AuthStatus {
  return credential
    ? { connected: true, username: credential.username, expiresAt: new Date(credential.expiresAt).toISOString() }
    : { connected: false };
}

async function readCatalog(): Promise<CatalogDocument> {
  const catalog = await getRecord<CatalogDocument>(CATALOG_KEY);
  if (!catalog) return emptyCatalog();
  if (
    catalog.version !== CACHE_SCHEMA_VERSION
    || catalog.owner !== OWNER
    || !Array.isArray(catalog.studies)
    || !(catalog.lastSyncAt === null || typeof catalog.lastSyncAt === 'string')
  ) {
    return emptyCatalog();
  }
  return catalog;
}

async function readParsedStudy(studyId: string): Promise<ParsedStudy> {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(studyId)) throw new Error('올바르지 않은 연구 ID입니다.');
  const parsed = await getRecord<ParsedStudy>(studyKey(studyId));
  if (
    !parsed
    || parsed.schemaVersion !== CACHE_SCHEMA_VERSION
    || !parsed.study
    || !Array.isArray(parsed.chapters)
    || parsed.chapters.some((chapter) => !chapter.repertoire?.positions || !chapter.repertoire?.moves)
  ) {
    throw new Error('연구 캐시가 오래되었습니다. 연구를 다시 동기화해 주세요.');
  }
  return parsed;
}

function emptyCatalog(): CatalogDocument {
  return { version: CACHE_SCHEMA_VERSION, owner: OWNER, lastSyncAt: null, studies: [] };
}

function studyKey(studyId: string): string {
  return `study:${studyId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORDS_STORE)) database.createObjectStore(RECORDS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('브라우저 저장소를 열지 못했습니다.'));
    request.onblocked = () => reject(new Error('다른 창에서 앱 업데이트를 막고 있습니다. 열린 앱을 닫고 다시 시도해 주세요.'));
  });
  return databasePromise;
}

async function getRecord<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(RECORDS_STORE, 'readonly').objectStore(RECORDS_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error('브라우저 저장소를 읽지 못했습니다.'));
  });
}

async function putRecord<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDS_STORE, 'readwrite');
    transaction.objectStore(RECORDS_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('브라우저 저장소에 기록하지 못했습니다.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('브라우저 저장소 기록이 중단되었습니다.'));
  });
}

async function deleteRecord(key: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDS_STORE, 'readwrite');
    transaction.objectStore(RECORDS_STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('브라우저 저장소를 정리하지 못했습니다.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('브라우저 저장소 정리가 중단되었습니다.'));
  });
}

function hasOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') || params.has('state') || params.has('error');
}

function appRedirectUri(): string {
  // A canonical path avoids redirect URI mismatches when a user enters through
  // /index.html or another alias of the deployed app.
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}

function replaceOAuthQuery(result: 'connected' | 'error'): void {
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ lichess: result }).toString();
  url.hash = '';
  window.history.replaceState({}, '', url);
}

function readPendingAuthorization(): PendingAuthorization | undefined {
  const raw = localStorage.getItem(OAUTH_PENDING_KEY);
  if (!raw) return undefined;
  try {
    const pending = JSON.parse(raw) as Partial<PendingAuthorization>;
    if (
      typeof pending.state !== 'string'
      || typeof pending.verifier !== 'string'
      || typeof pending.redirectUri !== 'string'
      || typeof pending.expiresAt !== 'number'
    ) return undefined;
    return pending as PendingAuthorization;
  } catch {
    return undefined;
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isSafeOAuthValue(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/u.test(value);
}

async function revokeQuietly(token: string): Promise<void> {
  try {
    await lichessRequest('/api/token', { method: 'DELETE', headers: bearerHeaders(token) });
  } catch {
    // The local credential is never stored when account verification fails.
  }
}

function failure(message: string, status: number, retryAfter?: string): BrowserApiFailure {
  const error = new Error(message) as BrowserApiFailure;
  error.status = status;
  error.retryAfter = retryAfter;
  return error;
}

function statusOf(error: unknown): number {
  if (error instanceof LichessApiError || error instanceof OpeningDataError || error instanceof ChessComApiError) {
    return error.status;
  }
  if (error instanceof Error && 'status' in error && typeof error.status === 'number') return error.status;
  return 0;
}

function isAuthorizationFailure(error: unknown): boolean {
  const status = statusOf(error);
  return status === 401 || status === 403;
}

function isRateLimitFailure(error: unknown): boolean {
  return statusOf(error) === 429;
}

async function rememberRateLimit(error: unknown): Promise<void> {
  let seconds = 60;
  if (error instanceof Error && 'retryAfter' in error && typeof error.retryAfter === 'string') {
    const numeric = Number(error.retryAfter);
    const date = Date.parse(error.retryAfter);
    if (Number.isFinite(numeric) && numeric >= 0) seconds = Math.max(60, Math.ceil(numeric));
    else if (Number.isFinite(date)) seconds = Math.max(60, Math.ceil((date - Date.now()) / 1_000));
  }
  await putRecord(RATE_LIMIT_KEY, Date.now() + seconds * 1_000);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

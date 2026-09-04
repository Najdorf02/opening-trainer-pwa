import type { MemoryAuthStore } from './auth';
import { LichessApiError, type LichessClient, type LichessStudyMetadata } from './lichess';
import { parseStudyPgn } from './parser';
import type { StudyStorage } from './storage';
import { CACHE_SCHEMA_VERSION, type CatalogDocument, type ChapterDetail, type ParsedStudy, type StoredStudy } from './types';
import type { RepertoireStudy } from '../shared/repertoire.js';

export interface SyncResult {
  imported: number;
  skipped: number;
  failed: number;
  lastSyncAt: string;
  errors: SyncFailure[];
}

export interface SyncFailure {
  studyId: string;
  studyName: string;
  message: string;
}

export interface StudySyncServiceOptions {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  minRateLimitBackoffMs?: number;
  maxRateLimitRetries?: number;
}

interface RateLimitBudget {
  remaining: number;
}

export class NotConnectedError extends Error {
  constructor() {
    super('Lichess is not connected.');
    this.name = 'NotConnectedError';
  }
}

export class SyncInProgressError extends Error {
  constructor() {
    super('A Lichess sync is already running.');
    this.name = 'SyncInProgressError';
  }
}

export class SyncRateLimitedError extends LichessApiError {
  constructor(
    readonly rateLimitedUntil: string,
    retryAfterSeconds: number,
  ) {
    super(
      `Lichess is still rate-limiting study imports. Sync is paused until ${rateLimitedUntil}.`,
      429,
      retryAfterSeconds,
    );
  }
}

export class StudySyncService {
  private syncing = false;
  private rateLimitedUntilMs = 0;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly minRateLimitBackoffMs: number;
  private readonly maxRateLimitRetries: number;

  constructor(
    private readonly auth: MemoryAuthStore,
    private readonly lichess: LichessClient,
    private readonly storage: StudyStorage,
    options: StudySyncServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? delay;
    this.minRateLimitBackoffMs = options.minRateLimitBackoffMs ?? 60_000;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 1;
    if (!Number.isFinite(this.minRateLimitBackoffMs) || this.minRateLimitBackoffMs < 60_000) {
      throw new Error('Lichess rate-limit backoff must be at least 60 seconds.');
    }
    if (!Number.isInteger(this.maxRateLimitRetries) || this.maxRateLimitRetries < 0) {
      throw new Error('Lichess rate-limit retries must be a non-negative integer.');
    }
  }

  async sync(): Promise<SyncResult> {
    if (this.syncing) throw new SyncInProgressError();
    const credential = this.auth.getCredential();
    if (!credential) throw new NotConnectedError();
    const cooldownError = this.currentRateLimitError();
    if (cooldownError) throw cooldownError;
    this.syncing = true;
    try {
      // Share one small retry budget across the whole sync so a rate-limited account
      // cannot trigger a minute-long retry for every study in the catalog.
      const rateLimitBudget = { remaining: this.maxRateLimitRetries };
      const remoteStudies = await this.runAuthorized(
        () => this.lichess.studiesByUser(credential.accessToken),
        rateLimitBudget,
      );
      const current = await this.storage.readCatalog();
      const currentById = new Map(current.studies.map((study) => [study.id, study]));
      const nextStudies: StoredStudy[] = [];
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const errors: SyncFailure[] = [];

      // Lichess asks API clients to make requests one at a time. Keep this loop sequential.
      for (const metadata of remoteStudies) {
        const previous = currentById.get(metadata.id);
        if (previous && Date.parse(previous.updatedAt) === metadata.updatedAt) {
          nextStudies.push(previous);
          skipped += 1;
          continue;
        }
        try {
          const parsed = await this.importStudy(metadata, credential.accessToken, rateLimitBudget);
          await this.storage.writeStudy(metadata.id, parsed.pgn, parsed.parsed);
          nextStudies.push(parsed.parsed.study);
          imported += 1;
        } catch (error) {
          if (isAuthorizationFailure(error)) {
            this.auth.clearCredential();
            throw new NotConnectedError();
          }
          // Stop the remaining sequential imports when Lichess remains rate-limited
          // after the one allowed retry, or when the service itself is unavailable.
          if (error instanceof LichessApiError && (error.status === 429 || error.status >= 500)) {
            throw error;
          }
          failed += 1;
          errors.push({
            studyId: metadata.id,
            studyName: metadata.name,
            message: studyFailureMessage(error),
          });
          if (previous) nextStudies.push(previous);
        }
      }

      const lastSyncAt = this.now().toISOString();
      const catalog: CatalogDocument = {
        version: CACHE_SCHEMA_VERSION,
        owner: credential.username,
        lastSyncAt,
        studies: nextStudies,
      };
      await this.storage.writeCatalog(catalog);
      return { imported, skipped, failed, lastSyncAt, errors };
    } finally {
      this.syncing = false;
    }
  }

  async library(): Promise<CatalogDocument> {
    return this.storage.readCatalog();
  }

  async chapter(chapterId: string): Promise<ChapterDetail | undefined> {
    const catalog = await this.storage.readCatalog();
    const study = catalog.studies.find((item) => item.chapters.some((chapter) => chapter.id === chapterId));
    if (!study) return undefined;
    const parsed = await this.storage.readParsedStudy(study.id);
    return parsed.chapters.find((chapter) => chapter.id === chapterId);
  }

  /**
   * Loads each cached study once for whole-library consumers such as game review.
   * This avoids reparsing the same multi-chapter study for every chapter request.
   */
  async repertoires(): Promise<RepertoireStudy[]> {
    const catalog = await this.storage.readCatalog();
    const parsedStudies = await Promise.all(
      catalog.studies.map((study) => this.storage.readParsedStudy(study.id)),
    );
    return parsedStudies.map((parsed) => ({
      id: parsed.study.id,
      name: parsed.study.name,
      chapters: parsed.chapters.map((chapter) => chapter.repertoire),
    }));
  }

  private async importStudy(
    metadata: LichessStudyMetadata,
    accessToken: string,
    rateLimitBudget: RateLimitBudget,
  ): Promise<{ pgn: string; parsed: ParsedStudy }> {
    const pgn = await this.runAuthorized(
      () => this.lichess.studyPgn(metadata.id, accessToken),
      rateLimitBudget,
    );
    const updatedAt = new Date(metadata.updatedAt).toISOString();
    const parsed = await parseStudyPgn(pgn, {
      studyId: metadata.id,
      studyName: metadata.name,
      updatedAt,
    });
    return {
      pgn,
      parsed: {
        ...parsed,
        study: { ...parsed.study, id: metadata.id, name: metadata.name, updatedAt },
        chapters: parsed.chapters.map((chapter) => ({ ...chapter, studyId: metadata.id })),
      },
    };
  }

  private async runAuthorized<T>(
    action: () => Promise<T>,
    rateLimitBudget: RateLimitBudget,
  ): Promise<T> {
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (isAuthorizationFailure(error)) this.auth.clearCredential();
        if (error instanceof LichessApiError && error.status === 429) {
          const backoffMs = Math.max(
            this.minRateLimitBackoffMs,
            (error.retryAfterSeconds ?? 0) * 1_000,
          );
          if (rateLimitBudget.remaining <= 0) {
            throw this.beginRateLimitCooldown(backoffMs);
          }
          rateLimitBudget.remaining -= 1;
          await this.sleep(backoffMs);
          continue;
        }
        throw error;
      }
    }
  }

  private currentRateLimitError(): SyncRateLimitedError | undefined {
    const nowMs = this.now().getTime();
    if (this.rateLimitedUntilMs <= nowMs) {
      this.rateLimitedUntilMs = 0;
      return undefined;
    }
    return this.makeRateLimitError(nowMs);
  }

  private beginRateLimitCooldown(backoffMs: number): SyncRateLimitedError {
    const nowMs = this.now().getTime();
    this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs, nowMs + backoffMs);
    return this.makeRateLimitError(nowMs);
  }

  private makeRateLimitError(nowMs: number): SyncRateLimitedError {
    return new SyncRateLimitedError(
      new Date(this.rateLimitedUntilMs).toISOString(),
      Math.max(1, Math.ceil((this.rateLimitedUntilMs - nowMs) / 1_000)),
    );
  }
}

function isAuthorizationFailure(error: unknown): boolean {
  return error instanceof LichessApiError && (error.status === 401 || error.status === 403);
}

function studyFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message ? message.slice(0, 500) : 'The study could not be imported.';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

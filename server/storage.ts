import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CACHE_SCHEMA_VERSION, type CatalogDocument, type ParsedStudy } from './types';

const EMPTY_CATALOG = (owner: string): CatalogDocument => ({
  version: CACHE_SCHEMA_VERSION,
  owner,
  lastSyncAt: null,
  studies: [],
});

export class StudyStorage {
  private readonly studiesDir: string;
  private readonly catalogPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly owner: string,
  ) {
    this.studiesDir = path.join(dataDir, 'studies');
    this.catalogPath = path.join(dataDir, 'catalog.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.studiesDir, { recursive: true });
  }

  async readCatalog(): Promise<CatalogDocument> {
    try {
      const raw = await readFile(this.catalogPath, 'utf8');
      const parsed = JSON.parse(raw) as Omit<Partial<CatalogDocument>, 'version'> & { version?: number };
      // Versions 1 and 2 predate parts of the current training graph semantics.
      // Rebuild them through sync instead of silently training stale data.
      if (parsed.version === 1 || parsed.version === 2) return EMPTY_CATALOG(this.owner);
      if (
        parsed.version !== CACHE_SCHEMA_VERSION
        || parsed.owner !== this.owner
        || !Array.isArray(parsed.studies)
        || !(parsed.lastSyncAt === null || typeof parsed.lastSyncAt === 'string')
      ) {
        throw new Error('Unsupported catalog format.');
      }
      return parsed as CatalogDocument;
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_CATALOG(this.owner);
      throw error;
    }
  }

  async writeCatalog(catalog: CatalogDocument): Promise<void> {
    if (catalog.owner !== this.owner || catalog.version !== CACHE_SCHEMA_VERSION) {
      throw new Error('Refusing to write a catalog for a different owner.');
    }
    await this.atomicWrite(this.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  async writeStudy(studyId: string, pgn: string, parsed: ParsedStudy): Promise<void> {
    this.assertSafeId(studyId);
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      throw new Error('Refusing to write an unsupported parsed-study cache.');
    }
    await Promise.all([
      this.atomicWrite(this.pgnPath(studyId), pgn),
      this.atomicWrite(this.parsedPath(studyId), `${JSON.stringify(parsed, null, 2)}\n`),
    ]);
  }

  async readPgn(studyId: string): Promise<string> {
    this.assertSafeId(studyId);
    return readFile(this.pgnPath(studyId), 'utf8');
  }

  async readParsedStudy(studyId: string): Promise<ParsedStudy> {
    this.assertSafeId(studyId);
    const parsed = JSON.parse(await readFile(this.parsedPath(studyId), 'utf8')) as Partial<ParsedStudy>;
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION
      || !parsed.study
      || !Array.isArray(parsed.chapters)
      || parsed.chapters.some((chapter) => !chapter.repertoire?.positions || !chapter.repertoire?.moves)
    ) {
      throw new Error('Parsed study cache is outdated; synchronize the study again.');
    }
    return parsed as ParsedStudy;
  }

  private pgnPath(studyId: string): string {
    return path.join(this.studiesDir, `${studyId}.pgn`);
  }

  private parsedPath(studyId: string): string {
    return path.join(this.studiesDir, `${studyId}.json`);
  }

  private assertSafeId(id: string): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid study ID.');
  }

  private async atomicWrite(target: string, contents: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

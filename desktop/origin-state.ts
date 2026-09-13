import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_HOST = '127.0.0.1';
export const PREFERRED_DESKTOP_PORT = 5173;
export const DESKTOP_PORT_ATTEMPTS = 40;
export const DESKTOP_ORIGIN_STATE_FILENAME = 'desktop-origin.json';

const STATE_SCHEMA_VERSION = 1;
const LAST_DESKTOP_PORT = PREFERRED_DESKTOP_PORT + DESKTOP_PORT_ATTEMPTS - 1;

interface DesktopOriginState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  origin: string;
  port: number;
}

/**
 * Chromium storage, including IndexedDB, is scoped to an origin. Since a URL's
 * port is part of its origin, the desktop renderer must keep using the same
 * local port across restarts or saved training data will appear to disappear.
 */
export function desktopOrigin(port: number): string {
  assertDesktopPort(port);
  return `http://${DESKTOP_HOST}:${port}`;
}

/**
 * A fresh install may probe the small legacy range once. As soon as a port is
 * persisted, only that port is returned: silently falling back would switch
 * the renderer to a different IndexedDB origin.
 */
export function desktopPortCandidates(persistedPort?: number): number[] {
  if (persistedPort !== undefined) {
    assertDesktopPort(persistedPort);
    return [persistedPort];
  }
  return Array.from(
    { length: DESKTOP_PORT_ATTEMPTS },
    (_value, offset) => PREFERRED_DESKTOP_PORT + offset,
  );
}

export async function readDesktopOriginPort(dataDir: string): Promise<number | undefined> {
  const statePath = desktopOriginStatePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DesktopOriginState>;
    if (
      parsed.schemaVersion !== STATE_SCHEMA_VERSION
      || typeof parsed.port !== 'number'
      || parsed.origin !== desktopOrigin(parsed.port)
    ) {
      throw new Error('Unsupported desktop origin state.');
    }
    return parsed.port;
  } catch (error) {
    throw new Error(
      `저장된 데스크톱 주소 설정이 손상되었습니다: ${statePath}`,
      { cause: error },
    );
  }
}

/**
 * Writes the chosen origin before a BrowserWindow is allowed to load it. This
 * makes a failed write a startup failure instead of creating data at an origin
 * that cannot be recovered on the next launch.
 */
export async function persistDesktopOriginPort(dataDir: string, port: number): Promise<void> {
  assertDesktopPort(port);
  const existing = await readDesktopOriginPort(dataDir);
  if (existing !== undefined) {
    if (existing === port) return;
    throw new Error(
      `데스크톱 저장소 주소는 ${desktopOrigin(existing)}에서 ${desktopOrigin(port)}로 변경할 수 없습니다.`,
    );
  }

  await mkdir(dataDir, { recursive: true });
  const statePath = desktopOriginStatePath(dataDir);
  const temporaryPath = path.join(
    dataDir,
    `.${DESKTOP_ORIGIN_STATE_FILENAME}.${randomUUID()}.tmp`,
  );
  const state: DesktopOriginState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    origin: desktopOrigin(port),
    port,
  };

  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function desktopOriginStatePath(dataDir: string): string {
  return path.join(dataDir, DESKTOP_ORIGIN_STATE_FILENAME);
}

function assertDesktopPort(port: number): void {
  if (
    !Number.isInteger(port)
    || port < PREFERRED_DESKTOP_PORT
    || port > LAST_DESKTOP_PORT
  ) {
    throw new Error(
      `데스크톱 포트는 ${PREFERRED_DESKTOP_PORT}-${LAST_DESKTOP_PORT} 범위의 정수여야 합니다.`,
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_ORIGIN_STATE_FILENAME,
  DESKTOP_PORT_ATTEMPTS,
  desktopOrigin,
  desktopPortCandidates,
  persistDesktopOriginPort,
  PREFERRED_DESKTOP_PORT,
  readDesktopOriginPort,
} from '../desktop/origin-state';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('desktop renderer origin persistence', () => {
  it('shows that changing the local port changes the storage origin', () => {
    expect(desktopOrigin(5173)).toBe('http://127.0.0.1:5173');
    expect(desktopOrigin(5174)).not.toBe(desktopOrigin(5173));
  });

  it('probes the legacy range only before an origin is persisted', () => {
    const freshCandidates = desktopPortCandidates();
    expect(freshCandidates).toHaveLength(DESKTOP_PORT_ATTEMPTS);
    expect(freshCandidates[0]).toBe(PREFERRED_DESKTOP_PORT);
    expect(freshCandidates.at(-1)).toBe(PREFERRED_DESKTOP_PORT + DESKTOP_PORT_ATTEMPTS - 1);

    expect(desktopPortCandidates(5181)).toEqual([5181]);
  });

  it('atomically persists and restores the selected renderer origin', async () => {
    const dataDir = await makeTemporaryDirectory();
    expect(await readDesktopOriginPort(dataDir)).toBeUndefined();

    await persistDesktopOriginPort(dataDir, 5175);

    expect(await readDesktopOriginPort(dataDir)).toBe(5175);
    expect(JSON.parse(await readFile(
      path.join(dataDir, DESKTOP_ORIGIN_STATE_FILENAME),
      'utf8',
    ))).toEqual({
      schemaVersion: 1,
      origin: 'http://127.0.0.1:5175',
      port: 5175,
    });
  });

  it('allows an idempotent save but refuses to move an established origin', async () => {
    const dataDir = await makeTemporaryDirectory();
    await persistDesktopOriginPort(dataDir, 5173);

    await expect(persistDesktopOriginPort(dataDir, 5173)).resolves.toBeUndefined();
    await expect(persistDesktopOriginPort(dataDir, 5174)).rejects.toThrow(
      /변경할 수 없습니다/u,
    );
    expect(await readDesktopOriginPort(dataDir)).toBe(5173);
  });

  it('fails closed when the saved state is malformed instead of changing origins', async () => {
    const dataDir = await makeTemporaryDirectory();
    await writeFile(
      path.join(dataDir, DESKTOP_ORIGIN_STATE_FILENAME),
      JSON.stringify({ schemaVersion: 1, origin: 'http://127.0.0.1:5174', port: 5173 }),
      'utf8',
    );

    await expect(readDesktopOriginPort(dataDir)).rejects.toThrow(
      /데스크톱 주소 설정이 손상/u,
    );
  });

  it('rejects ports outside the desktop allocation range', () => {
    expect(() => desktopOrigin(80)).toThrow(/5173-5212/u);
    expect(() => desktopPortCandidates(65_535)).toThrow(/5173-5212/u);
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'opening-trainer-origin-'));
  temporaryDirectories.push(directory);
  return directory;
}

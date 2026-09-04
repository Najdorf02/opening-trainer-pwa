import { access, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  app as electronApp,
  BrowserWindow,
  dialog,
  Menu,
  session,
  shell,
} from 'electron';
import { createApp } from '../server/app';
import { MemoryAuthStore } from '../server/auth';
import { loadConfig, type ServerConfig } from '../server/config';
import { LichessClient } from '../server/lichess';
import { OpeningPracticeClient } from '../server/opening-practice';
import { StudyStorage } from '../server/storage';
import { StudySyncService } from '../server/sync';

const APP_NAME = 'Opening Trainer';
const APP_ID = 'com.saturdaycthuns.openingtrainer';
const PREFERRED_PORT = 5173;
const PORT_ATTEMPTS = 40;
const SMOKE_TEST = process.argv.includes('--smoke-test');

interface DesktopRuntime {
  config: ServerConfig;
  server: Server;
  webRoot: string;
}

let mainWindow: BrowserWindow | undefined;
let runtime: DesktopRuntime | undefined;
let shutdownStarted = false;

electronApp.setName(APP_NAME);
const hasSingleInstanceLock = electronApp.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  electronApp.quit();
} else {
  electronApp.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  electronApp.on('window-all-closed', () => electronApp.quit());
  electronApp.on('before-quit', (event) => {
    if (!runtime || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    const server = runtime.server;
    runtime = undefined;
    void closeServer(server).finally(() => electronApp.exit(0));
  });

  void launch().catch(handleStartupError);
}

async function launch(): Promise<void> {
  await electronApp.whenReady();
  electronApp.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  denyBrowserPermissions();

  runtime = await startLocalServer();

  if (SMOKE_TEST) {
    await verifyPackagedRuntime(runtime);
    const server = runtime.server;
    runtime = undefined;
    await closeServer(server);
    electronApp.exit(0);
    return;
  }

  mainWindow = createMainWindow(runtime.config.origin);
  await mainWindow.loadURL(runtime.config.origin);
}

async function startLocalServer(): Promise<DesktopRuntime> {
  const webRoot = electronApp.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.resolve(process.cwd(), 'dist');
  await assertWebBuild(webRoot);

  const dataDir = path.join(electronApp.getPath('userData'), 'data');
  let lastPortError: unknown;

  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = PREFERRED_PORT + offset;
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      OPENING_TRAINER_ORIGIN: `http://127.0.0.1:${port}`,
      OPENING_TRAINER_DATA_DIR: dataDir,
    });

    const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
    const lichess = new LichessClient(config);
    const storage = new StudyStorage(config.dataDir, config.lichessUsername);
    await storage.initialize();
    const sync = new StudySyncService(auth, lichess, storage);
    const openingPractice = new OpeningPracticeClient({ lichessBaseUrl: config.lichessBaseUrl });
    const localApp = createApp({ config, auth, lichess, storage, sync, openingPractice });

    localApp.use(express.static(webRoot));
    localApp.get(/^(?!\/api(?:\/|$)).*/u, (_request, response) => {
      response.sendFile(path.join(webRoot, 'index.html'));
    });

    try {
      const server = await listen(localApp, config);
      return { config, server, webRoot };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      lastPortError = error;
    }
  }

  throw new Error(
    `로컬 포트 ${PREFERRED_PORT}-${PREFERRED_PORT + PORT_ATTEMPTS - 1}를 사용할 수 없습니다.`,
    { cause: lastPortError },
  );
}

function listen(localApp: express.Express, config: ServerConfig): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = localApp.listen(config.port, config.host);
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

function createMainWindow(localOrigin: string): BrowserWindow {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f4f1e9',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const guardMainNavigation = (event: Electron.Event, targetUrl: string) => {
    if (isAllowedMainNavigation(targetUrl, localOrigin)) return;
    event.preventDefault();
  };
  window.webContents.on('will-navigate', guardMainNavigation);
  window.webContents.on('will-redirect', guardMainNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  return window;
}

function denyBrowserPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function isAllowedMainNavigation(rawUrl: string, localOrigin: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === localOrigin || isTrustedLichessUrl(rawUrl);
  } catch {
    return false;
  }
}

function isTrustedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && (
      url.hostname === 'chess.com'
      || url.hostname.endsWith('.chess.com')
      || url.hostname === 'lichess.org'
      || url.hostname.endsWith('.lichess.org')
    );
  } catch {
    return false;
  }
}

function isTrustedLichessUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === 'lichess.org' || url.hostname.endsWith('.lichess.org'));
  } catch {
    return false;
  }
}

async function assertWebBuild(webRoot: string): Promise<void> {
  await access(path.join(webRoot, 'index.html'));
  const assets = await readdir(path.join(webRoot, 'assets'));
  if (!assets.some((name) => /^stockfish-.*\.wasm$/u.test(name))) {
    throw new Error('패키지에 Stockfish WASM 파일이 없습니다.');
  }
  if (!assets.some((name) => /^stockfish-.*\.js$/u.test(name))) {
    throw new Error('패키지에 Stockfish Worker 파일이 없습니다.');
  }
  if (!assets.some((name) => /^Copying-.*\.txt$/u.test(name))) {
    throw new Error('패키지에 Stockfish 라이선스 파일이 없습니다.');
  }
}

async function verifyPackagedRuntime(desktopRuntime: DesktopRuntime): Promise<void> {
  const statusResponse = await fetch(`${desktopRuntime.config.origin}/api/auth/status`);
  if (!statusResponse.ok) throw new Error(`API 스모크 테스트 실패 (${statusResponse.status})`);
  const status = await statusResponse.json() as { connected?: unknown };
  if (typeof status.connected !== 'boolean') throw new Error('API 상태 응답 형식이 올바르지 않습니다.');

  const pageResponse = await fetch(desktopRuntime.config.origin);
  if (!pageResponse.ok || !(await pageResponse.text()).includes('id="root"')) {
    throw new Error('프런트엔드 스모크 테스트에 실패했습니다.');
  }

  const assetNames = (await readdir(path.join(desktopRuntime.webRoot, 'assets')))
    .filter((name) => /^stockfish-.*\.(?:js|wasm)$/u.test(name) || /^Copying-.*\.txt$/u.test(name));
  for (const assetName of assetNames) {
    const response = await fetch(
      `${desktopRuntime.config.origin}/assets/${encodeURIComponent(assetName)}`,
      { method: 'HEAD' },
    );
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) <= 0) {
      throw new Error(`정적 자산 스모크 테스트 실패: ${assetName}`);
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function handleStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : '알 수 없는 오류';
  if (SMOKE_TEST) {
    process.stderr.write(`Opening Trainer smoke test failed: ${message}\n`);
  } else {
    dialog.showErrorBox(
      'Opening Trainer 실행 오류',
      `앱을 시작하지 못했습니다.\n\n${message}`,
    );
  }
  if (runtime) {
    const server = runtime.server;
    runtime = undefined;
    void closeServer(server).finally(() => electronApp.exit(1));
  } else {
    electronApp.exit(1);
  }
}

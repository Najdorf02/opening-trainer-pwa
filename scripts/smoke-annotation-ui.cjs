/*
 * Real Chromium/react-chessboard regression checks, without Playwright.
 * Run: node scripts/smoke-annotation-ui.cjs
 * Each scenario uses a hidden Electron window, an in-memory browser partition,
 * and a loopback Vite server with synthetic studies. No account/data is read.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const temporaryStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-room-annotation-smoke-'));
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--smoke-storage=${temporaryStorage}`], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnvironment,
    windowsHide: true,
    stdio: 'inherit',
  });
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.once('close', (code) => {
    process.exitCode = code ?? 1;
    // Electron releases its profile locks only after the process exits.
    const resolvedTemporary = path.resolve(temporaryStorage);
    const resolvedPrefix = path.resolve(os.tmpdir()) + path.sep;
    if (resolvedTemporary.startsWith(resolvedPrefix) && path.basename(resolvedTemporary).startsWith('opening-room-annotation-smoke-')) {
      fs.rm(resolvedTemporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, (error) => {
        if (error) { console.error(error); process.exitCode = 1; }
      });
    }
  });
} else {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}

async function run() {
  const { app, BrowserWindow } = require('electron');
  const temporaryStorage = process.argv.find((argument) => argument.startsWith('--smoke-storage='))?.slice('--smoke-storage='.length);
  assert.ok(temporaryStorage, 'Run this script using Node so its profile can be cleaned up after Electron exits');
  app.setPath('userData', temporaryStorage);
  app.setPath('sessionData', temporaryStorage);
  app.on('window-all-closed', () => {});
  let vite;
  let fixtureServer;
  let window;
  let exitCode = 0;
  try {
    await app.whenReady();
    const { createServer } = await import('vite');
    let detail;
    let library;
    vite = await createServer({
      root: path.resolve(__dirname, '..'),
      mode: 'development',
      server: { middlewareMode: true, hmr: false },
      plugins: [{
        name: 'synthetic-annotation-smoke-api',
        configureServer(server) {
          server.middlewares.use('/api', (request, response) => {
            response.setHeader('Content-Type', 'application/json');
            if (request.url === '/auth/status') {
              response.end(JSON.stringify({ connected: true, username: 'UI smoke fixture' }));
            } else if (request.url === '/library') {
              response.end(JSON.stringify(library));
            } else if (request.url === `/chapters/${encodeURIComponent(detail?.id)}`) {
              response.end(JSON.stringify(detail));
            } else {
              response.statusCode = 404;
              response.end(JSON.stringify({ error: { message: 'Smoke fixture route not found' } }));
            }
          });
        },
      }],
    });
    const { importLichessStudyPgn } = await vite.ssrLoadModule('/shared/pgn.ts');
    const study = importLichessStudyPgn(`
[Event "Annotation UI smoke"]
[Site "https://lichess.org/study/ui-smoke/annotation"]
[StudyName "Synthetic annotation regression"]
[ChapterName "Annotation smoke"]
[ChapterURL "https://lichess.org/study/ui-smoke/annotation"]
[Orientation "white"]
[Result "*"]

{ ROOT_MEMO } 1. e4 { HISTORIC_MEMO } e5 { LIVE_MEMO } 2. Nf3 Nc6 { FINISHED_MEMO } *
`, { studyId: 'ui-smoke', studyName: 'Synthetic annotation regression' });
    const repertoire = study.chapters[0];
    detail = {
      id: repertoire.id,
      studyId: repertoire.studyId,
      name: repertoire.name,
      orientation: repertoire.repertoireColor,
      cardCount: new Set(Object.values(repertoire.moves).flatMap((move) => move.cardId ? [move.cardId] : [])).size,
      lineCount: repertoire.lines.length,
      repertoire,
      lines: repertoire.lines.map((line) => ({
        id: line.id,
        initialFen: repertoire.rootFen,
        moves: line.moveIds.map((id) => {
          const move = repertoire.moves[id];
          return { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), san: move.san };
        }),
      })),
    };
    library = { studies: [{ id: study.id, name: study.name, chapters: [detail] }], sample: false };
    fixtureServer = http.createServer((request, response) => vite.middlewares(request, response));
    await new Promise((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${fixtureServer.address().port}`;

    async function scenario(name, check) {
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 1024,
        webPreferences: {
          partition: `annotation-smoke-${name}-${Date.now()}`,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
        },
      });
      window.webContents.setFrameRate(60);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (request, callback) => {
        callback({ cancel: new URL(request.url).origin !== origin });
      });
      window.webContents.on('console-message', (details) => {
        if (details.message.includes('Uncaught')) console.error(details.message);
      });
      await window.loadURL(origin);
      await waitFor(window, `document.querySelector('.chapter-button')`);
      await evaluate(window, `document.querySelector('.chapter-button').click()`);
      await waitFor(window, `document.querySelector('.feedback-note')?.textContent.includes('ROOT_MEMO')`);
      await check(window);
      console.log(`PASS ${name}`);
      window.destroy();
      window = undefined;
    }

    await scenario('current memo: direct two-click move + historical queue skip + terminal skip', async (win) => {
      await clickSquare(win, 'e2');
      await waitFor(win, `!document.querySelector('.feedback-note')`);
      await clickSquare(win, 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      assert.equal((await checkpoint(win)).ui.correctCount, 1);
      await clickSquare(win, 'g1');
      await waitFor(win, `!document.querySelector('.feedback-note')`);
      // One board interaction skips both historical e4 and queued e5 notes.
      assert.equal((await checkpoint(win)).ui.annotationMoments.length, 0);
      await clickSquare(win, 'f3');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('FINISHED_MEMO')`);
      assert.equal((await checkpoint(win)).ui.correctCount, 2);
      assert.equal((await checkpoint(win)).ui.wrongCount, 0);
      await clickSquare(win, 'e4');
      await waitFor(win, `document.querySelector('.completion-card')`);
      assert.match(await evaluate(win, `document.querySelector('.result-grid').textContent`), /0틀린 횟수/);
    });

    await scenario('current memo: direct drag scores the move', async (win) => {
      await dragSquare(win, 'e2', 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      const saved = await checkpoint(win);
      assert.equal(saved.ui.correctCount, 1);
      assert.equal(saved.ui.wrongCount, 0);
    });

    await scenario('current memo after opponent reply: direct drag scores', async (win) => {
      await clickSquare(win, 'e2');
      await clickSquare(win, 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      await evaluate(win, `document.querySelector('.study-note-button').click()`);
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('LIVE_MEMO')`);
      await dragSquare(win, 'g1', 'f3');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('FINISHED_MEMO')`);
      assert.equal((await checkpoint(win)).ui.correctCount, 2);
      assert.equal((await checkpoint(win)).ui.wrongCount, 0);
    });

    await scenario('current memo: a genuine wrong move still reveals correction', async (win) => {
      await dragSquare(win, 'd2', 'd4');
      await waitFor(win, `document.querySelector('.feedback-retry')`);
      const saved = await checkpoint(win);
      assert.equal(saved.ui.annotationMoments.length, 0);
      assert.equal(saved.ui.correctCount, 0);
      assert.equal(saved.ui.wrongCount, 1);
      assert.equal(saved.ui.revealed.uci, 'e2e4');
      assert.equal(saved.checkpoint.state.attempts.length, 1);
      await dragSquare(win, 'e2', 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      assert.equal((await checkpoint(win)).ui.correctCount, 1);
      assert.equal((await checkpoint(win)).ui.wrongCount, 1);
    });

    await scenario('historical memo: stale drag only skips; next live drag scores', async (win) => {
      await clickSquare(win, 'e2');
      await clickSquare(win, 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      const before = await checkpoint(win);
      await dragSquare(win, 'g1', 'f3');
      await waitFor(win, `!document.querySelector('.feedback-note')`);
      const after = await checkpoint(win);
      assert.equal(after.ui.annotationMoments.length, 0);
      assert.equal(after.ui.correctCount, 1, 'A drag from the historical board must not submit');
      assert.equal(after.ui.wrongCount, 0);
      assert.deepEqual(after.checkpoint.state.attempts, before.checkpoint.state.attempts);
      await dragSquare(win, 'g1', 'f3');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('FINISHED_MEMO')`);
      assert.equal((await checkpoint(win)).ui.correctCount, 2);
      assert.equal((await checkpoint(win)).ui.wrongCount, 0);
    });

    await scenario('dismissed notes stay dismissed after refresh/resume', async (win) => {
      await clickSquare(win, 'e2');
      await clickSquare(win, 'e4');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('HISTORIC_MEMO')`);
      await clickSquare(win, 'a3');
      await waitFor(win, `!document.querySelector('.feedback-note')`);
      assert.equal((await checkpoint(win)).ui.annotationMoments.length, 0);
      await win.loadURL(origin);
      await waitFor(win, `Array.from(document.querySelectorAll('button')).some((button) => button.textContent.includes('이어서 훈련'))`);
      await evaluate(win, `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('이어서 훈련')).click()`);
      await waitFor(win, `document.querySelector('.board-frame')`);
      assert.equal(await evaluate(win, `Boolean(document.querySelector('.feedback-note'))`), false);
      assert.equal((await checkpoint(win)).ui.correctCount, 1);
      assert.equal((await checkpoint(win)).ui.wrongCount, 0);
      await clickSquare(win, 'g1');
      await clickSquare(win, 'f3');
      await waitFor(win, `document.querySelector('.feedback-note')?.textContent.includes('FINISHED_MEMO')`);
    });
  } catch (error) {
    exitCode = 1;
    console.error(error);
    if (window && !window.isDestroyed()) {
      console.error(await evaluate(window, `document.body.innerText`).catch(() => 'Renderer unavailable'));
    }
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await vite?.close();
    app.exit(exitCode);
  }
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function evaluate(window, expression) { return window.webContents.executeJavaScript(expression); }

async function waitFor(window, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(window, `Boolean(${predicate})`)) return;
    await delay(40);
  }
  throw new Error(`Timed out waiting for: ${predicate}`);
}

function checkpoint(window) {
  return evaluate(window, `JSON.parse(localStorage.getItem('opening-room.training-checkpoint.v1')).activeSession`);
}

function squareCenter(window, square) {
  return evaluate(window, `(() => {
    const rectangle = document.querySelector('[data-square="${square}"]').getBoundingClientRect();
    return { x: Math.round(rectangle.x + rectangle.width / 2), y: Math.round(rectangle.y + rectangle.height / 2) };
  })()`);
}

async function clickSquare(window, square) {
  const point = await squareCenter(window, square);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  await delay(20);
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(50);
}

async function dragSquare(window, from, to) {
  // Finish any prior move animation before starting the next physical gesture.
  await delay(300);
  const start = await squareCenter(window, from);
  const target = await squareCenter(window, to);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...start });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
  await delay(40);
  for (let step = 1; step <= 8; step += 1) {
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(start.x + (target.x - start.x) * step / 8),
      y: Math.round(start.y + (target.y - start.y) * step / 8),
      modifiers: ['leftButtonDown'],
    });
    await delay(35);
  }
  await delay(300);
  window.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
  await delay(100);
}

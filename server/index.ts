import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { MemoryAuthStore } from './auth';
import { loadConfig } from './config';
import { LichessClient } from './lichess';
import { OpeningPracticeClient } from './opening-practice';
import { StudyStorage } from './storage';
import { StudySyncService } from './sync';

const config = loadConfig();
const auth = new MemoryAuthStore(config.oauthPendingTtlMs);
const lichess = new LichessClient(config);
const storage = new StudyStorage(config.dataDir, config.lichessUsername);
await storage.initialize();
const sync = new StudySyncService(auth, lichess, storage);
const openingPractice = new OpeningPracticeClient({ lichessBaseUrl: config.lichessBaseUrl });
const app = createApp({ config, auth, lichess, storage, sync, openingPractice });

if (config.production) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.join(projectRoot, 'dist');
  app.use(express.static(distDir));
  app.get(/^(?!\/api(?:\/|$)).*/u, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`Opening Trainer is running at ${config.origin}`);
  console.log('Lichess access is kept in memory; reconnect after restarting the server.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

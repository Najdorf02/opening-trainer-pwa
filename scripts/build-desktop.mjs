import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const outputDir = path.join(projectDir, 'dist-electron');
const appDir = path.join(outputDir, 'app');
const packageJson = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));

await rm(outputDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

await build({
  absWorkingDir: projectDir,
  entryPoints: ['desktop/main.ts'],
  outfile: path.join(appDir, 'main.cjs'),
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});

const desktopPackage = {
  name: 'opening-trainer-desktop',
  productName: 'Opening Trainer',
  version: packageJson.version,
  description: 'Lichess repertoire and opening practice desktop app',
  main: 'main.cjs',
  private: true,
};

await writeFile(
  path.join(appDir, 'package.json'),
  `${JSON.stringify(desktopPackage, null, 2)}\n`,
  'utf8',
);

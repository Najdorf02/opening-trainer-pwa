import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const pwa = mode === 'pwa' || env.VITE_PWA_MODE === 'true';
  const base = pwa ? (env.VITE_BASE_PATH || '/opening-trainer-pwa/') : '/';

  return {
    base,
    plugins: [
      react(),
      ...(pwa ? [VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        manifest: {
          id: base,
          name: 'Opening Room · 오프닝 훈련',
          short_name: 'Opening Room',
          description: 'Lichess 연구를 챕터별로 반복하는 개인 체스 오프닝 트레이너',
          lang: 'ko',
          start_url: base,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#f4f1e9',
          theme_color: '#101b2d',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,txt}'],
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          navigateFallback: 'index.html',
        },
      })] : []),
    ],
    server: {
      host: '127.0.0.1',
    },
  };
});

/**
 * Bundle ag-scan-worker thành dist/ag-scan-worker.cjs
 * sharp được để external vì dùng native addons.
 */
import { build } from 'esbuild';
import { resolve } from 'path';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/ag-scan-worker.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: [
    'sharp',
    'ffmpeg-static',
    'ffprobe-static',
    '@ag-farm/protocol',
    '@ag-farm/worker-sdk',
  ],
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

console.log('Bundle created: dist/ag-scan-worker.cjs');

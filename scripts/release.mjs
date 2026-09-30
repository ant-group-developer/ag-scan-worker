/**
 * Đóng gói ag-scan-worker thành một thư mục cài đặt tự chạy được trên máy worker (không cần clone
 * ag-farm, ag-studio bên cạnh):
 *
 *   release/ag-scan-worker-<version>/
 *     dist/worker.mjs        mọi JS, gồm cả @ag-farm/* (link: lúc dev)
 *     package.json           chỉ còn ffmpeg-static, ffprobe-static, sharp (native, cài lúc `npm install`)
 *     deploy/*               mẫu config.yaml, machine.yaml, script cài dịch vụ Windows
 *   release/ag-scan-worker-<version>.zip
 *
 * Chạy trên máy dev đã build được repo (ag-farm nằm cạnh): node scripts/release.mjs
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `ag-scan-worker-${pkg.version}`;
const out = join(root, 'release', name);

// Binary/native: không bundle được, cài bằng npm trên máy đích.
const NATIVE = ['ffmpeg-static', 'ffprobe-static', 'sharp'];

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(out, 'dist', 'worker.mjs'),
  external: NATIVE,
  // Thư viện CommonJS trong bundle ESM vẫn gọi require().
  banner: { js: "import { createRequire as __agCreateRequire } from 'node:module'; const require = __agCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      description: pkg.description,
      scripts: { start: 'node dist/worker.mjs --config config.yaml' },
      dependencies: Object.fromEntries(NATIVE.map((d) => [d, pkg.dependencies[d]])),
    },
    null,
    2,
  ) + '\n',
);

cpSync(join(root, 'deploy'), join(out, 'deploy'), { recursive: true });

// node_modules, runtime/node.exe, run.cmd, zip và (với --publish <dir>) phát hành lên farm: phần chung
// với worker kia, nằm ở ag-farm/tools/worker-installer.
const installer = join(root, '..', 'ag-farm', 'tools', 'worker-installer', 'package-release.mjs');
const { finishRelease, publishDirFromArgv } = await import(pathToFileURL(installer).href);
finishRelease({
  repoRoot: root,
  releaseRoot: join(root, 'release'),
  name,
  packageName: 'ag-scan-worker',
  version: pkg.version,
  publishDir: publishDirFromArgv(),
});

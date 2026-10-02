/**
 * Test scan.extract handler v2: fake sign server + S3, video lavfi.
 * Kiểm tra: manifest v2 hợp lệ, scenes/keyframes/technical, dedup dHash,
 * portrait keyframe có cạnh dài ở chiều cao.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handleScanExtract } from './scan-extract';
import { resolveFfmpeg, resolveFfprobe } from './ffmpeg-utils';
import type { JobContext } from '@ag-farm/worker-sdk';
import { ExtractManifestSchema } from '@ag-farm/protocol';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

// ---- Helpers ----

const TEST_BASE = join(tmpdir(), `ag-scan-extract-${process.pid}`);

async function createTestVideo(
  name: string,
  durationSec: number,
  extra?: { width?: number; height?: number },
): Promise<string> {
  const path = join(TEST_BASE, name);
  mkdirSync(TEST_BASE, { recursive: true });
  if (existsSync(path)) return path;

  const w = extra?.width ?? 320;
  const h = extra?.height ?? 240;
  const ffmpeg = resolveFfmpeg();
  await execFileAsync(ffmpeg, [
    '-y', '-f', 'lavfi',
    '-i', `testsrc2=size=${w}x${h}:rate=25`,
    '-t', String(durationSec),
    '-c:v', 'libx264', '-crf', '30', '-preset', 'ultrafast',
    path,
  ], { timeout: 120_000 });
  return path;
}

// ---- Fake S3 server ----

interface FakeS3 {
  server: Server;
  uploads: Map<string, Buffer>;
  url: string;
  close(): Promise<void>;
}

function createFakeS3(): Promise<FakeS3> {
  return new Promise((resolve) => {
    const uploads = new Map<string, Buffer>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const key = req.url ?? '/unknown';
        if (req.method === 'PUT') {
          uploads.set(key, body);
          res.writeHead(200, { ETag: '"fake-etag"' });
          res.end();
        } else {
          res.writeHead(405);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server, uploads,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Fake sign server ----

function createFakeSignServer(s3Url: string, sourceFilePath: string): Promise<{
  server: Server; url: string; close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            ops: Array<{ op: string; output?: string; input?: string }>;
          };
          const results = body.ops.map((op) => {
            if (op.op === 'get') {
              return {
                op: 'get', input: op.input ?? 'source',
                url: `file://${sourceFilePath}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                size_bytes: null, cache_key: null, content_type: null, source: null,
              };
            }
            if (op.op === 'put') {
              return {
                op: 'put', output: op.output ?? 'unknown',
                url: `${s3Url}/${op.output ?? 'file'}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                headers: { 'Content-Type': 'application/octet-stream' },
              };
            }
            if (op.op === 'mp_create') {
              return { op: 'mp_create', output: op.output ?? 'unknown', upload_id: 'fake-upload-id' };
            }
            return { op: op.op, output: op.output };
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results }));
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server, url: `http://127.0.0.1:${addr.port}/sign`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Fake JobContext ----

function buildFakeContext(
  workDir: string,
  signUrl: string,
  s3Url: string,
  sourceFilePath: string,
  payload: unknown,
  signal: AbortSignal,
): JobContext {
  const uploads = new Map<string, Buffer>();

  const ctx: JobContext = {
    job: {
      id: '123e4567-e89b-42d3-a456-426614174001',
      owner: 'ag-go',
      type: 'scan.extract',
      lane: 'batch',
      attempt: 1,
      payload,
      lease_token: 'lease-token-fake-0000000000000000',
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ticket: 'ticket-fake-placeholder-00000000000000',
      sign_url: signUrl,
    },
    payload,
    workDir,
    sign: null as unknown as JobContext['sign'],
    cache: null as unknown as JobContext['cache'],
    log: {
      info: (_msg: string, _meta?: object) => {},
      warn: (_msg: string, _meta?: object) => {},
      error: (_msg: string, _meta?: object) => {},
      debug: (_msg: string, _meta?: object) => {},
      child: () => ctx.log,
    },
    signal,
    progress: (_percent?: number, _stage?: string) => {},
    shouldYield: () => false,
    yieldToInteractive: async () => {},

    async download(inputName: string, dest: string) {
      if (inputName === 'source') {
        writeFileSync(dest, readFileSync(sourceFilePath));
      } else {
        writeFileSync(dest, Buffer.alloc(0));
      }
    },

    async upload(localPath: string, outputPath: string, _contentType: string) {
      const buf = readFileSync(localPath);
      uploads.set(outputPath, buf);
      const url = `${s3Url}/${outputPath}`;
      await fetch(url, { method: 'PUT', body: buf as unknown as import('node:stream').Readable });
    },

    async uploadJson(outputPath: string, data: unknown) {
      uploads.set(outputPath, Buffer.from(JSON.stringify(data, null, 2)));
    },
  };

  (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads = uploads;
  return ctx;
}

// ---- Tests ----

describe('handleScanExtract v2', () => {
  let s3: FakeS3;
  let signServer: Awaited<ReturnType<typeof createFakeSignServer>>;
  let videoPath: string;
  let portraitVideoPath: string;

  beforeAll(async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    videoPath = await createTestVideo('extract_test.mp4', 12);
    portraitVideoPath = await createTestVideo('portrait_test.mp4', 6, { width: 180, height: 320 });
    s3 = await createFakeS3();
    signServer = await createFakeSignServer(s3.url, videoPath);
  });

  afterAll(async () => {
    await s3.close();
    await signServer.close();
  });

  it('produces a valid v2 ExtractManifest for a 12s video', async () => {
    const workDir = join(TEST_BASE, 'work_extract_basic');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset: {
        id: '123e4567-e89b-42d3-a456-426614174002',
        kind: 'video',
        mime_type: 'video/mp4',
        size_bytes: null,
        checksum_sha256: null,
        duration_ms: 12_000,
        width: 320,
        height: 240,
      },
      params: {
        scene_threshold: 0.3,
        min_scene_s: 1,
        max_keyframes: 24,
        keyframe_dedup_distance: 8,
        keyframe_px: 160,
        proxy: { enabled: false, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
        speech_silence_ratio_max: 0.6,
      },
      extract_version: 'test-v2',
    };

    const ac = new AbortController();
    const ctx = buildFakeContext(workDir, signServer.url, s3.url, videoPath, payload, ac.signal);

    const result = await handleScanExtract(ctx);
    expect(result.manifest).toBe('extract.json');

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('extract.json');
    expect(manifestBuf).toBeDefined();

    const manifestData = JSON.parse(manifestBuf!.toString()) as unknown;
    const parsed = ExtractManifestSchema.safeParse(manifestData);
    if (!parsed.success) {
      console.error('Manifest validation failed:', parsed.error.message);
    }
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      const manifest = parsed.data;
      expect(manifest.schema).toBe('ag.scan.extract/v2');
      expect(manifest.asset_id).toBe(payload.asset.id);
      // v2: scenes array (not segments)
      expect(manifest.scenes.length).toBeGreaterThanOrEqual(1);
      // v2: keyframes at top level
      expect(manifest.keyframes.length).toBeGreaterThanOrEqual(1);
      expect(manifest.keyframes.length).toBeLessThanOrEqual(24);
      // v2: technical at top level
      expect(manifest.technical).toBeDefined();
      expect(manifest.technical.black_ratio).toBeGreaterThanOrEqual(0);
      expect(manifest.technical.black_ratio).toBeLessThanOrEqual(1);
      // keyframe dhash format
      manifest.keyframes.forEach((kf) => {
        expect(kf.dhash).toMatch(/^[0-9a-f]{16}$/);
        expect(kf.scene_index).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it('skips the proxy when the source is no larger than it (a clean 720p preview)', async () => {
    const workDir = join(TEST_BASE, 'work_extract_small_source');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset: {
        id: '123e4567-e89b-42d3-a456-426614174005',
        kind: 'video',
        mime_type: 'video/mp4',
        size_bytes: null,
        checksum_sha256: null,
        duration_ms: 12_000,
        width: 3840,
        height: 2160,
      },
      params: {
        scene_threshold: 0.3,
        min_scene_s: 1,
        max_keyframes: 24,
        keyframe_dedup_distance: 8,
        keyframe_px: 160,
        // Proxy bật nhưng nguồn 320×240 đã nhỏ hơn 720p
        proxy: { enabled: true, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
        speech_silence_ratio_max: 0.6,
      },
      extract_version: 'test-v2',
    };

    const ac = new AbortController();
    const ctx = buildFakeContext(workDir, signServer.url, s3.url, videoPath, payload, ac.signal);
    await handleScanExtract(ctx);

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    expect(uploads.has('proxy.mp4')).toBe(false);
    const manifest = ExtractManifestSchema.parse(JSON.parse(uploads.get('extract.json')!.toString()));
    expect(manifest.proxy).toBeNull();
    // Kích thước là của file đã quét; chủ sở hữu tự đổi về khung file gốc
    expect(manifest.media).toMatchObject({ width: 320, height: 240 });
    expect(manifest.keyframes.length).toBeGreaterThanOrEqual(1);
  });

  it('dedup reduces to 1 keyframe on a solid-color (fully-static) clip with max dedup distance', async () => {
    // Use a solid blue video. It has no scene cuts → 1 scene → 1 candidate keyframe.
    // With dedup_distance=64 (max possible), any two keyframes are considered duplicates,
    // so only the first one is kept. Result: exactly 1 keyframe.
    const solidPath = join(TEST_BASE, 'solid_blue.mp4');
    if (!existsSync(solidPath)) {
      const ffmpeg = resolveFfmpeg();
      await execFileAsync(ffmpeg, [
        '-y', '-f', 'lavfi',
        '-i', 'color=c=blue:size=320x240:rate=25',
        '-t', '5', '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        solidPath,
      ], { timeout: 30_000 });
    }

    const workDir = join(TEST_BASE, 'work_dedup');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset: {
        id: '123e4567-e89b-42d3-a456-426614174042',
        kind: 'video', mime_type: 'video/mp4',
        size_bytes: null, checksum_sha256: null,
        duration_ms: 5_000, width: 320, height: 240,
      },
      params: {
        scene_threshold: 0.01, // low threshold – solid video will still have 0 cuts
        min_scene_s: 0,
        max_keyframes: 24,
        keyframe_dedup_distance: 64, // max: any two frames are "same"
        keyframe_px: 160,
        proxy: { enabled: false, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 80 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
        speech_silence_ratio_max: 0.6,
      },
      extract_version: 'test-v2',
    };

    const ac = new AbortController();
    const signServerForBlue = await createFakeSignServer(s3.url, solidPath);
    try {
      const ctx = buildFakeContext(workDir, signServerForBlue.url, s3.url, solidPath, payload, ac.signal);
      await handleScanExtract(ctx);
      const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
      const manifestBuf = uploads.get('extract.json');
      const manifest = ExtractManifestSchema.parse(JSON.parse(manifestBuf!.toString()));
      // solid video: 0 cuts → 1 scene → 1 candidate keyframe → after dedup still 1
      expect(manifest.keyframes).toHaveLength(1);
    } finally {
      await signServerForBlue.close();
    }
  });

  it('portrait video: keyframe height >= width (long edge on height)', async () => {
    const workDir = join(TEST_BASE, 'work_portrait');
    mkdirSync(workDir, { recursive: true });

    const signServerForPortrait = await createFakeSignServer(s3.url, portraitVideoPath);
    const payload = {
      asset: {
        id: '123e4567-e89b-42d3-a456-426614174043',
        kind: 'video', mime_type: 'video/mp4',
        size_bytes: null, checksum_sha256: null,
        duration_ms: 6_000, width: 180, height: 320,
      },
      params: {
        scene_threshold: 0.3, min_scene_s: 1, max_keyframes: 24,
        keyframe_dedup_distance: 8, keyframe_px: 160,
        proxy: { enabled: false, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
        speech_silence_ratio_max: 0.6,
      },
      extract_version: 'test-v2',
    };

    try {
      const ac = new AbortController();
      const ctx = buildFakeContext(workDir, signServerForPortrait.url, s3.url, portraitVideoPath, payload, ac.signal);
      await handleScanExtract(ctx);
      const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
      const manifest = ExtractManifestSchema.parse(
        JSON.parse(uploads.get('extract.json')!.toString()),
      );
      // Portrait: all keyframes should have height >= width (long edge on height)
      manifest.keyframes.forEach((kf) => {
        expect(kf.height).toBeGreaterThanOrEqual(kf.width);
      });
      expect(manifest.orientation).toBe('portrait');
    } finally {
      await signServerForPortrait.close();
    }
  });

  it('still image: one scene 0-0, one keyframe, no proxy', async () => {
    const imagePath = join(TEST_BASE, 'still_test.png');
    if (!existsSync(imagePath)) {
      const ffmpeg = resolveFfmpeg();
      await execFileAsync(ffmpeg, [
        '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x480',
        '-frames:v', '1', imagePath,
      ], { timeout: 30_000 });
    }

    const workDir = join(TEST_BASE, 'work_still');
    mkdirSync(workDir, { recursive: true });
    const signServerForImage = await createFakeSignServer(s3.url, imagePath);
    const payload = {
      asset: {
        id: '123e4567-e89b-42d3-a456-426614174044',
        kind: 'image', mime_type: 'image/png',
        size_bytes: null, checksum_sha256: null,
        duration_ms: null, width: null, height: null,
      },
      params: {
        scene_threshold: 0.3, min_scene_s: 1, max_keyframes: 24,
        keyframe_dedup_distance: 8, keyframe_px: 160,
        proxy: { enabled: false, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
        speech_silence_ratio_max: 0.6,
      },
      extract_version: 'test-v2',
    };

    try {
      const ac = new AbortController();
      const ctx = buildFakeContext(workDir, signServerForImage.url, s3.url, imagePath, payload, ac.signal);
      await handleScanExtract(ctx);
      const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
      const manifest = ExtractManifestSchema.parse(
        JSON.parse(uploads.get('extract.json')!.toString()),
      );
      expect(manifest.media.kind).toBe('image');
      expect(manifest.proxy).toBeNull();
      expect(manifest.scenes).toHaveLength(1);
      expect(manifest.scenes[0]).toMatchObject({ start_ms: 0, end_ms: 0 });
      expect(manifest.keyframes).toHaveLength(1);
      expect(manifest.keyframes[0]!.t_ms).toBe(0);
    } finally {
      await signServerForImage.close();
    }
  });
});

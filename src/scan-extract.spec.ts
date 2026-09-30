/**
 * Test scan.extract handler: fake sign server + S3, tạo video lavfi.
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
import type { ExtractManifest } from '@ag-farm/protocol';
import { ExtractManifestSchema } from '@ag-farm/protocol';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

// ---- Helpers ----

const TEST_BASE = join(tmpdir(), `ag-scan-extract-${process.pid}`);

async function createTestVideo(name: string, durationSec: number): Promise<string> {
  const path = join(TEST_BASE, name);
  mkdirSync(TEST_BASE, { recursive: true });
  if (existsSync(path)) return path;

  const ffmpeg = resolveFfmpeg();
  await execFileAsync(ffmpeg, [
    '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=25',
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
        server,
        uploads,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Fake sign server ----

function createFakeSignServer(s3Url: string, sourceFilePath: string): Promise<{
  server: Server;
  url: string;
  close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { ops: Array<{ op: string; output?: string; input?: string }> };
          const results = body.ops.map((op) => {
            if (op.op === 'get') {
              return {
                op: 'get',
                input: op.input ?? 'source',
                url: `file://${sourceFilePath}`,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                size_bytes: null,
                cache_key: null,
                content_type: null,
                source: null,
              };
            }
            if (op.op === 'put') {
              return {
                op: 'put',
                output: op.output ?? 'unknown',
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
        server,
        url: `http://127.0.0.1:${addr.port}/sign`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Build fake JobContext ----

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
      // For 'source', copy the test video
      if (inputName === 'source') {
        const buf = readFileSync(sourceFilePath);
        writeFileSync(dest, buf);
      } else {
        // Download from file:// URL or s3
        writeFileSync(dest, Buffer.alloc(0));
      }
    },

    async upload(localPath: string, outputPath: string, _contentType: string) {
      const buf = readFileSync(localPath);
      uploads.set(outputPath, buf);
      // Also PUT to fake S3
      const url = `${s3Url}/${outputPath}`;
      await fetch(url, { method: 'PUT', body: buf as unknown as import('node:stream').Readable });
    },

    async uploadJson(outputPath: string, data: unknown) {
      const buf = Buffer.from(JSON.stringify(data, null, 2));
      uploads.set(outputPath, buf);
    },
  };

  (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads = uploads;
  return ctx;
}

// ---- Tests ----

describe('handleScanExtract', () => {
  let s3: FakeS3;
  let signServer: Awaited<ReturnType<typeof createFakeSignServer>>;
  let videoPath: string;

  beforeAll(async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    videoPath = await createTestVideo('extract_test.mp4', 12);
    s3 = await createFakeS3();
    signServer = await createFakeSignServer(s3.url, videoPath);
  });

  afterAll(async () => {
    await s3.close();
    await signServer.close();
  });

  it('produces a valid ExtractManifest for a 12s video', async () => {
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
        window_s: 4,
        max_segment_s: 20,
        min_segment_s: 1.5,
        merge_dhash_max_distance: 10,
        scene_threshold: 0.3,
        keyframes_per_segment: 1,
        keyframe_px: 160,
        proxy: { enabled: false, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
      },
      extract_version: 'test-v1',
    };

    const ac = new AbortController();
    const ctx = buildFakeContext(workDir, signServer.url, s3.url, videoPath, payload, ac.signal);

    const result = await handleScanExtract(ctx);
    expect(result.manifest).toBe('extract.json');

    // Check uploadJson was called and manifest is valid
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
      expect(manifest.schema).toBe('ag.scan.extract/v1');
      expect(manifest.asset_id).toBe(payload.asset.id);
      expect(manifest.segments.length).toBeGreaterThanOrEqual(1);
      manifest.segments.forEach((seg) => {
        expect(seg.keyframes.length).toBeGreaterThanOrEqual(1);
        expect(seg.keyframes[0]!.dhash).toMatch(/^[0-9a-f]{16}$/);
      });
    }
  });
});

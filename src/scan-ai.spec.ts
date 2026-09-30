/**
 * Test scan.ai handler: fake Ollama server.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { handleScanAi } from './scan-ai';
import type { JobContext } from '@ag-farm/worker-sdk';
import type { AiManifest } from '@ag-farm/protocol';
import { AiManifestSchema } from '@ag-farm/protocol';

jest.setTimeout(60_000);

// ---- Fixtures ----

const TEST_BASE = join(tmpdir(), `ag-scan-ai-${process.pid}`);

async function createTestKeyframe(dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  // Tạo ảnh test 64×64 xanh lá
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 128, b: 0 } },
  }).jpeg().toFile(path);
  return path;
}

// ---- Fake Ollama server ----

interface FakeOllamaOptions {
  responses: Array<string | null>; // null = HTTP 500
  port?: number;
}

function createFakeOllama(options: FakeOllamaOptions): Promise<{
  server: Server;
  url: string;
  callCount: number;
  /** base64 keyframes of the last accepted request */
  lastImages: string[];
  close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    let callIdx = 0;
    let lastImages: string[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== '/api/chat') {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        // Like the real Ollama: every message's content is a string, pictures are base64 strings in
        // `images` (an array content, OpenAI style, is answered with HTTP 400).
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ content?: unknown; images?: unknown }>;
        };
        const bad = (body.messages ?? []).find(
          (m) =>
            typeof m.content !== 'string' ||
            (m.images !== undefined &&
              !(Array.isArray(m.images) && m.images.every((i) => typeof i === 'string' && !i.startsWith('data:')))),
        );
        if (bad || !body.messages?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'json: cannot unmarshal array into Go struct field .ChatRequest.messages.content of type string' }));
          return;
        }
        lastImages = body.messages.flatMap((m) => (Array.isArray(m.images) ? (m.images as string[]) : []));
        const responseText = options.responses[callIdx] ?? null;
        callIdx++;

        if (responseText === null) {
          res.writeHead(500);
          res.end('Internal error');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: responseText } }));
      });
    });

    const port = options.port ?? 0;
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        get callCount() { return callIdx; },
        get lastImages() { return lastImages; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Fake JobContext ----

function buildFakeAiContext(
  workDir: string,
  ollamaUrl: string,
  keyframeDir: string,
  payload: unknown,
  signal: AbortSignal,
): JobContext {
  const uploads = new Map<string, Buffer>();

  const ctx: JobContext & { ollamaUrl?: string } = {
    ollamaUrl,
    job: {
      id: '123e4567-e89b-42d3-a456-426614174003',
      owner: 'ag-go',
      type: 'scan.ai',
      lane: 'batch',
      attempt: 1,
      payload,
      lease_token: 'lease-token-fake-scan-ai-00000000',
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ticket: 'ticket-fake-ai-placeholder-00000000000000',
      sign_url: 'http://127.0.0.1:9/sign',
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
    progress: (_percent: number, _stage?: string) => {},

    async download(inputName: string, dest: string) {
      // inputName like 'artifact:keyframes/0001-1.jpg'
      const kfName = inputName.includes(':') ? inputName.split(':')[1]! : inputName;
      const filename = kfName.split('/').pop() ?? kfName;
      const src = join(keyframeDir, filename);
      // Use kf0.jpg as fallback for any keyframe
      const fallback = join(keyframeDir, 'kf0.jpg');
      const usePath = require('node:fs').existsSync(src) ? src : fallback;
      writeFileSync(dest, readFileSync(usePath));
    },

    async upload(_localPath: string, outputPath: string, _contentType: string) {
      const buf = readFileSync(_localPath);
      uploads.set(outputPath, buf);
    },

    async uploadJson(outputPath: string, data: unknown) {
      uploads.set(outputPath, Buffer.from(JSON.stringify(data)));
    },
  };

  (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads = uploads;
  return ctx;
}

// ---- Valid Ollama response ----

const VALID_DESCRIPTION = JSON.stringify({
  caption_vi: 'Đây là một đoạn video thử nghiệm hiển thị cảnh ngoài trời',
  caption_en: 'This is a test video segment showing an outdoor scene',
  tags: ['test', 'outdoor', 'landscape'],
  keywords_vi: ['thử nghiệm', 'cảnh quan'],
  subjects: ['landscape'],
  actions: ['showing'],
  shot_size: 'wide',
  camera_motion: 'static',
  time_of_day: 'day',
  setting: 'outdoor',
  people_count: 'none',
  visible_text: '',
  has_watermark: false,
  usable: true,
  usable_reason: 'Good quality footage',
  quality: 4,
});

// ---- Tests ----

describe('handleScanAi', () => {
  let kfDir: string;
  let kf0: string;

  beforeAll(async () => {
    kfDir = join(TEST_BASE, 'keyframes');
    mkdirSync(kfDir, { recursive: true });
    kf0 = await createTestKeyframe(kfDir, 'kf0.jpg');
  });

  it('produces valid AiManifest when Ollama returns valid JSON', async () => {
    const ollama = await createFakeOllama({ responses: [VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_ai_valid');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset_id: '123e4567-e89b-42d3-a456-426614174004',
      chunk: 0,
      model: 'qwen2.5vl:7b',
      prompt_version: 'v1',
      context: { project_names: [], category_names: [], province_names: [] },
      segments: [
        {
          segment_id: '123e4567-e89b-42d3-a456-426614174005',
          index: 0,
          start_ms: 0,
          end_ms: 5000,
          keyframes: ['artifact:keyframes/kf0.jpg'],
        },
      ],
      options: { keep_alive: '2m', repair_attempts: 1 },
    };

    const ac = new AbortController();
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, ac.signal);

    const result = await handleScanAi(ctx);
    await ollama.close();

    expect(result.manifest).toBe('ai-0000.json');
    // the keyframe went to Ollama as a bare base64 image, the way /api/chat takes it
    expect(ollama.lastImages).toHaveLength(1);
    expect(Buffer.from(ollama.lastImages[0]!, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('ai-0000.json');
    expect(manifestBuf).toBeDefined();

    const manifestData = JSON.parse(manifestBuf!.toString()) as unknown;
    const parsed = AiManifestSchema.safeParse(manifestData);
    if (!parsed.success) console.error('AiManifest invalid:', parsed.error.message);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(1);
      expect(parsed.data.items[0]!.description).not.toBeNull();
      expect(parsed.data.items[0]!.error).toBeNull();
    }
  });

  it('repairs invalid JSON on second attempt', async () => {
    // First response: invalid JSON; second: valid
    const ollama = await createFakeOllama({
      responses: ['not-json-at-all', VALID_DESCRIPTION],
    });
    const workDir = join(TEST_BASE, 'work_ai_repair');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset_id: '123e4567-e89b-42d3-a456-426614174006',
      chunk: 1,
      model: 'qwen2.5vl:7b',
      prompt_version: 'v1',
      context: { project_names: [], category_names: [], province_names: [] },
      segments: [
        {
          segment_id: '123e4567-e89b-42d3-a456-426614174007',
          index: 0,
          start_ms: 0,
          end_ms: 5000,
          keyframes: ['artifact:keyframes/kf0.jpg'],
        },
      ],
      options: { keep_alive: '2m', repair_attempts: 1 },
    };

    const ac = new AbortController();
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, ac.signal);

    await handleScanAi(ctx);
    await ollama.close();

    expect(ollama.callCount).toBe(2); // called twice (initial + repair)

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('ai-0001.json');
    expect(manifestBuf).toBeDefined();

    const manifestData = JSON.parse(manifestBuf!.toString()) as unknown;
    const parsed = AiManifestSchema.safeParse(manifestData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Should succeed on second attempt
      expect(parsed.data.items[0]!.description).not.toBeNull();
    }
  });

  it('records error when all repair attempts fail', async () => {
    // All responses: invalid JSON
    const ollama = await createFakeOllama({
      responses: ['invalid1', 'invalid2', 'invalid3'],
    });
    const workDir = join(TEST_BASE, 'work_ai_fail');
    mkdirSync(workDir, { recursive: true });

    const payload = {
      asset_id: '123e4567-e89b-42d3-a456-426614174008',
      chunk: 2,
      model: 'qwen2.5vl:7b',
      prompt_version: 'v1',
      context: { project_names: [], category_names: [], province_names: [] },
      segments: [
        {
          segment_id: '123e4567-e89b-42d3-a456-426614174009',
          index: 0,
          start_ms: 0,
          end_ms: 5000,
          keyframes: ['artifact:keyframes/kf0.jpg'],
        },
      ],
      options: { keep_alive: '2m', repair_attempts: 1 },
    };

    const ac = new AbortController();
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, ac.signal);

    const result = await handleScanAi(ctx);
    await ollama.close();

    expect(result.manifest).toBe('ai-0002.json');

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('ai-0002.json');
    const manifestData = JSON.parse(manifestBuf!.toString()) as unknown;
    const parsed = AiManifestSchema.safeParse(manifestData);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items[0]!.description).toBeNull();
      expect(parsed.data.items[0]!.error).not.toBeNull();
    }
  });
});

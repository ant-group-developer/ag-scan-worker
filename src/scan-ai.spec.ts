/**
 * Test scan.ai handler v2: hai bước (notes + summary), fake Ollama server.
 * Kiểm tra: số lần gọi = ceil(frames/frames_per_note)+1, ảnh gửi, repair JSON,
 * error → ném lỗi sau khi viết manifest, yield trước mỗi lần gọi Ollama.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { cleanDescription, createScanAiHandler, descriptionProblems, handleScanAi, TITLE_MAX_CHARS } from './scan-ai';
import type { JobContext } from '@ag-farm/worker-sdk';
import { AiManifestSchema } from '@ag-farm/protocol';

jest.setTimeout(60_000);

// ---- Fixtures ----

const TEST_BASE = join(tmpdir(), `ag-scan-ai-v2-${process.pid}`);

async function createTestKeyframe(dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 128, b: 0 } },
  }).jpeg().toFile(path);
  return path;
}

// ---- Fake Ollama server ----

interface FakeOllamaOptions {
  responses: Array<string | null>; // null = HTTP 500
}

function createFakeOllama(options: FakeOllamaOptions): Promise<{
  server: Server;
  url: string;
  callCount: number;
  lastImages: string[];
  allCallImages: string[][];
  close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    let callIdx = 0;
    let lastImages: string[] = [];
    const allCallImages: string[][] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ content?: unknown; images?: unknown }>;
        };
        // Validate Ollama format: content must be string, images must be bare base64
        const bad = (body.messages ?? []).find(
          (m) =>
            typeof m.content !== 'string' ||
            (m.images !== undefined &&
              !(Array.isArray(m.images) &&
                m.images.every((i) => typeof i === 'string' && !i.startsWith('data:')))),
        );
        if (bad || !body.messages?.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad message format' }));
          return;
        }
        const imgs = body.messages.flatMap((m) =>
          Array.isArray(m.images) ? (m.images as string[]) : [],
        );
        lastImages = imgs;
        allCallImages.push(imgs);

        const responseText = options.responses[callIdx] ?? null;
        callIdx++;

        if (responseText === null) { res.writeHead(500); res.end('Internal error'); return; }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { content: responseText } }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        get callCount() { return callIdx; },
        get lastImages() { return lastImages; },
        get allCallImages() { return allCallImages; },
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
      id: '123e4567-e89b-42d3-a456-426614174010',
      owner: 'ag-go',
      type: 'scan.ai',
      lane: 'batch',
      attempt: 1,
      payload,
      lease_token: 'lease-token-fake-scan-ai-v2',
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ticket: 'ticket-fake-ai-v2-00000000000000',
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
    progress: (_percent?: number, _stage?: string) => {},
    shouldYield: () => false,
    yieldToInteractive: async () => {},

    async download(inputName: string, dest: string) {
      const kfName = inputName.includes(':') ? inputName.split(':')[1]! : inputName;
      const filename = kfName.split('/').pop() ?? kfName;
      const src = join(keyframeDir, filename);
      const fallback = join(keyframeDir, 'kf0.jpg');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const usePath = require('node:fs').existsSync(src) ? src : fallback;
      writeFileSync(dest, readFileSync(usePath));
    },

    async upload(localPath: string, outputPath: string) {
      uploads.set(outputPath, readFileSync(localPath));
    },

    async uploadJson(outputPath: string, data: unknown) {
      uploads.set(outputPath, Buffer.from(JSON.stringify(data)));
    },
  };

  (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads = uploads;
  return ctx;
}

// ---- Valid Ollama responses ----

const VALID_NOTE = 'Cảnh quay ngoài trời, có cây xanh và người đi lại.';

const VALID_DESCRIPTION = JSON.stringify({
  title_vi: 'Video thử nghiệm ngoài trời',
  summary_vi: 'Video ngắn quay cảnh ngoài trời với cây xanh và người đi lại.',
  summary_en: 'Short outdoor video with trees and people walking around.',
  genre: 'phong cảnh',
  topics: ['ngoài trời'],
  subjects: ['cây', 'người'],
  places: ['công viên'],
  actions: ['đi lại'],
  keywords_vi: ['ngoài trời', 'cây xanh'],
  tags: ['outdoor', 'nature'],
  mood: 'yên bình',
  setting: 'outdoor',
  time_of_day: 'day',
  people_count: 'few',
  shot_variety: ['wide'],
  camera_motions: ['static'],
  visible_text: '',
  has_watermark: false,
  usable: true,
  usable_reason: 'Chất lượng tốt',
  quality: 4,
});

// ---- Payload builder ----

function makePayload(keyframeCount: number, framesPerNote = 4, repairAttempts = 1): object {
  const keyframes = Array.from({ length: keyframeCount }, (_, i) => ({
    input: `artifact:keyframes/kf${i}.jpg`,
    t_ms: i * 1000,
  }));
  return {
    asset_id: '123e4567-e89b-42d3-a456-426614174020',
    model: 'qwen2.5vl:7b',
    prompt_version: 'v2',
    context: {
      asset_name: 'test.mp4',
      project_names: ['project-a'],
      category_names: [],
      province_names: ['Hà Nội'],
    },
    media: { duration_ms: keyframeCount * 1000, has_audio: false, has_speech_hint: null },
    keyframes,
    options: { keep_alive: '2m', repair_attempts: repairAttempts, frames_per_note: framesPerNote },
  };
}

// ---- Tests ----

describe('handleScanAi v2', () => {
  let kfDir: string;

  beforeAll(async () => {
    kfDir = join(TEST_BASE, 'keyframes');
    mkdirSync(kfDir, { recursive: true });
    // Create several test keyframes
    for (let i = 0; i < 8; i++) {
      await createTestKeyframe(kfDir, `kf${i}.jpg`);
    }
  });

  it('two-step: calls Ollama ceil(frames/frames_per_note)+1 times', async () => {
    // 8 frames, frames_per_note=4 → 2 note calls + 1 summary call = 3 total
    const noteResponses = [VALID_NOTE, VALID_NOTE]; // 2 note groups
    const summaryResponse = VALID_DESCRIPTION;
    const ollama = await createFakeOllama({ responses: [...noteResponses, summaryResponse] });
    const workDir = join(TEST_BASE, 'work_two_step');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(8, 4, 1);
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();

    // ceil(8/4) + 1 = 3
    expect(ollama.callCount).toBe(3);
  });

  it('sends images in note calls', async () => {
    // 4 frames, frames_per_note=4 → 1 note call (with 4 images) + 1 summary call
    const ollama = await createFakeOllama({ responses: [VALID_NOTE, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_images');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 4, 1);
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();

    // First call (notes): should have 4 images
    const firstCallImages = ollama.allCallImages[0] ?? [];
    expect(firstCallImages.length).toBeGreaterThanOrEqual(1);
    // Images should be bare base64 (no data: prefix)
    firstCallImages.forEach((img) => {
      expect(img.startsWith('data:')).toBe(false);
      // Verify it's valid base64 (JPEG magic bytes)
      const buf = Buffer.from(img, 'base64');
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0xd8);
    });
  });

  it('writes valid AiManifest v2 on success', async () => {
    // 4 frames, frames_per_note=4
    const ollama = await createFakeOllama({ responses: [VALID_NOTE, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_manifest');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 4, 1);
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('ai.json');
    expect(manifestBuf).toBeDefined();

    const parsed = AiManifestSchema.safeParse(JSON.parse(manifestBuf!.toString()));
    if (!parsed.success) console.error('AiManifest invalid:', parsed.error.message);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.schema).toBe('ag.scan.ai/v2');
      expect(parsed.data.description).not.toBeNull();
      expect(parsed.data.notes.length).toBeGreaterThanOrEqual(1);
      expect(parsed.data.error).toBeNull();
    }
  });

  it('repairs invalid JSON on second summary attempt', async () => {
    // note OK, summary bad → repair → summary good
    const ollama = await createFakeOllama({
      responses: [VALID_NOTE, 'not-json-at-all', VALID_DESCRIPTION],
    });
    const workDir = join(TEST_BASE, 'work_repair');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 4, 1); // repair_attempts=1
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();

    // 1 note call + 2 summary calls (initial + repair) = 3
    expect(ollama.callCount).toBe(3);

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifest = AiManifestSchema.parse(JSON.parse(uploads.get('ai.json')!.toString()));
    expect(manifest.description).not.toBeNull();
  });

  it('asks again when the description slips into Chinese or uses a sentence as the title', async () => {
    const mixed = JSON.stringify({
      ...JSON.parse(VALID_DESCRIPTION),
      title_vi: 'Một người phụ nữ mặc áo vàng đứng giữa hai đứa trẻ ngồi trên nền gạch trong khi đó một幼',
      summary_vi: 'Trẻ em uống nước从 bình.',
    });
    const ollama = await createFakeOllama({ responses: [VALID_NOTE, mixed, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_lang');
    mkdirSync(workDir, { recursive: true });
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, makePayload(4, 4, 1), new AbortController().signal);
    await handleScanAi(ctx);
    await ollama.close();
    expect(ollama.callCount).toBe(3);
    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifest = AiManifestSchema.parse(JSON.parse(uploads.get('ai.json')!.toString()));
    expect(manifest.description?.title_vi).toBe('Video thử nghiệm ngoài trời');
  });

  it('keeps a cleaned description when the repair round still has foreign characters', () => {
    const d = { ...JSON.parse(VALID_DESCRIPTION), title_vi: 'Công viên 公园 buổi chiều', tags: ['công viên', '公园'] };
    expect(descriptionProblems(d)).toEqual(['title_vi có chữ không phải tiếng Việt', 'tags[1] có chữ không phải tiếng Việt']);
    const clean = cleanDescription(d);
    expect(clean.title_vi).toBe('Công viên buổi chiều');
    expect(clean.tags).toEqual(['công viên']);
    expect(descriptionProblems(clean)).toEqual([]);
    const long = cleanDescription({ ...d, title_vi: 'Cảnh '.repeat(40).trim() });
    expect(long.title_vi.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(long.title_vi.endsWith(' ')).toBe(false);
  });

  it('throws retryable error and writes ai.json with description=null when all attempts fail', async () => {
    // note OK, all summary calls return bad JSON
    const ollama = await createFakeOllama({
      responses: [VALID_NOTE, 'bad-json', 'also-bad-json'],
    });
    const workDir = join(TEST_BASE, 'work_fail');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 4, 1); // repair_attempts=1
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    // Should throw (retryable error = plain Error, not NonRetryableError)
    await expect(handleScanAi(ctx)).rejects.toThrow();
    await ollama.close();

    // But ai.json should still be written
    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifestBuf = uploads.get('ai.json');
    expect(manifestBuf).toBeDefined();

    const manifest = AiManifestSchema.parse(JSON.parse(manifestBuf!.toString()));
    expect(manifest.description).toBeNull();
    expect(manifest.error).not.toBeNull();
  });

  it('fails (retryable) without a summary call when every notes group fails', async () => {
    // 8 frames, 4 per note → 2 note calls, both HTTP 500; the summary must not be asked to invent a description
    const ollama = await createFakeOllama({ responses: [null, null, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_notes_fail');
    mkdirSync(workDir, { recursive: true });
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, makePayload(8, 4, 1), new AbortController().signal);

    await expect(handleScanAi(ctx)).rejects.toThrow(/every notes call failed \(2 group/);
    await ollama.close();
    expect(ollama.callCount).toBe(2);

    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifest = AiManifestSchema.parse(JSON.parse(uploads.get('ai.json')!.toString()));
    expect(manifest.description).toBeNull();
    expect(manifest.error).toMatch(/every notes call failed/);
  });

  it('still describes the video when only some notes groups fail', async () => {
    const ollama = await createFakeOllama({ responses: [null, VALID_NOTE, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_notes_partial');
    mkdirSync(workDir, { recursive: true });
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, makePayload(8, 4, 1), new AbortController().signal);

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();
    const uploads = (ctx as unknown as { _uploads: Map<string, Buffer> })._uploads;
    const manifest = AiManifestSchema.parse(JSON.parse(uploads.get('ai.json')!.toString()));
    expect(manifest.description).not.toBeNull();
    expect(manifest.notes[0]).toMatch(/không đọc được/);
  });

  it('fails (retryable) when no keyframe can be downloaded', async () => {
    const ollama = await createFakeOllama({ responses: [VALID_NOTE, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_no_frames');
    mkdirSync(workDir, { recursive: true });
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, makePayload(4, 4, 1), new AbortController().signal);
    ctx.download = async () => { throw new Error('sign failed'); };

    await expect(handleScanAi(ctx)).rejects.toThrow(/none of the 4 keyframe/);
    await ollama.close();
    expect(ollama.callCount).toBe(0);
  });

  it('yields before each Ollama call', async () => {
    // 4 frames, frames_per_note=2 → 2 note calls + 1 summary = 3 Ollama calls
    // Each Ollama call is preceded by yieldToInteractive
    const ollama = await createFakeOllama({
      responses: [VALID_NOTE, VALID_NOTE, VALID_DESCRIPTION],
    });
    const workDir = join(TEST_BASE, 'work_yield');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 2, 0); // 4 frames, 2 per note → 2 note groups
    const ctx = buildFakeAiContext(workDir, ollama.url, kfDir, payload, new AbortController().signal);

    let yields = 0;
    ctx.yieldToInteractive = async () => { yields++; };

    await expect(handleScanAi(ctx)).resolves.toBeDefined();
    await ollama.close();

    // At minimum: yield before each note group call (2) + yield before summary (1)
    // Plus additional yields in the summary repair loop if any
    // Expected: at least 3 yields (one per Ollama call)
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it('uses ollamaUrl from createScanAiHandler factory', async () => {
    const ollama = await createFakeOllama({ responses: [VALID_NOTE, VALID_DESCRIPTION] });
    const workDir = join(TEST_BASE, 'work_factory');
    mkdirSync(workDir, { recursive: true });

    const payload = makePayload(4, 4, 0);
    // ctx.ollamaUrl points to a dead port; factory should use the correct URL
    const ctx = buildFakeAiContext(workDir, 'http://127.0.0.1:1', kfDir, payload, new AbortController().signal);

    await expect(createScanAiHandler({ ollamaUrl: ollama.url })(ctx)).resolves.toBeDefined();
    await ollama.close();

    expect(ollama.callCount).toBeGreaterThanOrEqual(2); // at least note + summary
  });
});

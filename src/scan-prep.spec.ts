/**
 * Test handler scan.prep với ffmpeg thật trên video lavfi: cảnh dựng theo luật Studio (gộp cảnh < 1 s, chia cảnh
 * > 20 s), khung giữa cảnh 480 px, tờ 4 cột, audio.wav 16 kHz mono, prep.json hợp lệ.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ScanPrepManifestSchema } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { createScanPrepHandler, decodeTimeoutMs } from './scan-prep';
import { resolveFfmpeg } from './ffmpeg-utils';

const execFileAsync = promisify(execFile);

jest.setTimeout(300_000);

const TEST_BASE = join(tmpdir(), `ag-scan-prep-${process.pid}`);

/**
 * Đỏ 3 s → xanh 4 s → lục 0,6 s → testsrc2 25 s: cắt ở 3; 7; 7,6. Cảnh lục (< 1 s) gộp vào cảnh trước, cảnh cuối
 * (25 s > 20 s) chia đôi.
 */
async function createVideo(name: string, withAudio: boolean): Promise<string> {
  mkdirSync(TEST_BASE, { recursive: true });
  const path = join(TEST_BASE, name);
  if (existsSync(path)) return path;
  const video =
    'color=c=red:s=320x240:r=25:d=3[a];color=c=blue:s=320x240:r=25:d=4[b];color=c=green:s=320x240:r=25:d=0.6[c];' +
    'testsrc2=s=320x240:r=25:d=25[d];[a][b][c][d]concat=n=4:v=1:a=0';
  await execFileAsync(resolveFfmpeg(), [
    '-y', '-f', 'lavfi', '-i', video,
    ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=32.6', '-c:a', 'aac', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    path,
  ], { timeout: 120_000 });
  return path;
}

interface FakeCtx extends JobContext {
  uploads: Map<string, { localPath: string; contentType: string }>;
  json: Map<string, unknown>;
  stages: string[];
}

function fakeContext(sourcePath: string, payload: unknown): FakeCtx {
  const workDir = mkdtempSync(join(TEST_BASE, 'job-'));
  const keep = mkdtempSync(join(TEST_BASE, 'uploaded-'));
  const uploads = new Map<string, { localPath: string; contentType: string }>();
  const json = new Map<string, unknown>();
  const stages: string[] = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  const ctx = {
    job: {
      id: randomUUID(), owner: 'ag-go', type: 'scan.prep', lane: 'batch', attempt: 1, payload,
      lease_token: 'lease-token-fake-0000000000000000', lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ticket: 'ticket-fake', sign_url: 'http://127.0.0.1:1/sign',
    },
    payload,
    workDir,
    sign: null as unknown as JobContext['sign'],
    cache: null as unknown as JobContext['cache'],
    log,
    signal: new AbortController().signal,
    progress: (_percent?: number, stage?: string) => {
      if (stage && stages[stages.length - 1] !== stage) stages.push(stage);
    },
    shouldYield: () => false,
    yieldToInteractive: async () => {},
    async download(inputName: string, dest: string) {
      if (inputName !== 'source') throw new Error(`unexpected input ${inputName}`);
      copyFileSync(sourcePath, dest);
    },
    async upload(localPath: string, outputPath: string, contentType: string) {
      // Chép ra chỗ khác: thư mục job có thể bị dọn
      const copy = join(keep, outputPath.replace(/\//g, '__'));
      copyFileSync(localPath, copy);
      uploads.set(outputPath, { localPath: copy, contentType });
    },
    async uploadJson(outputPath: string, data: unknown) {
      json.set(outputPath, JSON.parse(JSON.stringify(data)));
    },
    uploads,
    json,
    stages,
  } as unknown as FakeCtx;
  return ctx;
}

const handler = createScanPrepHandler({ workerVersion: '0.5.0-test' });

describe('handleScanPrep', () => {
  let withSound: string;
  let silent: string;

  beforeAll(async () => {
    withSound = await createVideo('prep_sound.mp4', true);
    silent = await createVideo('prep_silent.mp4', false);
  });

  it('cuts shots by the Studio rules, grabs the middle frames, tiles the sheets and extracts the sound', async () => {
    const assetId = randomUUID();
    const ctx = fakeContext(withSound, { asset_id: assetId, source: 'source' });
    const result = await handler(ctx);

    expect(result.manifest).toBe('prep.json');
    const manifest = ScanPrepManifestSchema.parse(ctx.json.get('prep.json'));
    expect(manifest.schema).toBe('ag.scan.prep/v1');
    expect(manifest.asset_id).toBe(assetId);
    expect(manifest.media).toMatchObject({ width: 320, height: 240, fps: 25, has_audio: true });
    expect(manifest.media.duration_s).toBeCloseTo(32.6, 1);
    expect(manifest.scene).toEqual({ threshold: 0.3, min_shot_s: 1, max_shot_s: 20 });

    // 0–3 · 3–7,6 (lục 0,6 s gộp vào trước) · 7,6–32,6 chia đôi
    const end = manifest.media.duration_s;
    const half = Math.round((7.6 + (end - 7.6) / 2) * 1000) / 1000;
    expect(manifest.shots).toEqual([
      { n: 1, in: 0, out: 3, frame: 'frames/001.jpg' },
      { n: 2, in: 3, out: 7.6, frame: 'frames/002.jpg' },
      { n: 3, in: 7.6, out: half, frame: 'frames/003.jpg' },
      { n: 4, in: half, out: Math.round(end * 1000) / 1000, frame: 'frames/004.jpg' },
    ]);

    // Khung giữa cảnh: rộng 480, cao theo tỉ lệ; khung cảnh 1 là đỏ, cảnh 2 là xanh
    for (const shot of manifest.shots) {
      const up = ctx.uploads.get(shot.frame);
      expect(up?.contentType).toBe('image/jpeg');
      const meta = await sharp(up!.localPath).metadata();
      expect([meta.width, meta.height]).toEqual([480, 360]);
    }
    const red = await sharp(ctx.uploads.get('frames/001.jpg')!.localPath).stats();
    expect(red.channels[0]!.mean).toBeGreaterThan(200);
    expect(red.channels[2]!.mean).toBeLessThan(60);
    const blue = await sharp(ctx.uploads.get('frames/002.jpg')!.localPath).stats();
    expect(blue.channels[2]!.mean).toBeGreaterThan(200);

    // Một tờ 4 cột × 1 hàng
    expect(manifest.sheets).toEqual([{ file: 'sheets/01.jpg', shots: [1, 2, 3, 4] }]);
    const sheet = await sharp(ctx.uploads.get('sheets/01.jpg')!.localPath).metadata();
    expect([sheet.width, sheet.height]).toEqual([1920, 360]);

    // audio.wav: PCM 16 bit, 16 kHz, mono
    expect(manifest.audio).toBe('audio.wav');
    const wav = ctx.uploads.get('audio.wav')!;
    expect(wav.contentType).toBe('audio/wav');
    const header = readFileSync(wav.localPath).subarray(0, 44);
    expect(header.toString('ascii', 0, 4)).toBe('RIFF');
    expect(header.readUInt16LE(20)).toBe(1); // PCM
    expect(header.readUInt16LE(22)).toBe(1); // mono
    expect(header.readUInt32LE(24)).toBe(16_000);
    expect(header.readUInt16LE(34)).toBe(16);

    expect(manifest.tools).toMatchObject({ worker_version: '0.5.0-test' });
    expect(result.summary).toMatchObject({ shots: 4, sheets: 1, has_audio: true, audio: true });
    expect(ctx.stages).toEqual(['download', 'probe', 'scene_detect', 'frames', 'sheets', 'audio', 'upload', 'upload_manifest']);
  });

  it('puts sheet_shots shots on each sheet, and leaves the sound out when asked or when there is none', async () => {
    const noAudio = fakeContext(withSound, { asset_id: randomUUID(), source: 'source', params: { audio: false, sheet_shots: 3, sheet_cols: 2 } });
    const m1 = ScanPrepManifestSchema.parse((await handler(noAudio), noAudio.json.get('prep.json')));
    expect(m1.audio).toBeNull();
    expect(m1.media.has_audio).toBe(true);
    expect(noAudio.uploads.has('audio.wav')).toBe(false);
    expect(m1.sheets).toEqual([
      { file: 'sheets/01.jpg', shots: [1, 2, 3] },
      { file: 'sheets/02.jpg', shots: [4] },
    ]);
    // 3 cảnh, 2 cột → 2 hàng; 1 cảnh → 2 cột × 1 hàng (ô thiếu để đen)
    expect(await sharp(noAudio.uploads.get('sheets/01.jpg')!.localPath).metadata()).toMatchObject({ width: 960, height: 720 });
    expect(await sharp(noAudio.uploads.get('sheets/02.jpg')!.localPath).metadata()).toMatchObject({ width: 960, height: 360 });

    const mute = fakeContext(silent, { asset_id: randomUUID(), source: 'source' });
    const m2 = ScanPrepManifestSchema.parse((await handler(mute), mute.json.get('prep.json')));
    expect(m2.media.has_audio).toBe(false);
    expect(m2.audio).toBeNull();
    expect(m2.shots).toHaveLength(4);
  });

  it('refuses a bad payload and a source that is not a video, without retrying', async () => {
    await expect(handler(fakeContext(withSound, { asset_id: 'x', source: 'source' }))).rejects.toBeInstanceOf(NonRetryableError);

    const png = join(TEST_BASE, 'still.png');
    await execFileAsync(resolveFfmpeg(), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1', '-frames:v', '1', png], { timeout: 60_000 });
    const err = await handler(fakeContext(png, { asset_id: randomUUID(), source: 'source' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as NonRetryableError).code).toBe('not_a_video');
  });

  it('gives a long video time to decode: at least 10 minutes, else twice its length', () => {
    expect(decodeTimeoutMs(30)).toBe(600_000);
    expect(decodeTimeoutMs(3600)).toBe(7_200_000);
  });
});

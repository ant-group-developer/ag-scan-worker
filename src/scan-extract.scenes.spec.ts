/**
 * Kiểm chuỗi scan.extract v2 trên video thật dựng bằng lavfi:
 * dò cảnh → scenes → keyframe đại diện → manifest v2 hợp lệ.
 *
 * - 3 cảnh khác nhau → 3 scenes đúng mốc, 3 keyframes
 * - Video tĩnh 5s không có scene cut → 1 scene, 1 keyframe
 * - Clip dọc → orientation portrait, keyframe có cạnh dài ở chiều cao
 * - Ảnh tĩnh → media.kind=image, scene 0-0, 1 keyframe
 */
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ExtractManifestSchema,
  ScanExtractParamsSchema,
  type ExtractManifest,
} from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { resolveFfmpeg, sumIntervals } from './ffmpeg-utils';
import { handleScanExtract } from './scan-extract';

const execFileAsync = promisify(execFile);
jest.setTimeout(300_000);

const BASE = join(tmpdir(), `ag-scan-scenes-v2-${process.pid}`);

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(resolveFfmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    timeout: 120_000,
  });
}

/** Chạy handler với context giả: `source` là file cục bộ, upload giữ trong bộ nhớ. */
async function runExtract(
  sourcePath: string,
  asset: { kind: 'video' | 'image'; mime_type: string },
  paramsOverride?: Partial<ReturnType<typeof ScanExtractParamsSchema.parse>>,
): Promise<ExtractManifest> {
  const workDir = join(BASE, `work-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  const uploads = new Map<string, Buffer>();

  // v2 params (no more window_s / keyframes_per_segment)
  const defaultParams = ScanExtractParamsSchema.parse({
    keyframe_px: 160,
    proxy: { enabled: true, height: 720, crf: 26, gop_s: 1 },
    contact_sheet: { enabled: false, columns: 6, tile_px: 160 },
  });
  const params = paramsOverride ? { ...defaultParams, ...paramsOverride } : defaultParams;

  const payload = {
    asset: {
      id: '123e4567-e89b-42d3-a456-426614174099',
      kind: asset.kind,
      mime_type: asset.mime_type,
      size_bytes: null,
      checksum_sha256: null,
      duration_ms: null,
      width: null,
      height: null,
    },
    params,
    extract_version: 'test-scenes-v2',
  };
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  const ctx = {
    job: {
      id: '123e4567-e89b-42d3-a456-426614174098',
      owner: 'ag-go', type: 'scan.extract', lane: 'batch', attempt: 1, payload,
      lease_token: 'lease-token-fake-0000000000000000',
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      ticket: 'ticket-fake-placeholder-00000000000000',
      sign_url: 'http://127.0.0.1:1/sign',
    },
    payload, workDir, sign: null, cache: null, log,
    signal: new AbortController().signal,
    progress: () => {},
    shouldYield: () => false,
    yieldToInteractive: async () => {},
    async download(inputName: string, dest: string) {
      if (inputName !== 'source') throw new Error(`unexpected input ${inputName}`);
      copyFileSync(sourcePath, dest);
    },
    async upload(localPath: string, output: string) {
      uploads.set(output, readFileSync(localPath));
    },
    async uploadJson(output: string, data: unknown) {
      uploads.set(output, Buffer.from(JSON.stringify(data)));
    },
  } as unknown as JobContext;

  const result = await handleScanExtract(ctx);
  expect(result.manifest).toBe('extract.json');
  const manifest = ExtractManifestSchema.parse(JSON.parse(uploads.get('extract.json')!.toString()));
  // All keyframes declared in manifest must have been uploaded
  for (const kf of manifest.keyframes) {
    expect(uploads.has(kf.output)).toBe(true);
  }
  if (manifest.proxy) expect(uploads.has(manifest.proxy.output)).toBe(true);
  return manifest;
}

// ---- Helper: span list ----
const spans = (manifest: ExtractManifest) =>
  manifest.scenes.map((s) => [s.start_ms, s.end_ms] as const);

describe('sumIntervals', () => {
  it('closes an interval that runs to the end of the input', () => {
    const log = '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 0.04\n';
    expect(sumIntervals(log, 'freeze', 20)).toBeCloseTo(19.96, 2);
  });

  it('sums closed intervals and ignores a stray end', () => {
    const log = [
      'silence_end: 0.5 | silence_duration: 0.5',
      'silence_start: 1',
      'silence_end: 3 | silence_duration: 2',
      'silence_start: 8',
    ].join('\n');
    expect(sumIntervals(log, 'silence', 10)).toBeCloseTo(4, 5);
  });

  it('reads blackdetect lines with start and end on one line', () => {
    const log = '[blackdetect @ 0x1] black_start:0 black_end:3 black_duration:3';
    expect(sumIntervals(log, 'black', 4)).toBeCloseTo(3, 5);
  });
});

beforeAll(() => mkdirSync(BASE, { recursive: true }));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe('scan.extract v2 on real footage', () => {
  it('splits testsrc2 3s | smptebars 3s | color 4s into 3 scenes at the cuts (±0.4 s)', async () => {
    const path = join(BASE, 'three-scenes.mp4');
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'color=c=0x3366cc:size=320x240:rate=25:duration=4',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
    ]);

    const manifest = await runExtract(path, { kind: 'video', mime_type: 'video/mp4' });

    // v2: check scenes (not segments)
    expect(manifest.scenes).toHaveLength(3);
    expect(manifest.keyframes).toHaveLength(3); // one per scene
    expect(manifest.technical).toBeDefined();

    const [first, second, third] = spans(manifest);
    expect(first![0]).toBe(0);
    expect(Math.abs(first![1] - 3000)).toBeLessThanOrEqual(400);
    expect(Math.abs(second![0] - 3000)).toBeLessThanOrEqual(400);
    expect(Math.abs(second![1] - 6000)).toBeLessThanOrEqual(400);
    expect(Math.abs(third![0] - 6000)).toBeLessThanOrEqual(400);
    expect(Math.abs(third![1] - 10000)).toBeLessThanOrEqual(400);

    // keyframes: one per scene, scene_index matches
    manifest.keyframes.forEach((kf, i) => {
      expect(kf.scene_index).toBe(i);
      expect(kf.dhash).toMatch(/^[0-9a-f]{16}$/);
    });

    expect(manifest.proxy).not.toBeNull();
  });

  it('static clip (5s solid color): 1 scene, 1 keyframe, high frozen_ratio', async () => {
    const path = join(BASE, 'static-5.mp4');
    await ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x3366cc:size=320x240:rate=25:duration=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
    ]);

    const manifest = await runExtract(path, { kind: 'video', mime_type: 'video/mp4' });

    // No scene cuts in a solid-color video → 1 scene
    expect(manifest.scenes).toHaveLength(1);
    expect(manifest.keyframes).toHaveLength(1);

    // Static video should be flagged frozen
    expect(manifest.technical.frozen_ratio).toBeGreaterThan(0.5);
    expect(manifest.technical.dead).toBe(true);
    expect(manifest.technical.dead_reason).toBe('frozen');
  });

  it('marks a vertical clip as portrait with keyframe long edge on height', async () => {
    const path = join(BASE, 'vertical.mp4');
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=25:duration=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path,
    ]);

    const manifest = await runExtract(path, { kind: 'video', mime_type: 'video/mp4' });
    expect(manifest.media.width).toBe(360);
    expect(manifest.media.height).toBe(640);
    expect(manifest.orientation).toBe('portrait');

    // All keyframes should have height >= width (long edge is height for portrait)
    manifest.keyframes.forEach((kf) => {
      expect(kf.height).toBeGreaterThanOrEqual(kf.width);
    });
  });

  it('turns a still image into one scene 0-0 and one keyframe without a proxy', async () => {
    const path = join(BASE, 'still.png');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', path]);

    const manifest = await runExtract(path, { kind: 'image', mime_type: 'image/png' });
    expect(manifest.media.kind).toBe('image');
    expect(manifest.proxy).toBeNull();
    expect(manifest.scenes).toHaveLength(1);
    expect(manifest.scenes[0]).toMatchObject({ index: 0, start_ms: 0, end_ms: 0 });
    expect(manifest.keyframes).toHaveLength(1);
    expect(manifest.keyframes[0]!.t_ms).toBe(0);
    expect(manifest.orientation).toBe('landscape');
  });
});

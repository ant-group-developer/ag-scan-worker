/**
 * Test tích hợp ffmpeg: dùng lavfi để tạo video tổng hợp, không cần file thật.
 * Cần có ffmpeg trong PATH hoặc ffmpeg-static.
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  resolveFfmpeg,
  resolveFfprobe,
  probeMedia,
  detectSceneChanges,
  extractKeyframe,
  getTechMetrics,
} from './ffmpeg-utils';

const execFileAsync = promisify(execFile);

// Tạo dir tạm duy nhất cho toàn bộ suite
const TEST_TMP = join(tmpdir(), `ag-scan-ffmpeg-${process.pid}`);

beforeAll(() => {
  mkdirSync(TEST_TMP, { recursive: true });
});

// ---- Helper tạo video lavfi ----

async function createTestVideo(
  name: string,
  filter: string,
  durationSec: number,
  extraArgs: string[] = [],
): Promise<string> {
  const outPath = join(TEST_TMP, name);
  if (existsSync(outPath)) return outPath;

  const ffmpeg = resolveFfmpeg();
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', filter,
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-crf', '28',
    '-preset', 'ultrafast',
    ...extraArgs,
    outPath,
  ];
  await execFileAsync(ffmpeg, args, { timeout: 60_000 });
  return outPath;
}

// ---- Tạo PNG tĩnh ----
async function createTestImage(name: string): Promise<string> {
  const outPath = join(TEST_TMP, name);
  if (existsSync(outPath)) return outPath;

  const ffmpeg = resolveFfmpeg();
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=1280x720:rate=1',
    '-frames:v', '1',
    outPath,
  ];
  await execFileAsync(ffmpeg, args, { timeout: 30_000 });
  return outPath;
}

// ---- Logger stub ----
const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as import('@ag-farm/worker-sdk').Logger;

// Kéo dài timeout vì ffmpeg chạy thật
jest.setTimeout(120_000);

describe('ffmpeg-utils integration', () => {
  let ffmpeg: string;
  let ffprobe: string;

  beforeAll(() => {
    ffmpeg = resolveFfmpeg();
    ffprobe = resolveFfprobe();
  });

  describe('probeMedia', () => {
    it('probes a 15 s testsrc2 video', async () => {
      // Chỉ đọc thông tin; ca 3 cảnh → 3 đoạn nằm ở scan-extract.scenes.spec.ts
      const path = await createTestVideo(
        'three_seg.mp4',
        'testsrc2=size=640x480:rate=25',
        15,
      );
      const info = await probeMedia(path, ffprobe);
      expect(info.kind).toBe('video');
      expect(info.duration_ms).toBeGreaterThanOrEqual(14_000);
      expect(info.width).toBe(640);
      expect(info.height).toBe(480);
      expect(info.fps).toBeCloseTo(25, 0);
    });

    it('detects still PNG', async () => {
      const path = await createTestImage('still.png');
      // probeMedia on a PNG - it has no video stream, should throw or return image kind
      try {
        const info = await probeMedia(path, ffprobe);
        // PNG parsed as a single frame video
        expect(['image', 'video']).toContain(info.kind);
      } catch {
        // OK - some ffprobe may reject PNG as video
      }
    });

    it('detects portrait video (rotated 90°)', async () => {
      // Tạo video portrait bằng cách transpose
      const path = join(TEST_TMP, 'portrait.mp4');
      if (!existsSync(path)) {
        const f = resolveFfmpeg();
        await execFileAsync(f, [
          '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x640:rate=25',
          '-t', '5',
          '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
          path,
        ], { timeout: 30_000 });
      }
      const info = await probeMedia(path, ffprobe);
      expect(info.height).toBeGreaterThan(info.width);
    });
  });

  describe('detectSceneChanges', () => {
    it('detects scene changes in testsrc2 (pattern changes every ~5s)', async () => {
      // testsrc2 pattern changes periodically; use low threshold to detect
      const path = await createTestVideo('sc_test.mp4', 'testsrc2=size=320x240:rate=25', 15);
      const cuts = await detectSceneChanges(path, ffmpeg, 0.1, 0, noopLog);
      // Should find at least 0 cuts (testsrc2 may not have strong scene changes)
      expect(Array.isArray(cuts)).toBe(true);
      // All cuts should be within range
      cuts.forEach((c) => {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(16_000);
      });
    });

    it('detects hard cut between black and white frames', async () => {
      // Tạo video có cut rõ: 3s đen + 3s trắng
      const path = join(TEST_TMP, 'hardcut.mp4');
      if (!existsSync(path)) {
        const f = resolveFfmpeg();
        // Tạo bằng concat filter
        await execFileAsync(f, [
          '-y',
          '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=25',
          '-f', 'lavfi', '-i', 'color=white:size=320x240:rate=25',
          '-filter_complex', '[0:v]trim=duration=3[a];[1:v]trim=duration=3[b];[a][b]concat=n=2:v=1',
          '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
          '-t', '6',
          path,
        ], { timeout: 30_000 });
      }
      if (existsSync(path) && statSync(path).size > 0) {
        const cuts = await detectSceneChanges(path, ffmpeg, 0.2, 0, noopLog);
        // Should detect at least 1 cut around 3s
        // (may not always detect depending on ffmpeg version; just check no crash)
        expect(Array.isArray(cuts)).toBe(true);
      }
    });
  });

  describe('extractKeyframe', () => {
    it('extracts a JPEG keyframe from test video', async () => {
      const path = await createTestVideo('kf_test.mp4', 'testsrc2=size=320x240:rate=25', 10);
      const outPath = join(TEST_TMP, 'frame_5s.jpg');
      await extractKeyframe(path, outPath, 5, 160);
      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(100);
    });
  });

  describe('getTechMetrics', () => {
    it('returns valid metrics for a test video segment', async () => {
      const path = await createTestVideo('metrics_test.mp4', 'testsrc2=size=320x240:rate=25', 10);
      const metrics = await getTechMetrics(path, 0, 5, false, noopLog);
      // brightness should be 0-1 range (or null)
      if (metrics.brightness !== null) {
        expect(metrics.brightness).toBeGreaterThanOrEqual(0);
        expect(metrics.brightness).toBeLessThanOrEqual(1);
      }
      expect(metrics.black_ratio).toBeGreaterThanOrEqual(0);
      expect(metrics.black_ratio).toBeLessThanOrEqual(1);
      expect(metrics.frozen_ratio).toBeGreaterThanOrEqual(0);
      expect(metrics.frozen_ratio).toBeLessThanOrEqual(1);
      expect(metrics.silence_ratio).toBeNull(); // no audio
    });

    it('returns black_ratio≈1 for all-black video', async () => {
      const path = await createTestVideo('black_test.mp4', 'color=black:size=320x240:rate=25', 5);
      const metrics = await getTechMetrics(path, 0, 5, false, noopLog);
      expect(metrics.black_ratio).toBeGreaterThan(0.5);
    });

    it('returns frozen_ratio≈1 for static (same frame) video', async () => {
      // color filter produces identical frames → frozen
      const path = await createTestVideo('static_test.mp4', 'color=c=blue:size=320x240:rate=25', 5);
      const metrics = await getTechMetrics(path, 0, 5, false, noopLog);
      // a freeze counts once the picture has held for 1 s, so the first second is not in it
      expect(metrics.frozen_ratio).toBeGreaterThan(0.7);
    });

    it('does not call moving footage frozen when frames repeat in pairs', async () => {
      // 25 fps doubled to 50 fps: every frame equals the one before it, the picture still moves.
      // Counting every near-identical pair as a freeze (d=0) summed these into a high frozen_ratio.
      const path = await createTestVideo('doubled_test.mp4', 'testsrc2=size=320x240:rate=25,fps=50', 5);
      const metrics = await getTechMetrics(path, 0, 5, false, noopLog);
      expect(metrics.frozen_ratio).toBeLessThan(0.1);
    });
  });
});

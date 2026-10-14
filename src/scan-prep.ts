/**
 * Handler scan.prep: chuẩn bị đầu vào cho Studio ngay ở ag-go, theo ĐÚNG luật Studio đang tự làm (ag-studio
 * `packages/studio-engine/src/workspace/prepare.ts`), để Studio chỉ việc tải về:
 * tải `source` → ffprobe → dò cảnh cả video (lưới 0,1 s) → `buildShots` → khung giữa mỗi cảnh (`frames/NNN.jpg`,
 * 4 ffmpeg một lúc) → tờ cảnh (`sheets/NN.jpg`, `sheet_shots` cảnh mỗi tờ) → `audio.wav` 16 kHz mono khi có tiếng
 * → upload tất cả → `prep.json` (`ScanPrepManifest`).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ScanPrepManifestSchema,
  ScanPrepPayloadSchema,
  SCAN_PREP_AUDIO_PATH,
  SCAN_PREP_MANIFEST_PATH,
  SCAN_PREP_MANIFEST_SCHEMA,
  scanPrepFramePath,
  scanPrepSheetPath,
} from '@ag-farm/protocol';
import type { JobResult, ScanPrepManifest } from '@ag-farm/protocol';
import type { JobContext, JobHandler } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import {
  detectPrepCuts,
  extractPrepAudio,
  grabPrepFrame,
  probeMedia,
  resolveFfmpeg,
  resolveFfprobe,
  tilePrepSheet,
} from './ffmpeg-utils';
import { buildShots, middleFrameTime, sheetGroups } from './shots';

const execFileAsync = promisify(execFile);

/** Số ffmpeg lấy khung chạy cùng lúc (Studio: `FRAME_LANES`). */
const FRAME_LANES = 4;
/** Số file upload cùng lúc. */
const UPLOAD_LANES = 4;

/** Giải mã cả video (dò cảnh, tách tiếng): ít nhất 10 phút, video dài thì gấp đôi thời lượng. */
export function decodeTimeoutMs(durationS: number): number {
  return Math.max(10 * 60_000, Math.ceil(durationS * 2 * 1000));
}

async function getFfmpegVersion(ffmpeg: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpeg, ['-version'], { timeout: 5_000 });
    const line = (stdout + stderr).split('\n')[0] ?? '';
    const m = line.match(/ffmpeg version ([^\s]+)/);
    return (m?.[1] ?? line.slice(0, 80)) || null;
  } catch {
    return null;
  }
}

/**
 * Chạy `task` cho từng phần tử, tối đa `lanes` cái cùng lúc; một cái lỗi thì không nhận thêm việc và ném lỗi đó
 * (như các lane lấy khung của Studio).
 */
async function inLanes<T>(items: T[], lanes: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let broken = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(lanes, items.length) }, async () => {
      while (!broken && next < items.length) {
        const index = next++;
        try {
          await task(items[index]!, index);
        } catch (err) {
          broken = true;
          throw err;
        }
      }
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

export function createScanPrepHandler(opts: { workerVersion: string }): JobHandler {
  return (ctx) => handleScanPrep(ctx, opts.workerVersion);
}

async function handleScanPrep(ctx: JobContext, workerVersion: string): Promise<JobResult> {
  const parsed = ScanPrepPayloadSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    throw new NonRetryableError('invalid_payload', `Invalid scan.prep payload: ${parsed.error.message}`);
  }
  const { asset_id, source, params } = parsed.data;
  const log = ctx.log.child({ handler: 'scan.prep', asset_id });
  log.info('Starting scan.prep', { source, params });

  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const ffmpegVersion = await getFfmpegVersion(ffmpeg);
  const out = join(ctx.workDir, 'out');
  mkdirSync(join(out, 'frames'), { recursive: true });

  // ---- Tải nguồn, đọc thông tin ----
  ctx.progress(2, 'download');
  const sourcePath = join(ctx.workDir, 'source');
  await ctx.download(source, sourcePath);
  await ctx.yieldToInteractive();

  ctx.progress(10, 'probe');
  let media: Awaited<ReturnType<typeof probeMedia>>;
  try {
    media = await probeMedia(sourcePath, ffprobe);
  } catch (err) {
    if (/No video stream/.test(String(err))) throw new NonRetryableError('not_a_video', `scan.prep: ${String(err)}`);
    throw err;
  }
  const duration = media.duration_s;
  if (media.kind === 'image' || !(duration > 0)) {
    throw new NonRetryableError('not_a_video', `scan.prep: source is not a video with a duration (${duration}s)`);
  }
  log.info('Media info', { duration_s: duration, width: media.width, height: media.height, fps: media.avg_fps, has_audio: media.has_audio });
  const timeoutMs = decodeTimeoutMs(duration);

  // ---- Cảnh: dò trọn video, dựng theo luật Studio ----
  await ctx.yieldToInteractive();
  ctx.progress(12, 'scene_detect');
  const cuts = await detectPrepCuts(ffmpeg, sourcePath, params.scene_threshold, media.start_time_ms / 1000, {
    timeoutMs,
    signal: ctx.signal,
    onTime: (t) => ctx.progress(12 + Math.round(48 * Math.min(1, t / duration)), 'scene_detect'),
  });
  const shots: ScanPrepManifest['shots'] = buildShots(cuts, duration, {
    min_shot_seconds: params.min_shot_s,
    max_shot_seconds: params.max_shot_s,
  }).map((s, i) => ({ n: i + 1, in: s.in, out: s.out, frame: scanPrepFramePath(i + 1) }));
  log.info(`Detected ${cuts.length} scene cuts, built ${shots.length} shots`);

  // ---- Khung giữa mỗi cảnh ----
  await ctx.yieldToInteractive();
  ctx.progress(60, 'frames');
  let grabbed = 0;
  await inLanes(shots, FRAME_LANES, async (shot) => {
    await grabPrepFrame(ffmpeg, sourcePath, middleFrameTime(shot), join(out, shot.frame), params.frame_width, ctx.signal);
    grabbed++;
    ctx.progress(60 + Math.round(20 * (grabbed / shots.length)), 'frames');
  });

  // ---- Tờ cảnh ----
  await ctx.yieldToInteractive();
  ctx.progress(80, 'sheets');
  const sheets: ScanPrepManifest['sheets'] = [];
  for (const group of sheetGroups(shots, params.sheet_shots)) {
    const file = scanPrepSheetPath(sheets.length + 1);
    await tilePrepSheet(ffmpeg, group.map((s) => join(out, s.frame)), params.sheet_cols, join(out, file), ctx.signal);
    sheets.push({ file, shots: group.map((s) => s.n) });
  }

  // ---- Tiếng (cho studio.transcribe) ----
  let audio: string | null = null;
  if (params.audio && media.has_audio) {
    await ctx.yieldToInteractive();
    ctx.progress(85, 'audio');
    const wrote = await extractPrepAudio(ffmpeg, sourcePath, join(out, SCAN_PREP_AUDIO_PATH), { timeoutMs, signal: ctx.signal });
    if (wrote) audio = SCAN_PREP_AUDIO_PATH;
    else log.warn('Source lists a sound track but ffmpeg found none to extract');
  }

  // ---- Upload ----
  await ctx.yieldToInteractive();
  ctx.progress(90, 'upload');
  const files: Array<{ path: string; type: string }> = [
    ...shots.map((s) => ({ path: s.frame, type: 'image/jpeg' })),
    ...sheets.map((s) => ({ path: s.file, type: 'image/jpeg' })),
    ...(audio ? [{ path: audio, type: 'audio/wav' }] : []),
  ];
  let uploaded = 0;
  await inLanes(files, UPLOAD_LANES, async (f) => {
    await ctx.upload(join(out, f.path), f.path, f.type);
    uploaded++;
    ctx.progress(90 + Math.round(8 * (uploaded / files.length)), 'upload');
  });

  const manifest = ScanPrepManifestSchema.parse({
    schema: SCAN_PREP_MANIFEST_SCHEMA,
    asset_id,
    media: { duration_s: duration, width: media.width, height: media.height, fps: media.avg_fps, has_audio: media.has_audio },
    scene: { threshold: params.scene_threshold, min_shot_s: params.min_shot_s, max_shot_s: params.max_shot_s },
    shots,
    sheets,
    audio,
    tools: { ...(ffmpegVersion ? { ffmpeg: ffmpegVersion } : {}), worker_version: workerVersion },
  } satisfies ScanPrepManifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(SCAN_PREP_MANIFEST_PATH, manifest);
  log.info('scan.prep done', { shots: shots.length, sheets: sheets.length, audio: audio !== null });

  return {
    manifest: SCAN_PREP_MANIFEST_PATH,
    summary: { shots: shots.length, sheets: sheets.length, duration_s: duration, has_audio: media.has_audio, audio: audio !== null },
  };
}

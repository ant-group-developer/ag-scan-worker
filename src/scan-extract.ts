/**
 * Handler scan.extract: tải file gốc → ffprobe → proxy 720p → dò cảnh →
 * chia đoạn → keyframe + dHash → contact sheet → chỉ số kỹ thuật → upload.
 */
import { statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  ScanExtractPayloadSchema,
  ExtractManifestSchema,
  EXTRACT_MANIFEST_SCHEMA,
  EXTRACT_MANIFEST_PATH,
} from '@ag-farm/protocol';
import type { ExtractManifest, ExtractSegment, Keyframe, SegmentTechnical } from '@ag-farm/protocol';
import type { JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import {
  probeMedia,
  detectSceneChanges,
  makeProxy,
  extractKeyframe,
  getTechMetrics,
  resolveFfmpeg,
  resolveFfprobe,
} from './ffmpeg-utils';
import { buildSegments } from './segmentation';
import { computeDhash } from './dhash';
import type { Logger } from '@ag-farm/worker-sdk';

const execFileAsync = promisify(execFile);

// ---- Capabilities cache ----

let _nvdecAvailable: boolean | null = null;

/**
 * NVDEC dùng được khi ffmpeg có hwaccel cuda VÀ máy thật sự có GPU NVIDIA: bản ffmpeg dựng sẵn
 * luôn liệt kê `cuda` kể cả trên máy không có card.
 */
async function isNvdecAvailable(): Promise<boolean> {
  if (_nvdecAvailable !== null) return _nvdecAvailable;
  try {
    const { stdout } = await execFileAsync(resolveFfmpeg(), ['-hwaccels'], { timeout: 8_000 });
    const gpus = await execFileAsync('nvidia-smi', ['-L'], { timeout: 8_000 });
    _nvdecAvailable = stdout.toLowerCase().includes('cuda') && /GPU \d+:/.test(gpus.stdout);
  } catch {
    _nvdecAvailable = false;
  }
  return _nvdecAvailable;
}

// ---- Tiện ích ----

function orientationOf(width: number, height: number): 'landscape' | 'portrait' | 'square' {
  if (width > height) return 'landscape';
  if (height > width) return 'portrait';
  return 'square';
}

function zeroPad(n: number, len = 4): string {
  return String(n).padStart(len, '0');
}

async function safeDhash(jpegPath: string): Promise<string> {
  try {
    return await computeDhash(jpegPath);
  } catch {
    return '0000000000000000';
  }
}

async function imageSize(jpegPath: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(jpegPath).metadata();
  return { width: meta.width ?? 1, height: meta.height ?? 1 };
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

// ---- Contact sheet ----

async function buildContactSheet(
  keyframePaths: string[],
  outputPath: string,
  columns: number,
  tilePx: number,
): Promise<void> {
  if (keyframePaths.length === 0) throw new Error('No keyframes for contact sheet');

  const rows = Math.ceil(keyframePaths.length / columns);
  const sheetWidth = columns * tilePx;
  const sheetHeight = rows * tilePx;

  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < keyframePaths.length; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const tileBuffer = await sharp(keyframePaths[i]!)
      .resize(tilePx, tilePx, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer();

    composites.push({ input: tileBuffer, left: col * tilePx, top: row * tilePx });
  }

  await sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toFile(outputPath);
}

// ---- Ảnh tĩnh ----

async function handleStaticImage(
  ctx: JobContext,
  assetId: string,
  extractVersion: string,
  sourceLocalPath: string,
  workDir: string,
  mediaInfo: Awaited<ReturnType<typeof probeMedia>>,
  params: ReturnType<typeof ScanExtractPayloadSchema.parse>['params'],
  ffmpegVersion: string | null,
  log: Logger,
): Promise<JobResult> {
  const { width, height, rotation } = mediaInfo;
  ctx.progress(30, 'keyframe');

  const kfRelPath = 'keyframes/0001-1.jpg';
  const kfLocalPath = join(workDir, kfRelPath);
  mkdirSync(join(workDir, 'keyframes'), { recursive: true });

  await sharp(sourceLocalPath)
    .resize(params.keyframe_px, params.keyframe_px, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toFile(kfLocalPath);

  const { width: kfW, height: kfH } = await imageSize(kfLocalPath);
  const kfDhash = await safeDhash(kfLocalPath);
  await ctx.upload(kfLocalPath, kfRelPath, 'image/jpeg');

  const kf: Keyframe = { output: kfRelPath, t_ms: 0, width: kfW, height: kfH, dhash: kfDhash };

  const technical: SegmentTechnical = {
    brightness: null, blur: null, black_ratio: 0, frozen_ratio: 0,
    silence_ratio: null, dead: false, dead_reason: null,
  };

  const seg: ExtractSegment = {
    index: 0, start_ms: 0, end_ms: 0, boundary_reason: 'still',
    orientation: orientationOf(kfW, kfH), keyframes: [kf], technical,
  };

  let contactSheet: ExtractManifest['contact_sheet'] = null;
  if (params.contact_sheet.enabled) {
    ctx.progress(60, 'contact_sheet');
    const csPath = join(workDir, 'contact_sheet.jpg');
    await sharp(kfLocalPath)
      .resize(params.contact_sheet.tile_px, params.contact_sheet.tile_px, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(csPath);
    await ctx.upload(csPath, 'contact_sheet.jpg', 'image/jpeg');
    contactSheet = { output: 'contact_sheet.jpg', columns: 1, rows: 1 };
  }

  const manifest: ExtractManifest = {
    schema: EXTRACT_MANIFEST_SCHEMA,
    asset_id: assetId,
    extract_version: extractVersion,
    media: { kind: 'image', duration_ms: 0, width, height, fps: null, has_audio: false, rotation },
    proxy: null,
    contact_sheet: contactSheet,
    segments: [seg],
    tools: { ffmpeg: ffmpegVersion, worker_version: extractVersion },
  };

  const validated = ExtractManifestSchema.parse(manifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(EXTRACT_MANIFEST_PATH, validated);
  log.info('scan.extract (still image) done');

  return {
    manifest: EXTRACT_MANIFEST_PATH,
    summary: { segments: 1, kind: 'image', proxy: false },
  };
}

// ---- Handler chính ----

export async function handleScanExtract(ctx: JobContext): Promise<JobResult> {
  const payloadResult = ScanExtractPayloadSchema.safeParse(ctx.payload);
  if (!payloadResult.success) {
    throw new NonRetryableError('invalid_payload', `Invalid scan.extract payload: ${payloadResult.error.message}`);
  }
  const { asset, params, extract_version } = payloadResult.data;

  const log = ctx.log.child({ handler: 'scan.extract', asset_id: asset.id });
  log.info('Starting scan.extract', { kind: asset.kind });

  const workDir = ctx.workDir;
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  const ffmpegVersion = await getFfmpegVersion(ffmpeg);

  ctx.progress(2, 'download');

  // Tải file gốc
  const sourceLocalPath = join(workDir, 'source_original');
  await ctx.download('source', sourceLocalPath);
  // Việc Studio trên máy được ưu tiên: nhường slot trước mỗi bước nặng.
  await ctx.yieldToInteractive();
  ctx.progress(15, 'probe');

  // ffprobe
  const mediaInfo = await probeMedia(sourceLocalPath, ffprobe);
  log.info('Media info', mediaInfo as unknown as Record<string, unknown>);

  const { kind, duration_ms, width, height, fps, has_audio, rotation, start_time_ms } = mediaInfo;

  // Ảnh tĩnh. ffprobe coi PNG/JPEG là luồng video một khung (thời lượng 0), nên dựa vào loại asset
  // mà chủ job gửi, và coi mọi media không có thời lượng là ảnh.
  if (asset.kind === 'image' || kind === 'image' || duration_ms <= 0) {
    return handleStaticImage(ctx, asset.id, extract_version, sourceLocalPath, workDir, mediaInfo, params, ffmpegVersion, log);
  }

  // Proxy 720p
  ctx.progress(16, 'proxy');
  let proxyInfo: ExtractManifest['proxy'] = null;
  const proxyPath = join(workDir, 'proxy.mp4');

  if (params.proxy.enabled) {
    const nvdec = await isNvdecAvailable();
    await makeProxy(sourceLocalPath, proxyPath, {
      height: params.proxy.height,
      crf: params.proxy.crf,
      gop_s: params.proxy.gop_s,
      nvdecAvailable: nvdec,
    }, log);

    const proxyMedia = await probeMedia(proxyPath, ffprobe);
    proxyInfo = {
      output: 'proxy.mp4',
      width: proxyMedia.width,
      height: proxyMedia.height,
      size_bytes: statSync(proxyPath).size,
    };
    ctx.progress(35, 'upload_proxy');
    await ctx.upload(proxyPath, 'proxy.mp4', 'video/mp4');
  }

  // Dò cảnh trên proxy (hoặc source)
  await ctx.yieldToInteractive();
  ctx.progress(40, 'scene_detect');
  const analyzeSource = proxyInfo ? proxyPath : sourceLocalPath;
  const sceneStartMs = proxyInfo ? 0 : start_time_ms;
  const sceneCuts = await detectSceneChanges(analyzeSource, ffmpeg, params.scene_threshold, sceneStartMs, log);
  log.info(`Detected ${sceneCuts.length} scene cuts`);

  // Pre-compute dHash cho midpoints
  ctx.progress(45, 'segmentation');
  const windowMs = Math.round(params.window_s * 1000);
  const maxSegMs = Math.round(params.max_segment_s * 1000);
  const minSegMs = Math.round(params.min_segment_s * 1000);

  const dhashCache = new Map<number, string>();
  const cuts = [...new Set([0, ...sceneCuts, duration_ms])].sort((a, b) => a - b);
  const midpoints: number[] = [];
  let cur = 0;
  while (cur < duration_ms) {
    const nextCut = cuts.find((c) => c > cur);
    const windowEnd = cur + windowMs;
    const end = nextCut !== undefined && nextCut <= windowEnd ? nextCut : Math.min(windowEnd, duration_ms);
    midpoints.push(Math.round((cur + end) / 2));
    cur = end;
  }

  await Promise.all(midpoints.map(async (t) => {
    const tmpFrame = join(workDir, `dhash_${t}.jpg`);
    try {
      await extractKeyframe(analyzeSource, tmpFrame, t / 1000, 64);
      dhashCache.set(t, await safeDhash(tmpFrame));
    } catch {
      dhashCache.set(t, '0000000000000000');
    }
  }));

  const segments = buildSegments({
    duration_ms,
    scene_cuts_ms: sceneCuts,
    window_ms: windowMs,
    max_segment_ms: maxSegMs,
    min_segment_ms: minSegMs,
    merge_dhash_max_distance: params.merge_dhash_max_distance,
    getDhash: (t) => dhashCache.get(t) ?? '0000000000000000',
  });

  log.info(`Built ${segments.length} segments`);
  await ctx.yieldToInteractive();
  ctx.progress(50, 'keyframes');

  // Trích keyframe + tech metrics
  mkdirSync(join(workDir, 'keyframes'), { recursive: true });
  const extractedSegments: ExtractSegment[] = [];
  const allKeyframePaths: string[] = [];

  for (let si = 0; si < segments.length; si++) {
    await ctx.yieldToInteractive();
    const seg = segments[si]!;
    const segDuration = seg.end_ms - seg.start_ms;
    const segStartSec = seg.start_ms / 1000;
    const segEndSec = seg.end_ms / 1000;

    const kfCount = params.keyframes_per_segment;
    const kfTimes: number[] = [];
    for (let k = 0; k < kfCount; k++) {
      const frac = kfCount === 1 ? 0.5 : k / (kfCount - 1);
      const tMs = seg.start_ms + Math.round(frac * segDuration * 0.9 + segDuration * 0.05);
      kfTimes.push(Math.min(tMs, Math.max(seg.start_ms, seg.end_ms - 50)));
    }

    const keyframes: Keyframe[] = [];
    for (let ki = 0; ki < kfTimes.length; ki++) {
      const tMs = kfTimes[ki]!;
      const kfRelPath = `keyframes/${zeroPad(si + 1)}-${ki + 1}.jpg`;
      const kfLocalPath = join(workDir, kfRelPath);

      await extractKeyframe(analyzeSource, kfLocalPath, tMs / 1000, params.keyframe_px);

      const { width: kfW, height: kfH } = await imageSize(kfLocalPath);
      const kfDhash = await safeDhash(kfLocalPath);
      await ctx.upload(kfLocalPath, kfRelPath, 'image/jpeg');
      allKeyframePaths.push(kfLocalPath);

      keyframes.push({ output: kfRelPath, t_ms: tMs, width: kfW, height: kfH, dhash: kfDhash });
    }

    const tech = await getTechMetrics(analyzeSource, segStartSec, segEndSec, has_audio, log);

    let dead = false;
    let dead_reason: SegmentTechnical['dead_reason'] = null;
    if (tech.black_ratio >= params.dead.black_ratio_min) {
      dead = true; dead_reason = 'black';
    } else if (tech.frozen_ratio >= params.dead.frozen_ratio_min) {
      dead = true; dead_reason = 'frozen';
    } else if (tech.blur !== null && tech.blur >= params.dead.blur_min) {
      dead = true; dead_reason = 'blurry';
    }

    const technical: SegmentTechnical = {
      brightness: tech.brightness,
      blur: tech.blur,
      black_ratio: tech.black_ratio,
      frozen_ratio: tech.frozen_ratio,
      silence_ratio: tech.silence_ratio,
      dead,
      dead_reason,
    };

    const kf0 = keyframes[0]!;
    extractedSegments.push({
      index: seg.index,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      boundary_reason: seg.boundary_reason,
      orientation: orientationOf(kf0.width, kf0.height),
      keyframes,
      technical,
    });

    ctx.progress(50 + Math.round(45 * (si + 1) / segments.length), 'keyframes');
  }

  // Contact sheet
  let contactSheet: ExtractManifest['contact_sheet'] = null;
  if (params.contact_sheet.enabled && allKeyframePaths.length > 0) {
    ctx.progress(95, 'contact_sheet');
    const csPath = join(workDir, 'contact_sheet.jpg');
    const { columns } = params.contact_sheet;
    const rows = Math.ceil(allKeyframePaths.length / columns);
    await buildContactSheet(allKeyframePaths, csPath, columns, params.contact_sheet.tile_px);
    await ctx.upload(csPath, 'contact_sheet.jpg', 'image/jpeg');
    contactSheet = { output: 'contact_sheet.jpg', columns, rows };
  }

  const manifest: ExtractManifest = {
    schema: EXTRACT_MANIFEST_SCHEMA,
    asset_id: asset.id,
    extract_version,
    media: {
      kind,
      duration_ms,
      width,
      height,
      fps: fps ?? null,
      has_audio,
      rotation,
    },
    proxy: proxyInfo,
    contact_sheet: contactSheet,
    segments: extractedSegments,
    tools: { ffmpeg: ffmpegVersion, worker_version: extract_version },
  };

  const validated = ExtractManifestSchema.parse(manifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(EXTRACT_MANIFEST_PATH, validated);

  log.info('scan.extract done', { segments: extractedSegments.length });

  return {
    manifest: EXTRACT_MANIFEST_PATH,
    summary: {
      segments: extractedSegments.length,
      duration_ms,
      kind,
      proxy: proxyInfo !== null,
    },
  };
}

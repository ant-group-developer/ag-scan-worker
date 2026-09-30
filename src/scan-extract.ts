/**
 * Handler scan.extract v2: tải file gốc → ffprobe → proxy 720p → dò cảnh →
 * keyframe đại diện mỗi cảnh (cạnh dài keyframe_px, bỏ trùng dHash) →
 * chỉ số kỹ thuật cả video → contact sheet → upload manifest.
 *
 * Không còn chia đoạn (segment): cảnh chỉ để chọn keyframe đại diện;
 * mô tả và chỉ số kỹ thuật tính cho cả file.
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
import type { ExtractManifest, Keyframe, Scene, AssetTechnical } from '@ag-farm/protocol';
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
import { hammingDistance } from './segmentation';
import { computeDhash } from './dhash';
import type { Logger } from '@ag-farm/worker-sdk';

const execFileAsync = promisify(execFile);

// ---- Capabilities cache ----

let _nvdecAvailable: boolean | null = null;

/**
 * NVDEC dùng được khi ffmpeg có hwaccel cuda VÀ máy thật sự có GPU NVIDIA.
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

// ---- Concurrency helpers ----

/**
 * Chạy các task không quá `limit` task đồng thời, giữ thứ tự kết quả.
 */
async function withConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length) as T[];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Chọn n phần tử rải đều từ mảng theo chỉ số. */
function pickEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round(i * (items.length - 1) / (n - 1));
    result.push(items[idx]!);
  }
  return result;
}

// ---- Scene building ----

/**
 * Xây danh sách cảnh từ các mốc cắt, gộp cảnh ngắn hơn minSceneMs vào cảnh trước.
 */
function buildScenes(
  cuts: number[],
  durationMs: number,
  minSceneMs: number,
): Array<{ start_ms: number; end_ms: number }> {
  if (durationMs <= 0) return [{ start_ms: 0, end_ms: 0 }];

  // Biên giới: 0, các cắt dương < duration, duration
  const bounds = [
    ...new Set([0, ...cuts.filter((t) => t > 0 && t < durationMs), durationMs]),
  ].sort((a, b) => a - b);

  if (bounds.length < 2) return [{ start_ms: 0, end_ms: durationMs }];

  // Cảnh thô
  const raw: Array<{ start_ms: number; end_ms: number }> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    raw.push({ start_ms: bounds[i]!, end_ms: bounds[i + 1]! });
  }

  // Gộp cảnh ngắn hơn minSceneMs vào cảnh trước
  const merged: Array<{ start_ms: number; end_ms: number }> = [];
  for (const scene of raw) {
    const len = scene.end_ms - scene.start_ms;
    if (merged.length > 0 && len < minSceneMs) {
      merged[merged.length - 1]!.end_ms = scene.end_ms;
    } else {
      merged.push({ ...scene });
    }
  }

  return merged.length > 0 ? merged : [{ start_ms: 0, end_ms: durationMs }];
}

// ---- Contact sheet ----

/**
 * Tạo contact sheet từ danh sách keyframe; mỗi ô giữ tỉ lệ khung của ảnh (fit:inside),
 * không cắt. Cạnh dài của ô = tilePx.
 */
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

    // Đọc kích thước ảnh gốc rồi tính tile size giữ tỉ lệ, cạnh dài = tilePx
    const meta = await sharp(keyframePaths[i]!).metadata();
    const iw = meta.width ?? 1;
    const ih = meta.height ?? 1;

    let tileW: number, tileH: number;
    if (iw >= ih) {
      tileW = tilePx;
      tileH = Math.max(1, Math.round((ih * tilePx) / iw));
    } else {
      tileH = tilePx;
      tileW = Math.max(1, Math.round((iw * tilePx) / ih));
    }

    const tileBuffer = await sharp(keyframePaths[i]!)
      .resize(tileW, tileH, { fit: 'fill' })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Căn giữa ô tilePx × tilePx
    const offsetX = col * tilePx + Math.floor((tilePx - tileW) / 2);
    const offsetY = row * tilePx + Math.floor((tilePx - tileH) / 2);
    composites.push({ input: tileBuffer, left: offsetX, top: offsetY });
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

  const kfRelPath = 'keyframes/0001.jpg';
  const kfLocalPath = join(workDir, kfRelPath);
  mkdirSync(join(workDir, 'keyframes'), { recursive: true });

  const isPortrait = height > width;
  await sharp(sourceLocalPath)
    .resize(
      isPortrait ? undefined : params.keyframe_px,
      isPortrait ? params.keyframe_px : undefined,
      { fit: 'inside' },
    )
    .jpeg({ quality: 85 })
    .toFile(kfLocalPath);

  const { width: kfW, height: kfH } = await imageSize(kfLocalPath);
  const kfDhash = await safeDhash(kfLocalPath);
  await ctx.upload(kfLocalPath, kfRelPath, 'image/jpeg');

  const kf: Keyframe = {
    output: kfRelPath,
    t_ms: 0,
    width: kfW,
    height: kfH,
    dhash: kfDhash,
    scene_index: 0,
  };

  const scene: Scene = { index: 0, start_ms: 0, end_ms: 0 };

  const technical: AssetTechnical = {
    brightness: null,
    blur: null,
    black_ratio: 0,
    frozen_ratio: 0,
    silence_ratio: null,
    has_speech_hint: null,
    dead: false,
    dead_reason: null,
  };

  let contactSheet: ExtractManifest['contact_sheet'] = null;
  if (params.contact_sheet.enabled) {
    ctx.progress(60, 'contact_sheet');
    const csPath = join(workDir, 'contact_sheet.jpg');
    await buildContactSheet([kfLocalPath], csPath, 1, params.contact_sheet.tile_px);
    await ctx.upload(csPath, 'contact_sheet.jpg', 'image/jpeg');
    contactSheet = { output: 'contact_sheet.jpg', columns: 1, rows: 1 };
  }

  const manifest: ExtractManifest = {
    schema: EXTRACT_MANIFEST_SCHEMA,
    asset_id: assetId,
    extract_version: extractVersion,
    media: { kind: 'image', duration_ms: 0, width, height, fps: null, has_audio: false, rotation },
    orientation: orientationOf(width, height),
    proxy: null,
    contact_sheet: contactSheet,
    scenes: [scene],
    keyframes: [kf],
    technical,
    tools: { ffmpeg: ffmpegVersion, worker_version: extractVersion },
  };

  const validated = ExtractManifestSchema.parse(manifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(EXTRACT_MANIFEST_PATH, validated);
  log.info('scan.extract (still image) done');

  return {
    manifest: EXTRACT_MANIFEST_PATH,
    summary: { scenes: 1, keyframes: 1, kind: 'image', proxy: false },
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
  await ctx.yieldToInteractive();
  ctx.progress(15, 'probe');

  // ffprobe
  const mediaInfo = await probeMedia(sourceLocalPath, ffprobe);
  log.info('Media info', mediaInfo as unknown as Record<string, unknown>);

  const { kind, duration_ms, width, height, fps, has_audio, rotation, start_time_ms } = mediaInfo;

  // Ảnh tĩnh
  if (asset.kind === 'image' || kind === 'image' || duration_ms <= 0) {
    return handleStaticImage(
      ctx, asset.id, extract_version, sourceLocalPath, workDir,
      mediaInfo, params, ffmpegVersion, log,
    );
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

  // Khi proxy tồn tại, dùng kích thước proxy để xác định orientation của keyframe
  const analyzeWidth = proxyInfo ? proxyInfo.width : width;
  const analyzeHeight = proxyInfo ? proxyInfo.height : height;
  const isPortrait = analyzeHeight > analyzeWidth;

  const sceneCuts = await detectSceneChanges(
    analyzeSource, ffmpeg, params.scene_threshold, sceneStartMs, log,
  );
  log.info(`Detected ${sceneCuts.length} scene cuts`);

  // Xây danh sách cảnh, gộp cảnh ngắn hơn min_scene_s
  const minSceneMs = Math.round(params.min_scene_s * 1000);
  const rawScenes = buildScenes(sceneCuts, duration_ms, minSceneMs);
  const scenes: Scene[] = rawScenes.map((s, idx) => ({ index: idx, ...s }));
  log.info(`Built ${scenes.length} scenes`);

  // Trích một keyframe đại diện mỗi cảnh (giữa cảnh)
  ctx.progress(45, 'keyframes');
  mkdirSync(join(workDir, 'keyframes'), { recursive: true });

  interface CandidateKf {
    sceneIndex: number;
    tMs: number;
    relPath: string;
    localPath: string;
  }

  const candidateTasks: Array<() => Promise<CandidateKf | null>> = scenes.map((scene, si) => async () => {
    const tMs = scene.end_ms > scene.start_ms
      ? Math.round((scene.start_ms + scene.end_ms) / 2)
      : scene.start_ms;

    const relPath = `keyframes/${zeroPad(si + 1)}.jpg`;
    const localPath = join(workDir, relPath);

    try {
      await extractKeyframe(
        analyzeSource, localPath, tMs / 1000, params.keyframe_px,
        analyzeWidth, analyzeHeight,
      );
      return { sceneIndex: si, tMs, relPath, localPath };
    } catch (err) {
      log.warn(`Keyframe extraction failed for scene ${si} at t=${tMs}ms`, { error: String(err) });
      return null;
    }
  });

  // Bắt đầu với khả năng timeout; giới hạn 4 ffmpeg đồng thời
  const candidateResults = await withConcurrencyLimit(candidateTasks, 4);

  // Đọc kích thước và dHash cho các keyframe trích được
  interface KfWithHash {
    sceneIndex: number;
    tMs: number;
    relPath: string;
    localPath: string;
    width: number;
    height: number;
    dhash: string;
  }

  const candidates: KfWithHash[] = [];
  for (const c of candidateResults) {
    if (c === null) continue;
    const { width: kfW, height: kfH } = await imageSize(c.localPath);
    const dhash = await safeDhash(c.localPath);
    candidates.push({ ...c, width: kfW, height: kfH, dhash });
  }

  // dHash dedup: bỏ keyframe trùng với keyframe đã giữ
  const kept: KfWithHash[] = [];
  for (const c of candidates) {
    const isDup = kept.some(
      (k) => hammingDistance(c.dhash, k.dhash) <= params.keyframe_dedup_distance,
    );
    if (!isDup) kept.push(c);
  }

  // Nếu vẫn nhiều hơn max_keyframes: rải đều theo thứ tự thời gian
  const final = pickEvenly(kept, params.max_keyframes);

  // Ensure có ít nhất 1 keyframe
  if (final.length === 0 && candidates.length > 0) {
    final.push(candidates[0]!);
  }

  if (final.length === 0) {
    throw new Error('No keyframes could be extracted from the video');
  }

  // Upload keyframes
  await ctx.yieldToInteractive();
  ctx.progress(55, 'upload_keyframes');
  const keyframes: Keyframe[] = [];
  const allLocalKfPaths: string[] = [];

  for (const kf of final) {
    await ctx.upload(kf.localPath, kf.relPath, 'image/jpeg');
    allLocalKfPaths.push(kf.localPath);
    keyframes.push({
      output: kf.relPath,
      t_ms: kf.tMs,
      width: kf.width,
      height: kf.height,
      dhash: kf.dhash,
      scene_index: kf.sceneIndex,
    });
  }

  // Chỉ số kỹ thuật cả video trong MỘT lần chạy ffmpeg
  await ctx.yieldToInteractive();
  ctx.progress(70, 'technical_metrics');
  const tech = await getTechMetrics(analyzeSource, 0, duration_ms / 1000, has_audio, log);

  const has_speech_hint = has_audio
    ? (tech.silence_ratio !== null ? tech.silence_ratio < params.speech_silence_ratio_max : null)
    : null;

  let dead = false;
  let dead_reason: AssetTechnical['dead_reason'] = null;
  if (tech.black_ratio >= params.dead.black_ratio_min) {
    dead = true; dead_reason = 'black';
  } else if (tech.frozen_ratio >= params.dead.frozen_ratio_min) {
    dead = true; dead_reason = 'frozen';
  } else if (tech.blur !== null && tech.blur >= params.dead.blur_min) {
    dead = true; dead_reason = 'blurry';
  }

  const technical: AssetTechnical = {
    brightness: tech.brightness,
    blur: tech.blur,
    black_ratio: tech.black_ratio,
    frozen_ratio: tech.frozen_ratio,
    silence_ratio: tech.silence_ratio,
    has_speech_hint,
    dead,
    dead_reason,
  };

  // Contact sheet
  let contactSheet: ExtractManifest['contact_sheet'] = null;
  if (params.contact_sheet.enabled && allLocalKfPaths.length > 0) {
    ctx.progress(90, 'contact_sheet');
    const csPath = join(workDir, 'contact_sheet.jpg');
    const { columns } = params.contact_sheet;
    const rows = Math.ceil(allLocalKfPaths.length / columns);
    await buildContactSheet(allLocalKfPaths, csPath, columns, params.contact_sheet.tile_px);
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
    orientation: orientationOf(width, height),
    proxy: proxyInfo,
    contact_sheet: contactSheet,
    scenes,
    keyframes,
    technical,
    tools: { ffmpeg: ffmpegVersion, worker_version: extract_version },
  };

  const validated = ExtractManifestSchema.parse(manifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(EXTRACT_MANIFEST_PATH, validated);

  log.info('scan.extract done', { scenes: scenes.length, keyframes: keyframes.length });

  return {
    manifest: EXTRACT_MANIFEST_PATH,
    summary: {
      scenes: scenes.length,
      keyframes: keyframes.length,
      duration_ms,
      kind,
      proxy: proxyInfo !== null,
    },
  };
}

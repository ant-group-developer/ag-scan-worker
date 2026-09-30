/**
 * Tiện ích ffmpeg/ffprobe: resolve đường dẫn, chạy probe, dò cảnh, làm proxy, trích keyframe.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { runProcess } from '@ag-farm/worker-sdk';
import type { Logger } from '@ag-farm/worker-sdk';

const execFileAsync = promisify(execFile);

// ---- Resolve ffmpeg/ffprobe paths ----

function resolveBinaryPath(envKey: string, fallbackName: string, staticPkg: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Thử ffmpeg-static / ffprobe-static
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(staticPkg) as unknown;
    // ffmpeg-static returns a string; ffprobe-static returns { path: string }
    const p: unknown = mod && typeof mod === 'object' && 'path' in (mod as object)
      ? (mod as { path: unknown }).path
      : mod;
    if (typeof p === 'string' && p && existsSync(p)) return p;
  } catch {
    // không có package
  }
  return fallbackName; // dùng PATH
}

export function resolveFfmpeg(): string {
  return resolveBinaryPath('FFMPEG_PATH', 'ffmpeg', 'ffmpeg-static');
}

export function resolveFfprobe(): string {
  return resolveBinaryPath('FFPROBE_PATH', 'ffprobe', 'ffprobe-static');
}

// ---- Probe media ----

export interface MediaInfo {
  kind: 'video' | 'image';
  duration_ms: number;
  width: number;
  height: number;
  fps: number | null;
  has_audio: boolean;
  rotation: number;
  start_time_ms: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ side_data_type?: string; rotation?: string | number }>;
}

interface FfprobeFormat {
  duration?: string;
  start_time?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export async function probeMedia(filePath: string, ffprobe: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ], { timeout: 30_000 });

  const data = JSON.parse(stdout) as FfprobeOutput;
  const streams = data.streams ?? [];
  const format = data.format ?? {};

  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error(`No video stream found in ${filePath}`);
  }

  // Độ phân giải (trước khi tính rotate)
  let width = videoStream.width ?? 0;
  let height = videoStream.height ?? 0;

  // Tính FPS
  let fps: number | null = null;
  const fpsStr = videoStream.r_frame_rate ?? videoStream.avg_frame_rate ?? '';
  if (fpsStr && fpsStr !== '0/0') {
    const [num, den] = fpsStr.split('/');
    if (num && den) {
      const n = Number(num);
      const d = Number(den);
      if (d > 0) fps = n / d;
    }
  }

  // Rotation
  let rotation = 0;
  const rotateTag = videoStream.tags?.rotate;
  if (rotateTag) rotation = parseInt(rotateTag, 10) || 0;

  // Side data rotation (mới hơn)
  if (videoStream.side_data_list) {
    for (const sd of videoStream.side_data_list) {
      if (sd.side_data_type === 'Display Matrix' && sd.rotation !== undefined) {
        rotation = typeof sd.rotation === 'string' ? parseInt(sd.rotation, 10) : sd.rotation;
        break;
      }
    }
  }

  // Đảo width/height khi rotation 90/270
  if (rotation === 90 || rotation === 270 || rotation === -90 || rotation === -270) {
    [width, height] = [height, width];
  }

  const durationSec = parseFloat(format.duration ?? '0') || 0;
  const startTimeSec = parseFloat(format.start_time ?? '0') || 0;

  // Xác định loại file
  const mimeHints = filePath.toLowerCase();
  const isImage =
    mimeHints.endsWith('.jpg') ||
    mimeHints.endsWith('.jpeg') ||
    mimeHints.endsWith('.png') ||
    mimeHints.endsWith('.webp') ||
    mimeHints.endsWith('.gif') ||
    mimeHints.endsWith('.tiff') ||
    (fps === null && durationSec < 0.1);

  return {
    kind: isImage ? 'image' : 'video',
    duration_ms: Math.round(durationSec * 1000),
    width,
    height,
    fps: isImage ? null : fps,
    has_audio: audioStream !== undefined,
    rotation: Math.abs(rotation) % 360,
    start_time_ms: Math.round(startTimeSec * 1000),
  };
}

// ---- Scene detection ----

/**
 * Dò cắt cảnh bằng ffmpeg select=gt(scene,T),showinfo.
 * Trả về các thời điểm cắt (ms) theo timeline file (đã trừ start_time).
 */
export async function detectSceneChanges(
  filePath: string,
  ffmpeg: string,
  threshold: number,
  startTimeMs: number,
  log: Logger,
): Promise<number[]> {
  const vf = `select='gt(scene\\,${threshold})',showinfo`;
  const args = ['-i', filePath, '-vf', vf, '-f', 'null', '-'];

  let stderr = '';
  const result = await runProcess(ffmpeg, args, {
    timeoutMs: 120_000,
    onStderrLine: (line) => { stderr += line + '\n'; },
  });

  if (result.exitCode !== 0 && result.signal !== 'SIGKILL') {
    // ffmpeg exit code non-zero is normal when outputting to null
    // only warn if we have no output at all
  }

  const times = new Set<number>();
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) {
      // Normalise to original timeline
      const normalised = Math.round((t * 1000) - startTimeMs);
      if (normalised > 0) times.add(normalised);
    }
  }

  return Array.from(times).sort((a, b) => a - b);
}

// ---- Proxy 720p ----

export interface ProxyOptions {
  height: number;
  crf: number;
  gop_s: number;
  nvdecAvailable: boolean;
}

export async function makeProxy(
  inputPath: string,
  outputPath: string,
  opts: ProxyOptions,
  log: Logger,
): Promise<void> {
  const { height, crf, gop_s, nvdecAvailable } = opts;
  const ffmpeg = resolveFfmpeg();
  const gopFrames = Math.round(gop_s * 25); // approximate

  // Thử NVDEC trước nếu có
  if (nvdecAvailable) {
    const hwArgs = buildProxyArgs(inputPath, outputPath, height, crf, gopFrames, true);
    const r = await runProcess(ffmpeg, hwArgs, { timeoutMs: 7_200_000 });
    if (r.exitCode === 0) {
      log.info('Proxy (NVDEC)', { output: outputPath });
      return;
    }
    log.warn('NVDEC proxy failed, falling back to software');
  }

  const swArgs = buildProxyArgs(inputPath, outputPath, height, crf, gopFrames, false);
  const r = await runProcess(ffmpeg, swArgs, { timeoutMs: 7_200_000 });
  if (r.exitCode !== 0) {
    throw new Error(`Proxy encoding failed (exit ${r.exitCode})`);
  }
  log.info('Proxy (SW)', { output: outputPath });
}

function buildProxyArgs(
  input: string,
  output: string,
  height: number,
  crf: number,
  gopFrames: number,
  useHw: boolean,
): string[] {
  const args: string[] = ['-y'];
  if (useHw) args.push('-hwaccel', 'cuda');
  args.push('-i', input);
  args.push(
    '-vf', `scale=-2:'min(${height},ih)'`, // không phóng to nguồn nhỏ hơn
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-g', String(gopFrames),
    '-preset', 'fast',
    '-c:a', 'aac',
    '-ac', '1',
    '-ar', '44100',
    output,
  );
  return args;
}

// ---- Trích keyframe ----

export async function extractKeyframe(
  proxyPath: string,
  outputPath: string,
  timeSec: number,
  width: number,
): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const args = [
    '-y',
    '-ss', String(timeSec),
    '-i', proxyPath,
    '-vframes', '1',
    '-vf', `scale=${width}:-2`,
    '-q:v', '2',
    outputPath,
  ];
  const r = await runProcess(ffmpeg, args, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    throw new Error(`Keyframe extraction failed at t=${timeSec}s`);
  }
}

// ---- Technical metrics ----

export interface TechMetrics {
  brightness: number | null;
  blur: number | null;
  black_ratio: number;
  frozen_ratio: number;
  silence_ratio: number | null;
}

/**
 * Chạy ffmpeg filters để lấy các chỉ số kỹ thuật cho một đoạn.
 * Sử dụng signalstats, blurdetect, blackdetect, freezedetect, silencedetect.
 */
export async function getTechMetrics(
  proxyPath: string,
  startSec: number,
  endSec: number,
  hasAudio: boolean,
  log: Logger,
): Promise<TechMetrics> {
  const duration = endSec - startSec;
  if (duration <= 0) {
    return { brightness: null, blur: null, black_ratio: 0, frozen_ratio: 0, silence_ratio: null };
  }

  const ffmpeg = resolveFfmpeg();

  // Video filters
  const vf = [
    'signalstats',
    'blurdetect=high=1',
    `blackdetect=d=0`,
    // d=1: a freeze counts only once the picture has held for 1 s. With d=0 every pair of near-identical
    // frames starts one, and slow real footage (e.g. 4K 10-bit) chained them into ~100 % "frozen".
    `freezedetect=n=0.001:d=1`,
  ].join(',');

  const audioFilters = hasAudio ? 'silencedetect=n=-50dB:d=0' : null;

  const args = ['-y', '-ss', String(startSec), '-t', String(duration), '-i', proxyPath];

  if (audioFilters) {
    args.push('-af', audioFilters);
  }

  args.push('-vf', vf, '-f', 'null', '-');

  let stderr = '';
  await runProcess(ffmpeg, args, {
    timeoutMs: 60_000,
    onStderrLine: (line) => { stderr += line + '\n'; },
  });

  // Parse signalstats YAVG
  let totalYavg = 0;
  let yavgCount = 0;
  for (const m of stderr.matchAll(/YAVG:([0-9.]+)/g)) {
    totalYavg += parseFloat(m[1] ?? '0');
    yavgCount++;
  }
  const brightness = yavgCount > 0 ? (totalYavg / yavgCount) / 255 : null;

  // Parse blurdetect
  let totalBlur = 0;
  let blurCount = 0;
  for (const m of stderr.matchAll(/blur:([0-9.]+)/gi)) {
    totalBlur += parseFloat(m[1] ?? '0');
    blurCount++;
  }
  const blur = blurCount > 0 ? totalBlur / blurCount : null;

  const black_ratio = sumIntervals(stderr, 'black', duration) / duration;
  const frozen_ratio = sumIntervals(stderr, 'freeze', duration) / duration;
  const silence_ratio = hasAudio ? sumIntervals(stderr, 'silence', duration) / duration : null;

  return { brightness, blur, black_ratio, frozen_ratio, silence_ratio };
}

/**
 * Cộng độ dài các khoảng `<key>_start` … `<key>_end` trong log của blackdetect/freezedetect/
 * silencedetect. freezedetect và silencedetect không in `_end`/`_duration` khi khoảng kéo tới
 * hết input, nên khoảng còn mở được tính tới `total` (thời lượng đoạn đang đo).
 */
export function sumIntervals(stderr: string, key: 'black' | 'freeze' | 'silence', total: number): number {
  const pattern = new RegExp(`${key}_(start|end)\\s*[:=]\\s*(-?[0-9.]+)`, 'g');
  let open: number | null = null;
  let sum = 0;
  for (const match of stderr.matchAll(pattern)) {
    const value = parseFloat(match[2] ?? '0');
    if (match[1] === 'start') {
      if (open === null) open = Math.max(0, value);
    } else if (open !== null) {
      sum += Math.max(0, value - open);
      open = null;
    }
  }
  if (open !== null) sum += Math.max(0, total - open);
  return Math.min(total, sum);
}

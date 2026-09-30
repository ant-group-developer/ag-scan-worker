/**
 * Handler scan.ai v2: Ollama Qwen-VL mô tả toàn bộ video theo hai bước.
 *
 * Bước 1 – Ghi chú (notes): xem keyframe theo nhóm frames_per_note, viết ghi chú
 *   tiếng Việt ngắn gọn cho từng nhóm.
 * Bước 2 – Tóm tắt (summary): dùng tất cả ghi chú + tối đa 4 keyframe đại diện +
 *   gợi ý ngữ cảnh → một AssetDescription JSON cho cả video.
 *
 * Kết quả: ai.json (AiManifestSchema v2). Nếu mô tả thất bại sau mọi lần sửa,
 * ghi description=null và ném lỗi retryable để farm thử lại.
 */
import { z } from 'zod';
import {
  ScanAiPayloadSchema,
  AssetDescriptionSchema,
  AiManifestSchema,
  AI_MANIFEST_SCHEMA,
  AI_MANIFEST_PATH,
} from '@ag-farm/protocol';
import type { AiManifest } from '@ag-farm/protocol';
import type { JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

// ---- JSON Schema từ Zod schema ----

function getAssetDescriptionJsonSchema(): object {
  if (typeof (z as unknown as { toJSONSchema?: (s: unknown) => object }).toJSONSchema === 'function') {
    return (z as unknown as { toJSONSchema: (s: unknown) => object }).toJSONSchema(AssetDescriptionSchema);
  }
  // Fallback tối giản khi không có z.toJSONSchema (không phải zod v4)
  return {
    type: 'object',
    required: [
      'title_vi', 'summary_vi', 'summary_en', 'genre', 'topics', 'subjects', 'places', 'actions',
      'keywords_vi', 'tags', 'mood', 'setting', 'time_of_day', 'people_count', 'shot_variety',
      'camera_motions', 'visible_text', 'has_watermark', 'usable', 'usable_reason', 'quality',
    ],
    properties: {
      title_vi: { type: 'string' },
      summary_vi: { type: 'string' },
      summary_en: { type: 'string' },
      genre: { type: 'string' },
      topics: { type: 'array', items: { type: 'string' } },
      subjects: { type: 'array', items: { type: 'string' } },
      places: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
      keywords_vi: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      mood: { type: 'string' },
      setting: { type: 'string', enum: ['indoor', 'outdoor', 'mixed', 'unknown'] },
      time_of_day: { type: 'string', enum: ['day', 'night', 'golden_hour', 'indoor', 'mixed', 'unknown'] },
      people_count: { type: 'string', enum: ['none', 'one', 'few', 'many', 'crowd'] },
      shot_variety: { type: 'array', items: { type: 'string' } },
      camera_motions: { type: 'array', items: { type: 'string' } },
      visible_text: { type: 'string' },
      has_watermark: { type: 'boolean' },
      usable: { type: 'boolean' },
      usable_reason: { type: 'string' },
      quality: { type: 'integer', minimum: 0, maximum: 5 },
    },
  };
}

// ---- Đọc ảnh thành base64 ----

async function imageToBase64(localPath: string): Promise<string> {
  const buf = readFileSync(localPath);
  return buf.toString('base64');
}

// ---- Ollama API call ----

/** Ollama /api/chat message: `content` là string thuần; ảnh đi trong `images` base64 (không có data: URL). */
interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

interface OllamaResponse {
  message?: { content?: string };
}

async function callOllama(
  ollamaUrl: string,
  model: string,
  messages: OllamaMessage[],
  keepAlive: string,
  signal: AbortSignal,
  options: {
    format?: object;
    numPredict?: number;
  } = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    options: { temperature: 0, num_predict: options.numPredict ?? 1024 },
    keep_alive: keepAlive,
  };
  if (options.format !== undefined) {
    body.format = options.format;
  }

  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as OllamaResponse;
  return data.message?.content ?? '';
}

// ---- Sửa JSON ----

function attemptJsonRepair(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /**/ }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /**/ }
  }

  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /**/ }

  throw new Error(`Cannot parse JSON: ${raw.slice(0, 200)}`);
}

// ---- Chọn đều từ mảng ----

function pickEvenly<T>(items: T[], n: number): T[] {
  if (items.length === 0 || n <= 0) return [];
  if (items.length <= n) return [...items];
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round(i * (items.length - 1) / (n - 1));
    result.push(items[idx]!);
  }
  return result;
}

// ---- Xây dựng prompt hệ thống ----

function buildNotesSystemPrompt(): string {
  return `Bạn là chuyên gia phân tích nội dung video cho thư viện footage Việt Nam.
Hãy quan sát các keyframe được cung cấp và viết một ghi chú ngắn bằng tiếng Việt (tối đa 80 từ).
Mô tả những gì thấy được: cảnh vật, con người, địa điểm, hoạt động, chữ trên màn hình.
Chỉ mô tả, không đặt câu hỏi, không giải thích thêm.`;
}

function buildSummarySystemPrompt(
  context: { asset_name: string | null; project_names: string[]; category_names: string[]; province_names: string[] },
  media: { duration_ms: number; has_audio: boolean; has_speech_hint: boolean | null },
): string {
  const hints: string[] = [];
  if (context.asset_name) hints.push(`Tên file: ${context.asset_name}`);
  if (context.project_names.length > 0) hints.push(`Dự án: ${context.project_names.join(', ')}`);
  if (context.category_names.length > 0) hints.push(`Danh mục: ${context.category_names.join(', ')}`);
  if (context.province_names.length > 0) hints.push(`Tỉnh/thành: ${context.province_names.join(', ')}`);

  const contextStr = hints.length > 0
    ? `Ngữ cảnh gợi ý (có thể không chính xác – chỉ tham khảo): ${hints.join('; ')}.`
    : '';

  const durationStr = (media.duration_ms / 1000).toFixed(1);
  const audioStr = media.has_audio
    ? (media.has_speech_hint === true ? 'có audio và có thể có lời nói'
      : media.has_speech_hint === false ? 'có audio, chủ yếu tiếng động môi trường'
      : 'có audio')
    : 'không có audio';

  return `Bạn là chuyên gia phân tích nội dung video cho thư viện footage Việt Nam.
${contextStr}
Thông tin kỹ thuật: thời lượng ${durationStr}s, ${audioStr}.
Dựa trên các ghi chú về từng nhóm khung hình (và có thể cả ảnh đại diện), hãy viết một mô tả tổng hợp
cho cả video theo JSON schema được chỉ định.
- summary_vi: tối đa 120 từ tiếng Việt
- summary_en: tối đa 90 từ tiếng Anh
- quality: 0 (rất kém) đến 5 (xuất sắc)
- usable: true nếu clip dùng được trong sản phẩm chuyên nghiệp
Trả lời CHÍNH XÁC theo JSON schema, không thêm văn bản nào khác.`;
}

// ---- Xử lý chính ----

export interface ScanAiOptions {
  /** Địa chỉ Ollama (`extra.ollama_url` trong config). */
  ollamaUrl?: string;
}

/** Factory: tạo handler scan.ai với Ollama URL cụ thể. */
export function createScanAiHandler(options: ScanAiOptions = {}): (ctx: JobContext) => Promise<JobResult> {
  return (ctx) => runScanAi(ctx, options.ollamaUrl ?? DEFAULT_OLLAMA_URL);
}

/** Handler scan.ai cho test cũ (lấy ollamaUrl từ ctx.ollamaUrl nếu có). */
export async function handleScanAi(ctx: JobContext): Promise<JobResult> {
  const ollamaUrlOverride = (ctx as unknown as { ollamaUrl?: string }).ollamaUrl;
  return runScanAi(ctx, ollamaUrlOverride ?? DEFAULT_OLLAMA_URL);
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

async function runScanAi(ctx: JobContext, ollamaUrl: string): Promise<JobResult> {
  const payloadResult = ScanAiPayloadSchema.safeParse(ctx.payload);
  if (!payloadResult.success) {
    throw new NonRetryableError('invalid_payload', `Invalid scan.ai payload: ${payloadResult.error.message}`);
  }
  const { asset_id, model, prompt_version, context, media, keyframes, options } = payloadResult.data;
  const { keep_alive, repair_attempts, frames_per_note } = options;

  const log = ctx.log.child({ handler: 'scan.ai', asset_id });
  log.info('Starting scan.ai v2', { model, keyframes: keyframes.length });

  const workDir = ctx.workDir;
  mkdirSync(workDir, { recursive: true });

  const t0 = Date.now();

  // Tải tất cả keyframes về local
  const localPaths: string[] = [];
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i]!;
    const localPath = join(workDir, `kf_${i}.jpg`);
    try {
      await ctx.download(kf.input, localPath);
      localPaths.push(localPath);
    } catch (e) {
      log.warn(`Failed to download keyframe ${kf.input}`, { error: String(e) });
      localPaths.push('');
    }
  }

  // ---- Bước 1: Ghi chú từng nhóm keyframe ----

  const notes: string[] = [];
  const notesSystemPrompt = buildNotesSystemPrompt();
  const totalFrames = localPaths.filter((p) => p !== '').length;
  const totalGroups = Math.ceil(keyframes.length / frames_per_note);

  for (let gi = 0; gi < totalGroups; gi++) {
    await ctx.yieldToInteractive();
    ctx.progress(Math.round(10 + (gi / totalGroups) * 50), `notes_group_${gi}`);

    const start = gi * frames_per_note;
    const end = Math.min(start + frames_per_note, keyframes.length);
    const groupPaths = localPaths.slice(start, end).filter((p) => p !== '');

    const images: string[] = [];
    for (const lp of groupPaths) {
      try {
        images.push(await imageToBase64(lp));
      } catch (e) {
        log.warn('Failed to encode keyframe', { error: String(e) });
      }
    }

    const tStart = keyframes[start]?.t_ms ?? 0;
    const tEnd = keyframes[Math.min(end - 1, keyframes.length - 1)]?.t_ms ?? 0;

    const messages: OllamaMessage[] = [
      { role: 'system', content: notesSystemPrompt },
      {
        role: 'user',
        content: `Nhóm keyframe ${gi + 1}/${totalGroups} (t=${tStart}ms–${tEnd}ms, ${images.length} ảnh). Hãy mô tả ngắn gọn bằng tiếng Việt.`,
        images: images.length > 0 ? images : undefined,
      },
    ];

    let note = '';
    try {
      note = await callOllama(ollamaUrl, model, messages, keep_alive, ctx.signal, { numPredict: 1024 });
    } catch (e) {
      log.warn(`Notes call failed for group ${gi}`, { error: String(e) });
      note = `(nhóm ${gi + 1}: không đọc được)`;
    }

    // AiManifest caps each note at 2000 characters; a chatty model must not fail the whole job
    notes.push(note.trim().slice(0, 2000));
    log.info(`Note group ${gi + 1}/${totalGroups}`, { length: note.length });
  }

  log.info('Notes step done', { groups: notes.length, totalFrames });

  // ---- Bước 2: Tóm tắt toàn video ----

  await ctx.yieldToInteractive();
  ctx.progress(65, 'summary');

  const jsonSchema = getAssetDescriptionJsonSchema();
  const summarySystemPrompt = buildSummarySystemPrompt(context, media);

  // Chọn tối đa 4 keyframe đại diện rải đều
  const summaryFramePaths = pickEvenly(localPaths.filter((p) => p !== ''), 4);
  const summaryImages: string[] = [];
  for (const lp of summaryFramePaths) {
    try {
      summaryImages.push(await imageToBase64(lp));
    } catch { /**/ }
  }

  const notesText = notes.map((n, i) => `Nhóm ${i + 1}: ${n}`).join('\n');
  const userContent = `Dưới đây là ghi chú các nhóm keyframe của video:\n\n${notesText}\n\nHãy viết mô tả tổng hợp cho cả video theo JSON schema.`;

  const summaryMessages: OllamaMessage[] = [
    { role: 'system', content: summarySystemPrompt },
    {
      role: 'user',
      content: userContent,
      images: summaryImages.length > 0 ? summaryImages : undefined,
    },
  ];

  let description: AiManifest['description'] = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= repair_attempts; attempt++) {
    await ctx.yieldToInteractive();

    try {
      const raw = await callOllama(
        ollamaUrl, model, summaryMessages, keep_alive, ctx.signal,
        { format: jsonSchema, numPredict: 1536 },
      );
      const parsed = attemptJsonRepair(raw);
      const validated = AssetDescriptionSchema.safeParse(parsed);
      if (validated.success) {
        description = validated.data;
        lastError = null;
        break;
      } else {
        lastError = `Validation failed (attempt ${attempt}): ${validated.error.message}`;
        log.warn(lastError);

        // Thêm feedback để model tự sửa
        if (attempt < repair_attempts) {
          summaryMessages.push({ role: 'assistant', content: raw });
          summaryMessages.push({
            role: 'user',
            content: `JSON không hợp lệ. Lỗi: ${validated.error.message}. Hãy sửa và trả lại JSON đúng schema.`,
          });
        }
      }
    } catch (e) {
      lastError = String(e);
      log.warn(`Summary Ollama call failed (attempt ${attempt})`, { error: lastError });
      if (ctx.signal.aborted) break;
    }
  }

  const duration_ms = Date.now() - t0;

  // Ghi manifest
  const aiManifest: AiManifest = {
    schema: AI_MANIFEST_SCHEMA,
    asset_id,
    model,
    prompt_version,
    description,
    notes,
    error: lastError === null ? null : lastError.slice(0, 2000),
    duration_ms,
  };

  const validated = AiManifestSchema.parse(aiManifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(AI_MANIFEST_PATH, validated);

  log.info('scan.ai done', {
    description: description !== null,
    notes: notes.length,
    duration_ms,
  });

  // Nếu mô tả thất bại: ném lỗi retryable sau khi đã upload manifest
  if (description === null) {
    throw new Error(`scan.ai: description failed after ${repair_attempts + 1} attempt(s): ${lastError ?? 'unknown'}`);
  }

  return {
    manifest: AI_MANIFEST_PATH,
    summary: {
      description: true,
      notes: notes.length,
      duration_ms,
    },
  };
}

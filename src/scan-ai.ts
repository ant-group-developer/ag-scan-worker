/**
 * Handler scan.ai: gọi Ollama Qwen-VL mô tả từng đoạn.
 * Input: keyframe ảnh; Output: ai-NNNN.json (AiManifest).
 */
import { z } from 'zod';
import {
  ScanAiPayloadSchema,
  SegmentDescriptionSchema,
  AiManifestSchema,
  AI_MANIFEST_SCHEMA,
  aiManifestPath,
} from '@ag-farm/protocol';
import type { AiManifest } from '@ag-farm/protocol';
import type { JobResult } from '@ag-farm/protocol';
import type { JobContext } from '@ag-farm/worker-sdk';
import { NonRetryableError } from '@ag-farm/worker-sdk';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

// ---- JSON Schema từ Zod schema ----

// Dùng z.toJSONSchema nếu có (zod v4), fallback nếu không có.
function getSegmentJsonSchema(): object {
  if (typeof (z as unknown as { toJSONSchema?: (s: unknown) => object }).toJSONSchema === 'function') {
    return (z as unknown as { toJSONSchema: (s: unknown) => object }).toJSONSchema(SegmentDescriptionSchema);
  }
  // Fallback: trả về schema tối giản để Ollama biết cấu trúc
  return {
    type: 'object',
    properties: {
      caption_vi: { type: 'string' },
      caption_en: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      keywords_vi: { type: 'array', items: { type: 'string' } },
      subjects: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
      shot_size: { type: 'string', enum: ['extreme_wide', 'wide', 'medium', 'close_up', 'extreme_close_up', 'unknown'] },
      camera_motion: { type: 'string', enum: ['static', 'pan', 'tilt', 'zoom', 'dolly', 'handheld', 'aerial', 'unknown'] },
      time_of_day: { type: 'string', enum: ['day', 'night', 'golden_hour', 'indoor', 'unknown'] },
      setting: { type: 'string', enum: ['indoor', 'outdoor', 'mixed', 'unknown'] },
      people_count: { type: 'string', enum: ['none', 'one', 'few', 'many', 'crowd'] },
      visible_text: { type: 'string' },
      has_watermark: { type: 'boolean' },
      usable: { type: 'boolean' },
      usable_reason: { type: 'string' },
      quality: { type: 'integer', minimum: 0, maximum: 5 },
    },
    required: [
      'caption_vi', 'caption_en', 'tags', 'keywords_vi', 'subjects', 'actions',
      'shot_size', 'camera_motion', 'time_of_day', 'setting', 'people_count',
      'visible_text', 'has_watermark', 'usable', 'usable_reason', 'quality',
    ],
  };
}

// ---- Đọc ảnh thành base64 ----

async function imageToBase64(localPath: string): Promise<{ data: string; mimeType: string }> {
  const buf = readFileSync(localPath);
  const ext = localPath.split('.').pop()?.toLowerCase() ?? 'jpg';
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return {
    data: buf.toString('base64'),
    mimeType: mimeMap[ext] ?? 'image/jpeg',
  };
}

// ---- Ollama API call ----

/** Ollama /api/chat message: `content` is text only; pictures go in `images` as bare base64 (no data: URL). */
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
  jsonSchema: object,
  keepAlive: string,
  signal: AbortSignal,
): Promise<string> {
  const body = {
    model,
    messages,
    stream: false,
    format: jsonSchema,
    // A small model can loop on a list (the same tag over and over): cap the answer instead of waiting minutes.
    options: { temperature: 0, num_predict: 1024 },
    keep_alive: keepAlive,
  };

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

// ---- Sửa JSON phổ biến ----

function attemptJsonRepair(raw: string): unknown {
  // Thử parse trực tiếp
  try { return JSON.parse(raw); } catch { /**/ }

  // Trích JSON object/array đầu tiên
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /**/ }
  }

  // Thử bỏ trailing garbage
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /**/ }

  throw new Error(`Cannot parse JSON: ${raw.slice(0, 200)}`);
}

// ---- Xây dựng prompt ----

function buildSystemPrompt(context: { project_names: string[]; category_names: string[]; province_names: string[] }): string {
  const hints: string[] = [];
  if (context.project_names.length > 0) hints.push(`Dự án: ${context.project_names.join(', ')}`);
  if (context.category_names.length > 0) hints.push(`Danh mục: ${context.category_names.join(', ')}`);
  if (context.province_names.length > 0) hints.push(`Tỉnh/thành: ${context.province_names.join(', ')}`);

  const contextHint = hints.length > 0
    ? `Gợi ý ngữ cảnh (có thể không chính xác, dùng để tham khảo): ${hints.join('; ')}.`
    : '';

  return `Bạn là chuyên gia phân tích nội dung video cho một thư viện footage của Việt Nam.
${contextHint}
Quan sát các keyframe được cung cấp và mô tả đoạn video theo cấu trúc JSON được chỉ định.
Trả lời CHÍNH XÁC theo JSON schema, không thêm bất kỳ văn bản nào khác.
- caption_vi: tối đa 40 từ tiếng Việt
- caption_en: tối đa 30 từ tiếng Anh
- quality: 0 (xấu nhất) đến 5 (tốt nhất)
- usable: true nếu clip có thể dùng được trong sản phẩm chuyên nghiệp`;
}

// ---- Handler chính ----

export async function handleScanAi(ctx: JobContext): Promise<JobResult> {
  const payloadResult = ScanAiPayloadSchema.safeParse(ctx.payload);
  if (!payloadResult.success) {
    throw new NonRetryableError('invalid_payload', `Invalid scan.ai payload: ${payloadResult.error.message}`);
  }
  const { asset_id, chunk, model, prompt_version, context, segments, options } = payloadResult.data;

  const log = ctx.log.child({ handler: 'scan.ai', asset_id, chunk });
  log.info('Starting scan.ai', { model, segments: segments.length });

  // Ollama URL từ config nếu có, mặc định localhost
  const ollamaUrl = (ctx as unknown as { ollamaUrl?: string }).ollamaUrl ?? 'http://localhost:11434';
  const jsonSchema = getSegmentJsonSchema();
  const systemPrompt = buildSystemPrompt(context);
  const { keep_alive, repair_attempts } = options;

  const workDir = ctx.workDir;
  mkdirSync(workDir, { recursive: true });

  const items: AiManifest['items'] = [];
  const total = segments.length;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const t0 = Date.now();
    ctx.progress(Math.round((i / total) * 95), `segment_${seg.index}`);

    // Tải keyframes về local
    const localKeyframePaths: string[] = [];
    for (const kfInputName of seg.keyframes) {
      const localPath = join(workDir, `kf_${seg.segment_id}_${localKeyframePaths.length}.jpg`);
      try {
        await ctx.download(kfInputName, localPath);
        localKeyframePaths.push(localPath);
      } catch (e) {
        log.warn(`Failed to download keyframe ${kfInputName}`, { error: String(e) });
      }
    }

    if (localKeyframePaths.length === 0) {
      items.push({
        segment_id: seg.segment_id,
        description: null,
        error: 'No keyframes available',
        duration_ms: Date.now() - t0,
      });
      continue;
    }

    // Keyframe đi trong `images` của tin nhắn user (định dạng của Ollama, không phải image_url kiểu OpenAI)
    const images: string[] = [];
    for (const localPath of localKeyframePaths) {
      try {
        images.push((await imageToBase64(localPath)).data);
      } catch (e) {
        log.warn(`Failed to encode keyframe`, { error: String(e) });
      }
    }

    const messages: OllamaMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Mô tả đoạn video này (index=${seg.index}, ${seg.start_ms}ms–${seg.end_ms}ms). Trả lời theo JSON schema.`,
        images,
      },
    ];

    // Gọi Ollama với retry sửa lỗi
    let description: AiManifest['items'][number]['description'] = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= repair_attempts; attempt++) {
      try {
        const raw = await callOllama(ollamaUrl, model, messages, jsonSchema, keep_alive, ctx.signal);
        const parsed = attemptJsonRepair(raw);
        const validated = SegmentDescriptionSchema.safeParse(parsed);
        if (validated.success) {
          description = validated.data;
          lastError = null;
          break;
        } else {
          lastError = `Zod validation failed (attempt ${attempt}): ${validated.error.message}`;
          log.warn(lastError, { segment_id: seg.segment_id });

          // Thêm feedback để model sửa
          if (attempt < repair_attempts) {
            messages.push({ role: 'assistant', content: raw });
            messages.push({
              role: 'user',
              content: `JSON không hợp lệ. Lỗi: ${validated.error.message}. Hãy sửa và trả lại JSON đúng schema.`,
            });
          }
        }
      } catch (e) {
        lastError = String(e);
        log.warn(`Ollama call failed (attempt ${attempt})`, { error: lastError });
        if (ctx.signal.aborted) break;
      }
    }

    items.push({
      segment_id: seg.segment_id,
      description,
      error: lastError,
      duration_ms: Date.now() - t0,
    });
  }

  // Upload manifest
  const manifestPath = aiManifestPath(chunk);
  const aiManifest: AiManifest = {
    schema: AI_MANIFEST_SCHEMA,
    asset_id,
    chunk,
    model,
    prompt_version,
    items,
  };

  const validated = AiManifestSchema.parse(aiManifest);
  ctx.progress(98, 'upload_manifest');
  await ctx.uploadJson(manifestPath, validated);

  const successCount = items.filter((it) => it.description !== null).length;
  log.info('scan.ai done', { items: items.length, success: successCount });

  return {
    manifest: manifestPath,
    summary: {
      items: items.length,
      success: successCount,
      errors: items.length - successCount,
    },
  };
}

/**
 * Handler scan.ai v2: Ollama Qwen-VL mô tả toàn bộ video theo hai bước.
 *
 * Bước 1 – Ghi chú (notes): xem keyframe theo nhóm frames_per_note, viết ghi chú
 *   tiếng Việt ngắn gọn cho từng nhóm.
 * Bước 2 – Tóm tắt (summary): dùng tất cả ghi chú + tối đa 4 keyframe đại diện +
 *   gợi ý ngữ cảnh → một AssetDescription JSON cho cả video.
 *
 * Kết quả: ai.json (AiManifestSchema v2) và ai-trace.json (AiTraceSchema) ghi lại
 * mọi lần gọi Ollama để dùng làm dataset huấn luyện. Trace upload là best-effort:
 * lỗi 403 từ ag-go cũ không làm fail job.
 * Nếu mô tả thất bại sau mọi lần sửa, ghi description=null và ném lỗi retryable.
 */
import { z } from 'zod';
import {
  ScanAiPayloadSchema,
  AssetDescriptionSchema,
  AiManifestSchema,
  AI_MANIFEST_SCHEMA,
  AI_MANIFEST_PATH,
  AiTraceSchema,
  AI_TRACE_SCHEMA,
  AI_TRACE_PATH,
} from '@ag-farm/protocol';
import type { AiManifest, AiTrace } from '@ag-farm/protocol';
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
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Thời gian xử lý tổng (nanoseconds). */
  total_duration?: number;
}

/** Kết quả đầy đủ từ một lần gọi Ollama, bao gồm các chỉ số inference cho trace. */
interface OllamaCallResult {
  content: string;
  done_reason: string | null;
  prompt_eval_count: number | null;
  eval_count: number | null;
  total_duration_ms: number | null;
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
): Promise<OllamaCallResult> {
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
  return {
    content: data.message?.content ?? '',
    done_reason: data.done_reason ?? null,
    prompt_eval_count: data.prompt_eval_count != null ? data.prompt_eval_count : null,
    eval_count: data.eval_count != null ? data.eval_count : null,
    total_duration_ms: data.total_duration != null ? data.total_duration / 1_000_000 : null,
  };
}

// ---- Kiểu trace message (không có base64) ----

interface TraceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images: Array<{ input: string; t_ms: number }>;
}

interface TraceCall {
  step: 'notes' | 'summary';
  group: number | null;
  attempt: number;
  started_at: string;
  messages: TraceMessage[];
  options: Record<string, unknown>;
  response: string | null;
  error: string | null;
  accepted: boolean;
  done_reason: string | null;
  prompt_eval_count: number | null;
  eval_count: number | null;
  total_duration_ms: number | null;
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
/** A short title reads as a title (the schema allows 120; qwen2.5vl:3b tends to put a sentence there). */
export const TITLE_MAX_CHARS = 80;
/** Scripts the small Qwen-VL models slip into Vietnamese text now and then. */
const FOREIGN_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FOREIGN_SCRIPT_ALL = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

type Description = NonNullable<AiManifest['description']>;

/** Vietnamese text fields (every string field but `summary_en`), with their names. */
function textFields(d: Description): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'summary_en') continue;
    if (typeof v === 'string') out.push([k, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === 'string') out.push([`${k}[${i}]`, x]); });
  }
  return out;
}

/** What makes a schema-valid description still unusable for Studio: foreign scripts, a sentence as the title. */
export function descriptionProblems(d: Description): string[] {
  const problems = textFields(d).filter(([, v]) => FOREIGN_SCRIPT.test(v)).map(([k]) => `${k} có chữ không phải tiếng Việt`);
  if (d.title_vi.length > TITLE_MAX_CHARS) problems.push(`title_vi dài ${d.title_vi.length} ký tự`);
  return problems;
}

/** Last resort after the repair round: drop foreign characters, cut the title at a word boundary. */
export function cleanDescription(d: Description): Description {
  const clean = (v: string) => v.replace(FOREIGN_SCRIPT_ALL, '').replace(/\s{2,}/g, ' ').trim();
  const out = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) {
    if (k === 'summary_en') continue;
    if (typeof v === 'string') out[k] = clean(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? clean(x) : x)).filter((x) => x !== '');
  }
  let title = String(out['title_vi'] ?? '');
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS);
    title = (cut.lastIndexOf(' ') > 40 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(/[\s,.;:]+$/, '');
  }
  out['title_vi'] = title || String(d.title_vi).slice(0, TITLE_MAX_CHARS);
  return out as Description;
}

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

  /** Danh sách các lần gọi Ollama, dùng để build AiTrace sau. */
  const traceCalls: TraceCall[] = [];

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

  /** Map từ local path → { input, t_ms } để build trace images mà không dùng base64. */
  const pathToKfRef = new Map<string, { input: string; t_ms: number }>();
  for (let i = 0; i < keyframes.length; i++) {
    const lp = localPaths[i] ?? '';
    if (lp) pathToKfRef.set(lp, { input: keyframes[i]!.input, t_ms: keyframes[i]!.t_ms });
  }

  // ---- Bước 1: Ghi chú từng nhóm keyframe ----

  const notes: string[] = [];
  let failedGroups = 0;
  let lastNotesError: string | null = null;
  const notesSystemPrompt = buildNotesSystemPrompt();
  const totalFrames = localPaths.filter((p) => p !== '').length;
  const totalGroups = Math.ceil(keyframes.length / frames_per_note);
  if (keyframes.length > 0 && totalFrames === 0) {
    throw new Error(`scan.ai: none of the ${keyframes.length} keyframe(s) could be downloaded`);
  }

  for (let gi = 0; gi < totalGroups; gi++) {
    await ctx.yieldToInteractive();
    ctx.progress(Math.round(10 + (gi / totalGroups) * 50), `notes_group_${gi}`);

    const start = gi * frames_per_note;
    const end = Math.min(start + frames_per_note, keyframes.length);

    const traceImagesForGroup: Array<{ input: string; t_ms: number }> = [];
    const images: string[] = [];

    for (let ji = start; ji < end; ji++) {
      const lp = localPaths[ji] ?? '';
      if (!lp) continue;
      try {
        images.push(await imageToBase64(lp));
        traceImagesForGroup.push({ input: keyframes[ji]!.input, t_ms: keyframes[ji]!.t_ms });
      } catch (e) {
        log.warn('Failed to encode keyframe', { error: String(e) });
      }
    }

    const tStart = keyframes[start]?.t_ms ?? 0;
    const tEnd = keyframes[Math.min(end - 1, keyframes.length - 1)]?.t_ms ?? 0;

    const userContent = `Nhóm keyframe ${gi + 1}/${totalGroups} (t=${tStart}ms–${tEnd}ms, ${images.length} ảnh). Hãy mô tả ngắn gọn bằng tiếng Việt.`;
    const messages: OllamaMessage[] = [
      { role: 'system', content: notesSystemPrompt },
      {
        role: 'user',
        content: userContent,
        images: images.length > 0 ? images : undefined,
      },
    ];

    const traceMessages: TraceMessage[] = [
      { role: 'system', content: notesSystemPrompt, images: [] },
      { role: 'user', content: userContent, images: traceImagesForGroup },
    ];

    const traceOptions: Record<string, unknown> = { temperature: 0, num_predict: 1024, keep_alive };
    const callStartedAt = new Date().toISOString();

    let note = '';
    let callResult: OllamaCallResult | null = null;
    let callError: string | null = null;
    try {
      callResult = await callOllama(ollamaUrl, model, messages, keep_alive, ctx.signal, { numPredict: 1024 });
      note = callResult.content;
    } catch (e) {
      callError = String(e);
      lastNotesError = callError;
      failedGroups++;
      log.warn(`Notes call failed for group ${gi}`, { error: callError });
      note = `(nhóm ${gi + 1}: không đọc được)`;
    }

    traceCalls.push({
      step: 'notes',
      group: gi,
      attempt: 1,
      started_at: callStartedAt,
      messages: traceMessages,
      options: traceOptions,
      response: callResult !== null ? callResult.content : null,
      error: callError,
      accepted: callError === null,
      done_reason: callResult?.done_reason ?? null,
      prompt_eval_count: callResult?.prompt_eval_count ?? null,
      eval_count: callResult?.eval_count ?? null,
      total_duration_ms: callResult?.total_duration_ms ?? null,
    });

    // AiManifest caps each note at 2000 characters; a chatty model must not fail the whole job
    notes.push(note.trim().slice(0, 2000));
    log.info(`Note group ${gi + 1}/${totalGroups}`, { length: note.length });
  }

  log.info('Notes step done', { groups: notes.length, failedGroups, totalFrames });

  // Không nhóm nào đọc được → ghi lỗi vào ai.json, upload trace, để farm thử lại.
  if (failedGroups > 0 && failedGroups === notes.length) {
    const error = `scan.ai: every notes call failed (${failedGroups} group(s)): ${lastNotesError ?? 'unknown'}`;
    const manifest = AiManifestSchema.parse({
      schema: AI_MANIFEST_SCHEMA,
      asset_id,
      model,
      prompt_version,
      description: null,
      notes,
      error: error.slice(0, 2000),
      duration_ms: Date.now() - t0,
    } satisfies AiManifest);
    await tryUploadTrace(ctx, log, traceCalls, asset_id, model, prompt_version);
    await ctx.uploadJson(AI_MANIFEST_PATH, manifest);
    throw new Error(error);
  }

  // ---- Bước 2: Tóm tắt toàn video ----

  await ctx.yieldToInteractive();
  ctx.progress(65, 'summary');

  const jsonSchema = getAssetDescriptionJsonSchema();
  const summarySystemPrompt = buildSummarySystemPrompt(context, media);

  // Chọn tối đa 4 keyframe đại diện rải đều
  const validPaths = localPaths.filter((p) => p !== '');
  const summaryFramePaths = pickEvenly(validPaths, 4);
  const summaryImages: string[] = [];
  for (const lp of summaryFramePaths) {
    try {
      summaryImages.push(await imageToBase64(lp));
    } catch { /**/ }
  }

  // Trace images cho bước summary (input refs, không base64)
  const summaryTraceImages = summaryFramePaths.map(
    (lp) => pathToKfRef.get(lp) ?? { input: lp, t_ms: 0 },
  );

  const notesText = notes.map((n, i) => `Nhóm ${i + 1}: ${n}`).join('\n');
  const summaryUserContent = `Dưới đây là ghi chú các nhóm keyframe của video:\n\n${notesText}\n\nHãy viết mô tả tổng hợp cho cả video theo JSON schema.`;

  const summaryMessages: OllamaMessage[] = [
    { role: 'system', content: summarySystemPrompt },
    {
      role: 'user',
      content: summaryUserContent,
      images: summaryImages.length > 0 ? summaryImages : undefined,
    },
  ];

  /** Trace messages song song với summaryMessages (không có base64). */
  const summaryTraceMessages: TraceMessage[] = [
    { role: 'system', content: summarySystemPrompt, images: [] },
    { role: 'user', content: summaryUserContent, images: summaryTraceImages },
  ];

  let description: AiManifest['description'] = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= repair_attempts; attempt++) {
    await ctx.yieldToInteractive();

    const traceOptions: Record<string, unknown> = {
      temperature: 0,
      num_predict: 1536,
      keep_alive,
      format: jsonSchema,
    };
    const callStartedAt = new Date().toISOString();
    // Snapshot các trace messages tại thời điểm gọi (trước khi repair thêm vào)
    const snapshotTraceMessages: TraceMessage[] = summaryTraceMessages.map((m) => ({ ...m, images: [...m.images] }));

    let raw = '';
    let summaryCallResult: OllamaCallResult | null = null;
    let summaryCallError: string | null = null;
    let accepted = false;

    try {
      summaryCallResult = await callOllama(
        ollamaUrl, model, summaryMessages, keep_alive, ctx.signal,
        { format: jsonSchema, numPredict: 1536 },
      );
      raw = summaryCallResult.content;
      const parsed = attemptJsonRepair(raw);
      const validated = AssetDescriptionSchema.safeParse(parsed);
      const problems = validated.success ? descriptionProblems(validated.data) : [];
      if (validated.success && (problems.length === 0 || attempt === repair_attempts)) {
        // Out of repair rounds: keep the description, cleaned, rather than fail a video over a stray character.
        description = problems.length ? cleanDescription(validated.data) : validated.data;
        if (problems.length) log.warn('Description kept after cleaning', { problems });
        lastError = null;
        accepted = true;
      } else if (validated.success) {
        lastError = `Description problems (attempt ${attempt}): ${problems.join('; ')}`;
        log.warn(lastError);
        summaryMessages.push({ role: 'assistant', content: raw });
        summaryMessages.push({
          role: 'user',
          content: `Mô tả chưa đạt: ${problems.join('; ')}. Viết lại toàn bộ JSON, chỉ dùng tiếng Việt có dấu (summary_en bằng tiếng Anh), không dùng chữ Hán, Nhật hay Hàn; title_vi ngắn gọn, tối đa ${TITLE_MAX_CHARS} ký tự.`,
        });
        summaryTraceMessages.push({ role: 'assistant', content: raw, images: [] });
        summaryTraceMessages.push({
          role: 'user',
          content: `Mô tả chưa đạt: ${problems.join('; ')}. Viết lại toàn bộ JSON, chỉ dùng tiếng Việt có dấu (summary_en bằng tiếng Anh), không dùng chữ Hán, Nhật hay Hàn; title_vi ngắn gọn, tối đa ${TITLE_MAX_CHARS} ký tự.`,
          images: [],
        });
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
          summaryTraceMessages.push({ role: 'assistant', content: raw, images: [] });
          summaryTraceMessages.push({
            role: 'user',
            content: `JSON không hợp lệ. Lỗi: ${validated.error.message}. Hãy sửa và trả lại JSON đúng schema.`,
            images: [],
          });
        }
      }
    } catch (e) {
      summaryCallError = String(e);
      lastError = summaryCallError;
      log.warn(`Summary Ollama call failed (attempt ${attempt})`, { error: summaryCallError });
      if (ctx.signal.aborted) {
        traceCalls.push({
          step: 'summary', group: null, attempt: attempt + 1,
          started_at: callStartedAt, messages: snapshotTraceMessages, options: traceOptions,
          response: null, error: summaryCallError, accepted: false,
          done_reason: null, prompt_eval_count: null, eval_count: null, total_duration_ms: null,
        });
        break;
      }
    }

    traceCalls.push({
      step: 'summary',
      group: null,
      attempt: attempt + 1,
      started_at: callStartedAt,
      messages: snapshotTraceMessages,
      options: traceOptions,
      response: summaryCallResult !== null ? raw : null,
      error: summaryCallError,
      accepted,
      done_reason: summaryCallResult?.done_reason ?? null,
      prompt_eval_count: summaryCallResult?.prompt_eval_count ?? null,
      eval_count: summaryCallResult?.eval_count ?? null,
      total_duration_ms: summaryCallResult?.total_duration_ms ?? null,
    });

    if (accepted) break;
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

  // Upload trace trước ai.json (best-effort: 403 từ ag-go cũ không làm fail job)
  await tryUploadTrace(ctx, log, traceCalls, asset_id, model, prompt_version);
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

/** Upload ai-trace.json – best-effort: lỗi không làm fail job. */
async function tryUploadTrace(
  ctx: JobContext,
  log: JobContext['log'],
  calls: TraceCall[],
  asset_id: string,
  model: string,
  prompt_version: string,
): Promise<void> {
  try {
    const trace: AiTrace = AiTraceSchema.parse({
      schema: AI_TRACE_SCHEMA,
      asset_id,
      model,
      prompt_version,
      calls,
    });
    await ctx.uploadJson(AI_TRACE_PATH, trace);
  } catch (e) {
    log.warn('Failed to upload ai-trace.json (best-effort, continuing)', { error: String(e) });
  }
}

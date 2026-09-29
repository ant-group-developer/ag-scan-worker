/**
 * Đánh giá bộ golden: đọc golden.json, chạy Ollama mô tả từng đoạn,
 * so sánh với câu trả lời đúng, xuất CSV + JSON report.
 *
 * Dùng:
 *   ts-node src/eval/run_golden.ts [--golden <path>] [--model <model>] [--out <dir>]
 */
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SegmentDescriptionSchema } from '@ag-farm/protocol';
import type { SegmentDescription } from '@ag-farm/protocol';

// ---- Schemas ----

const GoldenItemSchema = z.object({
  segment_id: z.string(),
  index: z.number(),
  keyframe_paths: z.array(z.string()).min(1),
  expected: SegmentDescriptionSchema.partial().optional(),
  notes: z.string().optional(),
});

const GoldenFileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  ollama_url: z.string().default('http://localhost:11434'),
  items: z.array(GoldenItemSchema).min(1),
});

type GoldenItem = z.infer<typeof GoldenItemSchema>;

// ---- Ollama gọi ----

function getSegmentJsonSchema(): object {
  if (typeof (z as unknown as { toJSONSchema?: (s: unknown) => object }).toJSONSchema === 'function') {
    return (z as unknown as { toJSONSchema: (s: unknown) => object }).toJSONSchema(SegmentDescriptionSchema);
  }
  return {
    type: 'object',
    required: ['caption_vi', 'caption_en', 'tags', 'keywords_vi', 'subjects', 'actions',
      'shot_size', 'camera_motion', 'time_of_day', 'setting', 'people_count',
      'visible_text', 'has_watermark', 'usable', 'usable_reason', 'quality'],
    properties: {
      caption_vi: { type: 'string' },
      caption_en: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      keywords_vi: { type: 'array', items: { type: 'string' } },
      subjects: { type: 'array', items: { type: 'string' } },
      actions: { type: 'array', items: { type: 'string' } },
      shot_size: { type: 'string' },
      camera_motion: { type: 'string' },
      time_of_day: { type: 'string' },
      setting: { type: 'string' },
      people_count: { type: 'string' },
      visible_text: { type: 'string' },
      has_watermark: { type: 'boolean' },
      usable: { type: 'boolean' },
      usable_reason: { type: 'string' },
      quality: { type: 'integer' },
    },
  };
}

async function imageToBase64(path: string): Promise<{ data: string; mimeType: string }> {
  const buf = readFileSync(path);
  const ext = path.split('.').pop()?.toLowerCase() ?? 'jpg';
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  return { data: buf.toString('base64'), mimeType: mimeMap[ext] ?? 'image/jpeg' };
}

async function describeSegment(
  ollamaUrl: string,
  model: string,
  item: GoldenItem,
  jsonSchema: object,
): Promise<{ raw: string; parsed: SegmentDescription | null; error: string | null; durationMs: number }> {
  const t0 = Date.now();

  const imageContents: Array<object> = [];
  for (const kfPath of item.keyframe_paths) {
    try {
      const { data, mimeType } = await imageToBase64(kfPath);
      imageContents.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } });
    } catch (e) {
      console.warn(`  Không đọc được ảnh ${kfPath}: ${e}`);
    }
  }

  if (imageContents.length === 0) {
    return { raw: '', parsed: null, error: 'No images', durationMs: Date.now() - t0 };
  }

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Bạn là chuyên gia phân tích footage video. Mô tả đoạn video theo JSON schema.',
      },
      {
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: `Mô tả đoạn video này (index=${item.index}). Trả lời theo JSON schema.` },
        ],
      },
    ],
    stream: false,
    format: jsonSchema,
    options: { temperature: 0 },
    keep_alive: '2m',
  };

  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { raw: '', parsed: null, error: `HTTP ${res.status}: ${t.slice(0, 300)}`, durationMs: Date.now() - t0 };
    }

    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content ?? '';

    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(raw);
    } catch {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        try { jsonParsed = JSON.parse(raw.slice(start, end + 1)); } catch { /**/ }
      }
    }

    if (!jsonParsed) {
      return { raw, parsed: null, error: 'Cannot parse JSON', durationMs: Date.now() - t0 };
    }

    const validated = SegmentDescriptionSchema.safeParse(jsonParsed);
    if (!validated.success) {
      return { raw, parsed: null, error: validated.error.message, durationMs: Date.now() - t0 };
    }

    return { raw, parsed: validated.data, error: null, durationMs: Date.now() - t0 };
  } catch (e) {
    return { raw: '', parsed: null, error: String(e), durationMs: Date.now() - t0 };
  }
}

// ---- So sánh kết quả với expected ----

interface CompareResult {
  fields_checked: number;
  fields_match: number;
  mismatches: Array<{ field: string; expected: unknown; got: unknown }>;
}

function compareWithExpected(
  parsed: SegmentDescription,
  expected: Partial<SegmentDescription>,
): CompareResult {
  const mismatches: CompareResult['mismatches'] = [];
  let checked = 0;
  let matched = 0;

  for (const [key, expVal] of Object.entries(expected)) {
    checked++;
    const gotVal = (parsed as Record<string, unknown>)[key];
    // So sánh đơn giản: exact match cho scalar, overlap cho array
    let match = false;
    if (Array.isArray(expVal) && Array.isArray(gotVal)) {
      const expSet = new Set(expVal as string[]);
      const gotSet = new Set(gotVal as string[]);
      const overlap = [...expSet].filter((v) => gotSet.has(v));
      match = overlap.length > 0;
    } else {
      match = JSON.stringify(gotVal) === JSON.stringify(expVal);
    }

    if (match) matched++;
    else mismatches.push({ field: key, expected: expVal, got: gotVal });
  }

  return { fields_checked: checked, fields_match: matched, mismatches };
}

// ---- CSV export ----

function toCsvRow(fields: string[]): string {
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',');
}

// ---- Main ----

function parseArgs(): { golden: string; model: string; outDir: string } {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1]! : fallback;
  };
  return {
    golden: get('--golden', 'golden.json'),
    model: get('--model', 'qwen2.5vl:7b'),
    outDir: get('--out', 'eval-output'),
  };
}

async function main(): Promise<void> {
  const { golden: goldenPath, model, outDir } = parseArgs();

  console.log(`Đọc golden: ${goldenPath}`);
  const goldenRaw = JSON.parse(readFileSync(goldenPath, 'utf8')) as unknown;
  const goldenFile = GoldenFileSchema.parse(goldenRaw);

  const ollamaUrl = goldenFile.ollama_url;
  const jsonSchema = getSegmentJsonSchema();
  mkdirSync(outDir, { recursive: true });

  console.log(`Golden: ${goldenFile.name} (${goldenFile.items.length} mục)`);
  console.log(`Model: ${model}, Ollama: ${ollamaUrl}`);
  console.log('');

  interface ReportItem {
    segment_id: string;
    index: number;
    success: boolean;
    error: string | null;
    duration_ms: number;
    caption_vi: string;
    caption_en: string;
    quality: number | null;
    usable: boolean | null;
    fields_match: number;
    fields_checked: number;
    mismatches: string;
  }

  const reportItems: ReportItem[] = [];
  let successCount = 0;
  let totalMatch = 0;
  let totalChecked = 0;

  for (let i = 0; i < goldenFile.items.length; i++) {
    const item = goldenFile.items[i]!;
    process.stdout.write(`[${i + 1}/${goldenFile.items.length}] segment ${item.index} ... `);

    const result = await describeSegment(ollamaUrl, model, item, jsonSchema);

    if (result.parsed) {
      successCount++;
      const compare = item.expected
        ? compareWithExpected(result.parsed, item.expected)
        : { fields_checked: 0, fields_match: 0, mismatches: [] };

      totalMatch += compare.fields_match;
      totalChecked += compare.fields_checked;

      console.log(`OK (${result.durationMs}ms, match ${compare.fields_match}/${compare.fields_checked})`);

      reportItems.push({
        segment_id: item.segment_id,
        index: item.index,
        success: true,
        error: null,
        duration_ms: result.durationMs,
        caption_vi: result.parsed.caption_vi,
        caption_en: result.parsed.caption_en,
        quality: result.parsed.quality,
        usable: result.parsed.usable,
        fields_match: compare.fields_match,
        fields_checked: compare.fields_checked,
        mismatches: compare.mismatches.map((m) => `${m.field}:${JSON.stringify(m.expected)}→${JSON.stringify(m.got)}`).join('; '),
      });
    } else {
      console.log(`LỖI: ${result.error}`);
      reportItems.push({
        segment_id: item.segment_id,
        index: item.index,
        success: false,
        error: result.error,
        duration_ms: result.durationMs,
        caption_vi: '',
        caption_en: '',
        quality: null,
        usable: null,
        fields_match: 0,
        fields_checked: item.expected ? Object.keys(item.expected).length : 0,
        mismatches: '',
      });
    }
  }

  // CSV
  const csvPath = join(outDir, 'report.csv');
  const csvHeader = toCsvRow(['segment_id', 'index', 'success', 'error', 'duration_ms',
    'caption_vi', 'caption_en', 'quality', 'usable', 'fields_match', 'fields_checked', 'mismatches']);
  const csvRows = reportItems.map((r) => toCsvRow([
    r.segment_id, String(r.index), String(r.success), r.error ?? '',
    String(r.duration_ms), r.caption_vi, r.caption_en,
    r.quality !== null ? String(r.quality) : '',
    r.usable !== null ? String(r.usable) : '',
    String(r.fields_match), String(r.fields_checked), r.mismatches,
  ]));
  writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'), 'utf8');

  // JSON
  const jsonPath = join(outDir, 'report.json');
  writeFileSync(jsonPath, JSON.stringify({
    golden: goldenFile.name,
    model,
    ollama_url: ollamaUrl,
    run_at: new Date().toISOString(),
    summary: {
      total: goldenFile.items.length,
      success: successCount,
      failed: goldenFile.items.length - successCount,
      field_match_rate: totalChecked > 0 ? (totalMatch / totalChecked).toFixed(3) : null,
    },
    items: reportItems,
  }, null, 2), 'utf8');

  console.log('');
  console.log(`=== Tổng kết ===`);
  console.log(`Tổng: ${goldenFile.items.length}, OK: ${successCount}, lỗi: ${goldenFile.items.length - successCount}`);
  if (totalChecked > 0) {
    console.log(`Field match rate: ${totalMatch}/${totalChecked} (${(totalMatch / totalChecked * 100).toFixed(1)}%)`);
  }
  console.log(`Report CSV: ${csvPath}`);
  console.log(`Report JSON: ${jsonPath}`);
}

main().catch((err) => {
  console.error('Lỗi run_golden:', err);
  process.exit(1);
});

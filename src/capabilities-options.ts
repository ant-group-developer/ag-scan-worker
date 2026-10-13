/**
 * Phép dò năng lực của máy quét, bằng đúng các binary/dịch vụ handler dùng: ffmpeg kèm trong gói (`ffmpeg-static`;
 * máy worker thường không có ffmpeg trên PATH, dò PATH thì máy khai `ffmpeg: null` và NVENC false) và Ollama ở
 * `extra.ollama_url`.
 */
import type { CapabilitiesOptions } from '@ag-farm/worker-sdk';
import { resolveFfmpeg } from './ffmpeg-utils';

export function scanCapabilitiesOptions(extra: Record<string, unknown> | undefined): CapabilitiesOptions {
  const ollamaUrl = typeof extra?.['ollama_url'] === 'string' ? extra['ollama_url'] : undefined;
  return { ffmpegPath: resolveFfmpeg(), ...(ollamaUrl ? { ollamaUrl } : {}) };
}

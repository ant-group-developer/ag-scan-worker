import { scanCapabilitiesOptions } from './capabilities-options';
import { resolveFfmpeg } from './ffmpeg-utils';

describe('scanCapabilitiesOptions', () => {
  it('probes the bundled ffmpeg, not a bare ffmpeg on PATH', () => {
    const opts = scanCapabilitiesOptions({});
    expect(opts.ffmpegPath).toBe(resolveFfmpeg());
    expect(opts.ffmpegPath).toMatch(/[\\/]ffmpeg(\.exe)?$/);
  });

  it('asks Ollama where the handler does', () => {
    expect(scanCapabilitiesOptions({ ollama_url: 'http://127.0.0.1:11434' }).ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(scanCapabilitiesOptions(undefined).ollamaUrl).toBeUndefined();
  });
});

/**
 * Điểm vào chính cho ag-scan-worker.
 * Dùng: ag-scan-worker --config <đường dẫn YAML>
 */
import { constants as osConstants, setPriority } from 'node:os';
import { runWorker, loadConfig } from '@ag-farm/worker-sdk';
import { handleScanExtract } from './scan-extract';
import { createScanAiHandler } from './scan-ai';

// ---- Parse args ----

function getConfigPath(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  if (idx === -1 || idx + 1 >= args.length) {
    console.error('Dung: ag-scan-worker --config <duong dan file YAML>');
    process.exit(1);
  }
  return args[idx + 1]!;
}

// ---- Main ----

async function main(): Promise<void> {
  const configPath = getConfigPath();
  const config = loadConfig(configPath);

  // Ghi version từ package.json
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../package.json') as { version?: string };
  const version = pkg.version ?? '0.0.0';

  console.log(`ag-scan-worker v${version} khoi dong voi config: ${configPath}`);

  // Quét là việc nền: chạy dưới mức ưu tiên thường để render trên cùng máy không bị giành CPU.
  // ffmpeg con thừa hưởng mức này (Windows: BELOW_NORMAL_PRIORITY_CLASS).
  try {
    setPriority(osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    console.warn('Khong ha duoc muc uu tien tien trinh:', err);
  }

  const extra = config.extra ?? {};
  const ollamaUrl = typeof extra['ollama_url'] === 'string' ? extra['ollama_url'] : undefined;

  await runWorker({
    config,
    version,
    handlers: {
      'scan.extract': handleScanExtract,
      'scan.ai': createScanAiHandler({ ollamaUrl }),
    },
  });
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});

/**
 * Điểm vào chính cho ag-scan-worker.
 * Dùng: ag-scan-worker --config <đường dẫn YAML>
 */
import { runWorker, loadConfig } from '@ag-farm/worker-sdk';
import { handleScanExtract } from './scan-extract';
import { handleScanAi } from './scan-ai';

// ---- Parse args ----

function getConfigPath(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  if (idx === -1 || idx + 1 >= args.length) {
    console.error('Dùng: ag-scan-worker --config <đường dẫn file YAML>');
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

  console.log(`ag-scan-worker v${version} khởi động với config: ${configPath}`);

  await runWorker({
    config,
    version,
    handlers: {
      'scan.extract': handleScanExtract,
      'scan.ai': handleScanAi,
    },
  });
}

main().catch((err) => {
  console.error('Worker crashed:', err);
  process.exit(1);
});

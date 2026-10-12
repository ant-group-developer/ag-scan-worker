# ag-scan-worker

Worker quét footage cho máy cấu hình cao trong hệ thống [ag-farm](https://github.com/your-org/ag-farm).  
Xử lý hai loại job: **scan.extract** (proxy + phát hiện cảnh + keyframe cả video) và **scan.ai** (Ollama Qwen-VL mô tả cả video).

> **v2**: scan.extract không còn chia đoạn footage — nó mô tả cả file. Cảnh chỉ dùng để chọn keyframe đại diện.
> scan.ai làm việc theo hai bước: ghi chú từng nhóm keyframe rồi viết một `AssetDescription` cho cả video.

---

## Cài trên máy worker (Windows)

Không cài tay. Trang **Máy** của web farm → **Thêm máy** cho một lệnh; dán vào PowerShell mở bằng
"Run as Administrator":

```powershell
iwr https://<farm>/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub https://<farm> -Code <mã>
```

Cập nhật lên bản mới: cùng lệnh, bỏ `-Code`. Installer tải gói (có sẵn Node, ffmpeg, sharp), tính slot
(`C:\ProgramData\ag-farm\machine.yaml`), cài Ollama thành task hệ thống `ag-farm-ollama` và kéo model hub cấu hình
(`FARM_OLLAMA_MODELS`, hoặc `-Model`), rồi chạy worker bằng task `ag-farm-scan` (tài khoản SYSTEM, tự chạy khi bật máy,
chết thì chạy lại). Log: `C:\ag-farm\scan\logs\worker.log`.

Sau mỗi lần cài/cập nhật, `C:\ag-farm\scan\config.yaml` được ghi lại: giữ `name`, `token`, `hub_url`, `cache`,
`schedule` và mọi khoá anh tự thêm (kể cả trong `extra`); viết lại khoá installer quản lý (`extra.ollama_url`); bỏ danh
sách `kinds`. Bản trước lưu ở `config.yaml.bak`.

### Loại job máy nhận

Không khai `kinds`: worker báo mọi loại job nó có handler **và** máy đủ điều kiện theo `JOB_TYPE_SPECS` (`scan.ai` cần
GPU), dò lúc worker khởi động. Không muốn máy nhận một loại: tắt công tắc của loại đó ở trang **Máy**. `kinds` trong
config vẫn dùng được để ép danh sách (giao với handler).

Cách cài cũ bằng NSSM/WinSW (dịch vụ `ag-scan-worker`, Ollama chạy bằng NSSM) không dùng nữa; installer tự gỡ dịch vụ
NSSM cũ.

---

## Phát triển (máy dev)

| Thành phần | Phiên bản tối thiểu |
|---|---|
| Node.js | 22+ |
| ffmpeg | lấy từ `ffmpeg-static` (hoặc `FFMPEG_PATH`); có `h264_nvenc`, `cuda` thì dùng |
| Ollama | 0.3+ (cho scan.ai) |
| RAM | 8 GB+ |
| GPU | NVIDIA (scan.ai; tăng tốc encode/decode) |

```bash
git clone ... ag-scan-worker
cd ag-scan-worker
yarn install
yarn build
```

### config.yaml

```yaml
hub_url: https://farm.example.com
token: your-node-token-here          # hoặc dùng token_file
name: scan-dev
# kinds: [scan.extract]              # tuỳ chọn: ép danh sách; bỏ trống = mọi loại máy chạy được

work_dir: 'C:\ag-dev\scan\work'
cache:
  dir: 'C:\ag-dev\scan\cache'
  max_gb: 50
machine_file: 'C:\ProgramData\ag-farm\machine.yaml'

# Lịch chạy tuần (tuỳ chọn; vắng mặt = 24/7)
schedule:
  - days: [1, 2, 3, 4, 5]           # Thứ 2–6
    from: "19:00"
    to:   "07:00"                    # Qua đêm

extra:
  ollama_url: http://localhost:11434
```

### machine.yaml

```yaml
cpu_slots: 4
gpu_slots: 1

reserve_interactive:
  cpu: 1
  gpu: 0
```

**`cpu_slots`**: số job CPU chạy đồng thời.  
**`gpu_slots`**: số job GPU (scan.extract có proxy, scan.ai).  
**`reserve_interactive`**: số slot giữ lại cho lane `interactive` (Studio đang chờ).

```bash
node dist/main.js --config config.yaml
```

### Linux (systemd, cài tay)

Installer chỉ có cho Windows.

```ini
# /etc/systemd/system/ag-scan-worker.service
[Unit]
Description=AG Farm Scan Worker
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=ag-farm
WorkingDirectory=/opt/ag-scan-worker
ExecStart=/usr/bin/node dist/main.js --config /etc/ag-farm/scan-worker.yaml
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## Bundle (tạo file .cjs đơn)

```bash
yarn bundle
# → dist/ag-scan-worker.cjs (sharp, ffmpeg-static, worker-sdk là external)
```

---

## Test

```bash
# Unit tests (không cần ffmpeg)
yarn test src/segmentation.spec.ts

# Integration tests (cần ffmpeg trong PATH hoặc ffmpeg-static)
yarn test src/ffmpeg-integration.spec.ts

# E2E handler tests
yarn test src/scan-extract.spec.ts
yarn test src/scan-ai.spec.ts

# Tất cả
yarn test
```

---

## Golden set (đánh giá mô tả AI)

`src/eval/run_golden.ts` đã bị bỏ trong v2 (xem comment trong file). Công cụ đánh giá mới
(`run_golden_v2.ts`) cần viết lại khi schema `AssetDescription` và prompt ổn định.

---

## Biến môi trường

| Biến | Mô tả |
|---|---|
| `FFMPEG_PATH` | Đường dẫn ffmpeg (ưu tiên hơn ffmpeg-static) |
| `FFPROBE_PATH` | Đường dẫn ffprobe |
| `NODE_ENV` | `production` khi chạy bundle |

---

## Kiến trúc

```
ag-scan-worker
├── src/
│   ├── main.ts            # CLI entry point
│   ├── scan-extract.ts    # Handler scan.extract
│   ├── scan-ai.ts         # Handler scan.ai
│   ├── segmentation.ts    # Thuần: chia đoạn + gộp dHash
│   ├── ffmpeg-utils.ts    # Wrappers ffmpeg/ffprobe
│   ├── dhash.ts           # dHash 64-bit qua sharp
│   └── eval/
│       └── run_golden.ts  # Đánh giá golden set
└── dist/
    └── main.js            # Build output
```

**Luồng scan.extract** (v2):
1. Tải file nguồn `source` (cache nếu có cache_key): file gốc, hoặc bản preview sạch 720p–1080p
   chủ sở hữu đưa thay khi có (cùng timeline và audio, nhỏ hơn nhiều)
2. ffprobe → media info
3. ffmpeg proxy 720p (H.264 CRF, NVDEC nếu có); bỏ qua khi cạnh ngắn của nguồn ≤ `proxy.height`
4. Dò cảnh trên proxy (hoặc thẳng trên nguồn khi không có proxy) → danh sách scenes (gộp cảnh ngắn hơn `min_scene_s`)
5. Trích một keyframe đại diện mỗi cảnh (giữa cảnh); cạnh dài = `keyframe_px`; bỏ trùng dHash
6. Chỉ số kỹ thuật cả video (một lần): brightness, blur, black, freeze, silence
7. Contact sheet (tiles giữ tỉ lệ, không cắt)
8. Upload tất cả → upload `extract.json` (schema `ag.scan.extract/v2`)

**Luồng scan.ai** (v2):
1. Tải tất cả keyframe từ artifact
2. **Bước 1 – Ghi chú**: xem keyframe theo nhóm `frames_per_note`, viết ghi chú tiếng Việt cho mỗi nhóm
3. **Bước 2 – Tóm tắt**: dùng tất cả ghi chú + tối đa 4 keyframe đại diện + ngữ cảnh → `AssetDescription` JSON
4. Validate `AssetDescriptionSchema`; repair loop nếu sai JSON
5. Upload `ai.json` (schema `ag.scan.ai/v2`); ném lỗi retryable nếu mô tả thất bại

# ag-scan-worker

Worker quét footage cho máy cấu hình cao trong hệ thống [ag-farm](https://github.com/your-org/ag-farm).  
Xử lý hai loại job: **scan.extract** (proxy + phát hiện cảnh + keyframe cả video) và **scan.ai** (Ollama Qwen-VL mô tả cả video).

> **v2**: scan.extract không còn chia đoạn footage — nó mô tả cả file. Cảnh chỉ dùng để chọn keyframe đại diện.
> scan.ai làm việc theo hai bước: ghi chú từng nhóm keyframe rồi viết một `AssetDescription` cho cả video.

---

## Yêu cầu hệ thống

| Thành phần | Phiên bản tối thiểu |
|---|---|
| Node.js | 22+ |
| ffmpeg | 6.0+ (có `libx264`, tùy chọn `h264_nvenc`, `cuda`) |
| Ollama | 0.3+ (cho scan.ai) |
| RAM | 8 GB+ |
| GPU | NVIDIA (tùy chọn, tăng tốc encode/decode) |

---

## Cài đặt

```bash
# Clone repo
git clone ... ag-scan-worker
cd ag-scan-worker

# Cài dependencies
yarn install

# Build TypeScript
yarn build
```

---

## Cấu hình

### config.yaml

```yaml
hub_url: https://farm.example.com
token: your-node-token-here          # hoặc dùng token_file

name: scan-worker-001
kinds:
  - scan.extract
  - scan.ai

work_dir: C:\ag-farm\work            # Windows
# work_dir: /var/ag-farm/work        # Linux

cache:
  dir: C:\ag-farm\cache
  max_gb: 50

machine_file: C:\ProgramData\ag-farm\machine.yaml

# Lịch chạy tuần (tuỳ chọn; vắng mặt = 24/7)
schedule:
  - days: [1, 2, 3, 4, 5]           # Thứ 2–6
    from: "19:00"
    to:   "07:00"                    # Qua đêm
  - days: [0, 6]                    # Cuối tuần
    from: "00:00"
    to:   "23:59"

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

---

## Chạy thủ công

```bash
# Chạy từ source (phát triển)
npx ts-node src/main.ts --config config.yaml

# Chạy từ bản build
node dist/main.js --config config.yaml
```

---

## Cài dịch vụ Windows (NSSM)

[NSSM](https://nssm.cc) quản lý process như Windows Service:

```powershell
# Cài NSSM (Chocolatey)
choco install nssm -y

# Tạo service
nssm install ag-scan-worker "C:\Program Files\nodejs\node.exe"
nssm set ag-scan-worker AppParameters "E:\ag-scan-worker\dist\main.js --config E:\ag-scan-worker\config.yaml"
nssm set ag-scan-worker AppDirectory "E:\ag-scan-worker"
nssm set ag-scan-worker DisplayName "AG Farm Scan Worker"
nssm set ag-scan-worker Description "Worker quét footage ag-farm"
nssm set ag-scan-worker Start SERVICE_AUTO_START

# Khởi động
nssm start ag-scan-worker

# Xem log
nssm status ag-scan-worker
```

Hoặc dùng **WinSW**:

```xml
<!-- ag-scan-worker.xml -->
<service>
  <id>ag-scan-worker</id>
  <name>AG Farm Scan Worker</name>
  <executable>node</executable>
  <arguments>dist\main.js --config config.yaml</arguments>
  <workingdirectory>E:\ag-scan-worker</workingdirectory>
  <logmode>rotate</logmode>
  <onfailure action="restart" delay="10 sec"/>
</service>
```

```powershell
WinSW.exe install ag-scan-worker.xml
WinSW.exe start ag-scan-worker
```

---

## Cài dịch vụ Linux (systemd)

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable ag-scan-worker
sudo systemctl start ag-scan-worker
journalctl -u ag-scan-worker -f
```

---

## Ollama (Windows Service)

Chạy Ollama như Windows Service để scan.ai hoạt động khi không đăng nhập:

```powershell
# Cài Ollama
winget install Ollama.Ollama

# Cài service dùng NSSM
nssm install ollama "C:\Users\<user>\AppData\Local\Programs\Ollama\ollama.exe"
nssm set ollama AppParameters "serve"
nssm set ollama AppEnvironmentExtra "OLLAMA_MODELS=C:\ag-farm\ollama-models"
nssm set ollama Start SERVICE_AUTO_START
nssm start ollama

# Pull model
ollama pull qwen2.5vl:7b
```

> **OLLAMA_MODELS**: chỉ định thư mục lưu models để tránh đầy ổ C.

---

## Cache – quyền truy cập

Thư mục cache (`cache.dir`) cần được tạo sẵn với quyền đọc/ghi cho user chạy service:

```powershell
# Windows
New-Item -ItemType Directory -Force "C:\ag-farm\cache"
icacls "C:\ag-farm\cache" /grant "NT AUTHORITY\NETWORK SERVICE:(OI)(CI)F"
```

```bash
# Linux
sudo mkdir -p /var/ag-farm/cache
sudo chown ag-farm:ag-farm /var/ag-farm/cache
sudo chmod 755 /var/ag-farm/cache
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
1. Tải file gốc (cache nếu có cache_key)
2. ffprobe → media info
3. ffmpeg proxy 720p (H.264 CRF, NVDEC nếu có)
4. Dò cảnh trên proxy → danh sách scenes (gộp cảnh ngắn hơn `min_scene_s`)
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

# Cài ag-scan-worker thành dịch vụ Windows (NSSM). Chạy trong PowerShell "Run as Administrator",
# đứng ở thư mục đã giải nén (có package.json):
#   powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 [-Nssm C:\tools\nssm.exe] [-ServiceName ag-scan-worker]
param(
  [string]$Nssm = "nssm",
  [string]$ServiceName = "ag-scan-worker"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1. Node 22+
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw "Chưa cài Node.js 22+ (https://nodejs.org)" }
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw "Cần Node.js 22+, đang có $nodeVersion" }
$nodeExe = (Get-Command node).Source

# 2. ffmpeg-static, ffprobe-static
& npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install lỗi" }

# 3. machine.yaml dùng chung cho mọi worker trên máy
$machineDir = "C:\ProgramData\ag-farm"
if (-not (Test-Path "$machineDir\machine.yaml")) {
  New-Item -ItemType Directory -Force $machineDir | Out-Null
  Copy-Item "deploy\machine.example.yaml" "$machineDir\machine.yaml"
  Write-Host "Đã tạo $machineDir\machine.yaml: sửa số slot CPU/GPU cho đúng máy."
}

# 4. config.yaml
if (-not (Test-Path "config.yaml")) {
  Copy-Item "deploy\config.example.yaml" "config.yaml"
  Write-Host "Đã tạo config.yaml từ mẫu. Sửa hub_url, token, thư mục rồi chạy lại script này." -ForegroundColor Yellow
  exit 1
}

# 5. Ollama
try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 5 | Out-Null } catch { Write-Warning "Không gọi được Ollama ở http://localhost:11434: job scan.ai sẽ lỗi" }

# 6. Dịch vụ
if (-not (Get-Command $Nssm -ErrorAction SilentlyContinue)) { throw "Không thấy NSSM ($Nssm). Cài từ https://nssm.cc rồi truyền -Nssm <đường dẫn nssm.exe>" }
New-Item -ItemType Directory -Force "logs" | Out-Null
& $Nssm stop $ServiceName 2>$null | Out-Null
& $Nssm remove $ServiceName confirm 2>$null | Out-Null
& $Nssm install $ServiceName $nodeExe "dist\worker.mjs --config config.yaml"
& $Nssm set $ServiceName AppDirectory $root
& $Nssm set $ServiceName AppStdout "$root\logs\out.log"
& $Nssm set $ServiceName AppStderr "$root\logs\err.log"
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 10485760
# Dừng nhẹ nhàng: cho job đang chạy thời gian kết thúc
& $Nssm set $ServiceName AppStopMethodConsole 120000
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm start $ServiceName
Write-Host "Đã cài và khởi động dịch vụ $ServiceName. Log: $root\logs" -ForegroundColor Green

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
if (-not $nodeVersion) { throw "Chua cai Node.js 22+ (https://nodejs.org)" }
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw "Can Node.js 22+, dang co $nodeVersion" }
$nodeExe = (Get-Command node).Source

# 2. ffmpeg-static, ffprobe-static
& npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install loi" }

# 3. machine.yaml dùng chung cho mọi worker trên máy
$machineDir = "C:\ProgramData\ag-farm"
if (-not (Test-Path "$machineDir\machine.yaml")) {
  New-Item -ItemType Directory -Force $machineDir | Out-Null
  Copy-Item "deploy\machine.example.yaml" "$machineDir\machine.yaml"
  Write-Host "Da tao $machineDir\machine.yaml: sua so slot CPU/GPU cho dung may."
}

# 4. config.yaml
if (-not (Test-Path "config.yaml")) {
  Copy-Item "deploy\config.example.yaml" "config.yaml"
  Write-Host "Da tao config.yaml tu mau. Sua hub_url, token, thu muc roi chay lai script nay." -ForegroundColor Yellow
  exit 1
}

# 5. Ollama
try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 5 | Out-Null } catch { Write-Warning "Khong goi duoc Ollama o http://localhost:11434: job scan.ai se loi" }

# 6. Dịch vụ
if (-not (Get-Command $Nssm -ErrorAction SilentlyContinue)) { throw "Khong thay NSSM ($Nssm). Cai tu https://nssm.cc roi truyen -Nssm <duong dan nssm.exe>" }
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
Write-Host "Da cai va khoi dong dich vu $ServiceName. Log: $root\logs" -ForegroundColor Green

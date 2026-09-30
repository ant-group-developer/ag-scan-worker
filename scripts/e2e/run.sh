#!/usr/bin/env bash
# E2E luồng quét: hub ag-farm (thật) + ag-scan-worker (thật) + chủ job giả ký URL bằng vé.
# Video 3 cảnh (3 s | 3 s | 4 s) phải ra đúng 3 đoạn, cắt tại 3 s và 6 s.
#
# Cần trước: Docker; `yarn build` ở ../ag-farm/apps/api và ở repo này (dist/).
# Chạy (Git Bash): bash scripts/e2e/run.sh
# File làm việc (khoá, log, output) nằm trong thư mục tạm của máy, không nằm trong repo.
set -u
SCRIPT_DIR="$(cygpath -m "$(cd "$(dirname "$0")" && pwd)")"
WORKER="$(cygpath -m "$(cd "$SCRIPT_DIR/../.." && pwd)")"
FARM="${FARM:-$(cygpath -m "$(cd "$WORKER/../ag-farm" && pwd)")}"
SP="$(cygpath -m "${TEMP:-/tmp}")/ag-scan-e2e"
rm -rf "$SP" && mkdir -p "$SP/store" "$SP/work" "$SP/cache" "$SP/machine"
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  (cd "$FARM" && docker compose -f docker-compose.test.yml down >/dev/null 2>&1)
}
trap cleanup EXIT

node -e "
const {generateKeyPairSync,createHash,randomBytes}=require('crypto');const fs=require('fs');
const k=generateKeyPairSync('ed25519');
fs.writeFileSync('$SP/priv.pem',k.privateKey.export({type:'pkcs8',format:'pem'}));
fs.writeFileSync('$SP/pub.pem',k.publicKey.export({type:'spki',format:'pem'}));
const owner=randomBytes(24).toString('base64url'), node=randomBytes(24).toString('base64url');
const h=s=>createHash('sha256').update(s).digest('hex');
fs.writeFileSync('$SP/secrets.env',\`OWNER_KEY=\${owner}\nNODE_TOKEN=\${node}\nOWNER_HASH=\${h(owner)}\nNODE_HASH=\${h(node)}\n\`);"
source "$SP/secrets.env"

FFMPEG=$(node -e "console.log(require('$WORKER/node_modules/ffmpeg-static'))")
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=640x360:rate=25:duration=3 \
  -f lavfi -i smptebars=size=640x360:rate=25:duration=3 \
  -f lavfi -i color=c=0x3366cc:size=640x360:rate=25:duration=4 \
  -filter_complex '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]' -map '[v]' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$SP/source.mp4" || exit 1

cd "$FARM" && docker compose -f docker-compose.test.yml up -d >/dev/null 2>&1
for i in $(seq 1 30); do docker exec ag-farm-postgres-test-1 pg_isready -U farm_test >/dev/null 2>&1 && break; sleep 1; done
docker exec ag-farm-postgres-test-1 psql -U farm_test -d ag_farm_test -c "DROP DATABASE IF EXISTS ag_farm_e2e" -c "CREATE DATABASE ag_farm_e2e" >/dev/null

export DATABASE_URL=postgres://farm_test:farm_test@localhost:55433/ag_farm_e2e
export FARM_TICKET_PRIVATE_KEY="$(cat "$SP/priv.pem")" FARM_TICKET_PUBLIC_KEY="$(cat "$SP/pub.pem")"
export AUTH0_ISSUER_URL=https://x.auth0.com/ AUTH0_AUDIENCE=aud AUTH0_JWKS_URL=https://x.auth0.com/jwks
export AUTH0_ALLOWED_CLIENT_IDS=c ACCOUNT_API_URL=http://127.0.0.1:1 PORT=3978 REAPER_INTERVAL_MS=5000
cd "$FARM/apps/api" && node ../../node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js >/dev/null || exit 1
docker exec ag-farm-postgres-test-1 psql -U farm_test -d ag_farm_e2e -c \
  "INSERT INTO farm_owners (id, key_hash, sign_url, allowed_types, default_lane) VALUES ('ag-go', '$OWNER_HASH', 'http://127.0.0.1:3979/sign', '{scan.extract,scan.ai}', 'batch');" \
  -c "INSERT INTO farm_nodes (name, machine, kinds, token_hash, status) VALUES ('e2e-worker', 'e2e-machine', '{scan.extract}', '$NODE_HASH', 'active');" >/dev/null || exit 1

node dist/main.js > "$SP/hub.log" 2>&1 & pids+=($!)
OWNER_PORT=3979 PUBLIC_KEY_FILE="$SP/pub.pem" SOURCE_FILE="$SP/source.mp4" STORE_DIR="$SP/store" \
  node "$SCRIPT_DIR/fake-owner.cjs" > "$SP/owner.log" 2>&1 & pids+=($!)
for i in $(seq 1 30); do curl -s localhost:3978/health >/dev/null && break; sleep 1; done

cat > "$SP/machine/machine.yaml" <<EOF
cpu_slots: 2
gpu_slots: 0
reserve_interactive: { cpu: 0, gpu: 0 }
EOF
cat > "$SP/worker.yaml" <<EOF
hub_url: http://127.0.0.1:3978
token: $NODE_TOKEN
name: e2e-worker
kinds: [scan.extract]
work_dir: $SP/work
cache: { dir: $SP/cache, max_gb: 1 }
machine_file: $SP/machine/machine.yaml
EOF

JOB=$(curl -s -X POST localhost:3978/v1/owner/jobs -H "Authorization: Owner $OWNER_KEY" -H 'Content-Type: application/json' -d '{
  "type":"scan.extract","correlation_id":"e2e:extract",
  "payload":{"asset":{"id":"123e4567-e89b-42d3-a456-426614174777","kind":"video","mime_type":"video/mp4","size_bytes":null,"checksum_sha256":null,"duration_ms":10000,"width":640,"height":360},"extract_version":"e2e"}}')
JOB_ID=$(node -e "const b=JSON.parse(process.argv[1]);console.log((b.data??b).job.id)" "$JOB") || { echo "submit failed: $JOB"; exit 1; }
echo "submitted $JOB_ID"

# WORKER_RUN_DIR/WORKER_ENTRY: chạy bản phát hành (scripts/release.mjs) thay cho dist/ của repo
cd "${WORKER_RUN_DIR:-$WORKER}" && node "${WORKER_ENTRY:-dist/main.js}" --config "$SP/worker.yaml" > "$SP/worker.log" 2>&1 & pids+=($!)

STATUS=queued
for i in $(seq 1 90); do
  STATUS=$(curl -s localhost:3978/v1/owner/jobs/$JOB_ID -H "Authorization: Owner $OWNER_KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s),j=b.data??b;console.log(j.status+' '+JSON.stringify(j.result||j.error))})")
  case "$STATUS" in completed*|failed*) break;; esac
  sleep 2
done
echo "job: $STATUS"
echo "--- unacked list:"; curl -s "localhost:3978/v1/owner/jobs?status=completed,failed&unacked=1" -H "Authorization: Owner $OWNER_KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s),j=b.data??b;console.log(j.jobs.map(x=>x.id+' '+x.status))})"
echo "--- stored files:"; (cd "$SP/store" && find . -type f | sort | head -20)
if [ -f "$SP/store/extract.json" ]; then
  node -e "const m=require('$SP/store/extract.json');console.log('segments', m.segments.map(s=>[s.start_ms,s.end_ms,s.boundary_reason,s.keyframes.length]));console.log('proxy', m.proxy)"
fi
echo "--- owner log:"; tail -8 "$SP/owner.log"
echo "--- worker log (last):"; tail -8 "$SP/worker.log"

// Chủ job giả cho E2E (scripts/e2e/run.sh): cài sign_url theo hợp đồng ag-farm, lưu file vào thư mục cục bộ.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { verifyTicket, extractTicket, SignRequestSchema } = require(
  path.resolve(__dirname, '../../../ag-farm/packages/protocol'),
);

const PORT = Number(process.env.OWNER_PORT || 3979);
const PUBLIC_KEY = fs.readFileSync(process.env.PUBLIC_KEY_FILE, 'utf8');
const SOURCE = process.env.SOURCE_FILE;
const STORE = process.env.STORE_DIR;
const base = `http://127.0.0.1:${PORT}`;
const uploads = new Map(); // uploadId -> { output, parts: Map<n, Buffer> }
const log = (...a) => console.log('[owner]', ...a);

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const body = await readBody(req);
    if (req.method === 'POST' && url.pathname === '/sign') {
      let claims;
      try {
        claims = verifyTicket(extractTicket(req.headers.authorization) || '', PUBLIC_KEY, { owner: 'ag-go' });
      } catch (e) {
        log('ticket rejected', e.reason);
        return send(res, 401, { error: e.reason });
      }
      const parsed = SignRequestSchema.safeParse(JSON.parse(body.toString()));
      if (!parsed.success) return send(res, 400, { error: 'bad request' });
      const expires_at = new Date(Date.now() + 3600e3).toISOString();
      const results = parsed.data.ops.map((op) => {
        if (op.op === 'get') {
          if (op.input !== 'source') throw new Error('unexpected input ' + op.input);
          return {
            op: 'get', input: op.input, url: `${base}/files/source`, expires_at,
            size_bytes: fs.statSync(SOURCE).size, content_type: 'video/mp4',
            cache_key: 'e2e-source-v1',
            source: { source_kind: 'original', watermarked: false, start_ms: null, end_ms: null },
          };
        }
        if (op.op === 'put') {
          return { op: 'put', output: op.output, url: `${base}/store/${op.output}`, expires_at, headers: { 'Content-Type': op.content_type } };
        }
        if (op.op === 'mp_create') {
          const id = `up-${uploads.size + 1}`;
          uploads.set(id, { output: op.output, parts: new Map() });
          return { op: 'mp_create', output: op.output, upload_id: id };
        }
        if (op.op === 'mp_part_urls') {
          return {
            op: 'mp_part_urls', output: op.output, upload_id: op.upload_id, expires_at,
            urls: op.parts.map((n) => ({ part_number: n, url: `${base}/part/${op.upload_id}/${n}` })),
          };
        }
        if (op.op === 'mp_complete') {
          const up = uploads.get(op.upload_id);
          const buf = Buffer.concat(op.parts.map((p) => up.parts.get(p.part_number)));
          const dest = path.join(STORE, op.output);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
          return { op: 'mp_complete', output: op.output };
        }
        return { op: op.op, output: op.output };
      });
      log('signed', claims.type, parsed.data.ops.map((o) => o.op + ':' + (o.input || o.output)).join(', '));
      return send(res, 200, { results });
    }
    if (req.method === 'GET' && url.pathname === '/files/source') {
      const data = fs.readFileSync(SOURCE);
      const range = req.headers.range && /bytes=(\d+)-/.exec(req.headers.range);
      if (range) {
        const start = Number(range[1]);
        res.writeHead(206, { 'Content-Length': data.length - start, 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` });
        return res.end(data.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': data.length });
      return res.end(data);
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/store/')) {
      const dest = path.join(STORE, decodeURIComponent(url.pathname.slice('/store/'.length)));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      res.writeHead(200, { ETag: '"ok"' });
      return res.end();
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/part/')) {
      const [, , id, n] = url.pathname.split('/');
      uploads.get(id).parts.set(Number(n), body);
      res.writeHead(200, { ETag: `"etag-${n}"` });
      return res.end();
    }
    send(res, 404, { error: 'not found' });
  })
  .listen(PORT, '127.0.0.1', () => log('listening', PORT));

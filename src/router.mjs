#!/usr/bin/env node
// cchm-router v0.3 — 單一上游（Silk Compute）的 Claude Code 代理
//
// 設計原則（2026-11-10 實測定案，見 docs/DECISIONS.md D014）：
//   1. 只有一個上游。多 upstream ＋ 自動換道讓架構變複雜，卻沒有換到品質或速度。
//   2. Claude Code 只認自家模型名 → 這裡翻譯成 Silk 的 model id。
//   3. SSE 原樣直通、不緩衝；只做必要的事：權杖、翻譯、指紋清洗、用量記帳。
//
// 端點：POST /v1/messages ｜ POST /v1/messages/count_tokens（本地估算）｜ GET /v1/models ・ /healthz

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.3.0';
const PORT = Number(process.env.CCHM_PORT || 8791);
const STARTED = Date.now();

/* ── 金鑰 ─────────────────────────────────────────────── */
function readKey(envFile, keyName) {
  try {
    const line = fs.readFileSync(envFile, 'utf8').split('\n').find(l => l.startsWith(keyName + '='));
    if (line) return line.slice(keyName.length + 1).replace(/^"|"|\r$/g, '');
  } catch {}
  return '';
}

const SILK_KEY =
  process.env.SILK_API_KEY ||
  readKey(`${process.env.HOME}/.hermes/.secrets/silk.env`, 'SILK_API_KEY') ||
  readKey(`${process.env.HERMES_ENV_FILE || `${process.env.HOME}/.hermes/.env`}`, 'SILK_API_KEY');

if (!SILK_KEY) {
  console.error('[cchm] 缺 SILK_API_KEY（~/.hermes/.secrets/silk.env）');
  process.exit(1);
}

const UPSTREAM = { host: 'api.silkcompute.com', port: 443, key: SILK_KEY };

// ── 模型：預設一層（腦＝工作手同一顆），兩層只有 overhead（D013）──
const BRAIN = process.env.CCHM_BRAIN_MODEL || 'deepseek-v4.1-flash-1017-uncensored';
const WORKER = process.env.CCHM_WORKER_MODEL || BRAIN;
const PRO = process.env.CCHM_PRO_MODEL || 'kimi-k3.1-pro-uncensored';

const CLAUDE_ALIAS = [
  [/^claude-opus/i, BRAIN],
  [/^claude-sonnet/i, BRAIN],
  [/^claude-haiku/i, WORKER],
];

const LANES = {
  brain: { model: BRAIN, note: '調度腦與工作手（預設一層，同一顆）' },
  pro: { model: PRO, note: '最強推理（貴，只有硬任務才切）' },
};

function normalizeModel(model) {
  const m = String(model || '');
  for (const [re, real] of CLAUDE_ALIAS) if (re.test(m)) return real;
  if (/^claude/i.test(m)) return BRAIN;   // 其他 claude-* 一律在地化，不外流成真 Claude
  if (/^hh-/i.test(m)) return BRAIN;      // 舊的重車道別名，已無意義
  if (m in COST_PER_M) return m;          // 已知的 Silk 模型照原樣
  // 其他一律回預設：舊 session（mimo-…）、打錯的名字都不該讓上游回 404 而卡住整輪
  if (m) console.log(`[cchm] 未知模型 ${m} → 改用 ${BRAIN}`);
  return BRAIN;
}

// 單價（USD per 1M：[input, output, cacheRead]），來源 Silk llms.txt / models 頁
const COST_PER_M = {
  'deepseek-v4.1-flash-1017-uncensored': [0.28, 1.00, 0.07],
  'deepseek-v4.1-flash-1017': [0.60, 2.40, 0.07],
  'glm-5.3-flash-uncensored': [0.24, 1.00, 0.08],
  'glm-5.3-uncensored': [2.00, 4.00, 0.30],
  'hy4-uncensored': [1.60, 3.20, 0.30],
  'kimi-k3.1-pro-uncensored': [5.00, 15.00, 0.50],
};

/* ── 連線池與用量日誌 ─────────────────────────────────── */
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64 });
const LOG_DIR = process.env.CCHM_LOG_DIR || path.join(process.env.HOME || '.', 'cchm', '.exp', 'logs');
const USAGE_FILE = path.join(LOG_DIR, process.env.CCHM_USAGE_FILE || 'usage.jsonl');
let logReady = false;
function logUsage(rec) {
  try {
    if (!logReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logReady = true; }
    fs.appendFileSync(USAGE_FILE, JSON.stringify(rec) + '\n');
  } catch {}
}

/* ── header 清洗：只放行必要的，其餘（UA／x-stainless-*／x-app）不轉發 ── */
const PASS = new Set(['content-type', 'accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta']);
function cleanHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (PASS.has(k.toLowerCase())) out[k] = v;
  out['user-agent'] = process.env.CCHM_UA || 'cchm/0.3';
  out.authorization = `Bearer ${UPSTREAM.key}`;
  out['x-api-key'] = UPSTREAM.key;
  out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
  return out;
}

const REQUIRED_TOKEN = process.env.CCHM_REQUIRE_TOKEN ?? 'cchm-local';
function authorized(req) {
  if (!REQUIRED_TOKEN) return true;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return auth === REQUIRED_TOKEN || String(req.headers['x-api-key'] || '') === REQUIRED_TOKEN;
}

function lastMatch(str, re) {
  let m, last = null;
  while ((m = re.exec(str))) last = Number(m[1]);
  return last;
}

/* ── 本機 token 估算（Silk 沒有 /count_tokens）── */
function estimateTokens(body) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (body.system) walk(body.system);
  if (Array.isArray(body.messages)) walk(body.messages);
  return Math.max(1, Math.ceil(chars / 2.5));
}

/* ── 轉發（單一上游，SSE 直通）───────────────────────── */
function forward(rawBody, req, res, t0) {
  let parsed = {};
  try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch {}
  const model = normalizeModel(parsed.model);
  const body = Buffer.from(JSON.stringify({ ...parsed, model }));
  const headers = cleanHeaders(req);
  headers['content-length'] = Buffer.byteLength(body);

  const r = https.request({
    hostname: UPSTREAM.host, port: UPSTREAM.port, path: req.url,
    method: req.method, headers, agent,
  }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    let bytes = 0, tail = '';
    ur.on('data', (c) => {
      bytes += c.length;
      if (bytes < 4_000_000) tail = (tail + c.toString('utf8')).slice(-4096);
    });
    ur.on('end', () => {
      const ms = Date.now() - t0;
      const inTok = lastMatch(tail, /"input_tokens":(\d+)/g);
      const outTok = lastMatch(tail, /"output_tokens":(\d+)/g);
      const cacheTok = lastMatch(tail, /"cache_read_input_tokens":(\d+)/g) || 0;
      const bill = COST_PER_M[model];
      const cost = bill && inTok != null && outTok != null
        ? Number(((inTok / 1e6) * bill[0] + (cacheTok / 1e6) * bill[2] + (outTok / 1e6) * bill[1]).toFixed(6))
        : null;
      console.log(`[cchm] ${req.method} ${req.url} model=${model} ${ur.statusCode} ${bytes}B ${ms}ms` +
        (inTok != null ? ` in=${inTok} out=${outTok} cache=${cacheTok}` : '') + (cost != null ? ` $${cost}` : ''));
      logUsage({ ts: new Date().toISOString(), op: 'messages', model, status: ur.statusCode,
                 bytes, ms, in_tokens: inTok, out_tokens: outTok, cache_tokens: cacheTok, cost_usd: cost });
    });
    ur.pipe(res);
  });

  r.on('error', (err) => {
    console.error('[cchm] silk 失敗:', err.message);
    logUsage({ ts: new Date().toISOString(), op: 'messages', model, error: err.message, ms: Date.now() - t0 });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cchm: silk ${err.message}` } }));
  });

  if (body.length) r.write(body);
  r.end();
}

/* ── server ──────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const url = req.url || '/';

  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, version: VERSION, upstream: UPSTREAM.host,
      uptime_s: Math.round((Date.now() - STARTED) / 1000),
      brain: BRAIN, worker: WORKER, auth: REQUIRED_TOKEN ? 'token' : 'open',
    }));
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'cchm: bad token' } }));
  }

  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    const data = Object.entries(LANES).map(([lane, v]) => ({
      id: v.model, type: 'model', display_name: `${lane} — ${v.note}`, lane,
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data, has_more: false,
      first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }));
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (url.includes('/count_tokens')) {
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimateTokens(parsed), estimated: true }));
    }
    forward(body, req, res, t0);
  });
});

server.on('error', (e) => { console.error('[cchm] listen 失敗:', e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => console.log(`[cchm] router ${VERSION} on http://127.0.0.1:${PORT} → ${UPSTREAM.host}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 100); });

#!/usr/bin/env node
// cchm-router — Claude Code 的單一後端端點，依 model 名稱分流到不同上游與車道
//
// 車道：
//   brain  mimo-v2.6-flash-outlaw                  → wildwestapi.com  (調度腦：只拆解、派工)
//   worker deepseek/deepseek-v4.1-flash-1017:nitro → openrouter.ai    (工作手：實際寫碼)
//   heavy  hh-* 前綴                                → wildwestapi.com  (outlaw 重車道)
//
// v0.2 新增：本地 /v1/models、count_tokens 修正（OpenRouter 沒有這端點，實測 404）、
// 上游 5xx/429/連線錯誤自動換道、client 指紋 header 清洗、keep-alive 連線池、
// JSONL 用量日誌、reusePort（換版可零停機）、本地權杖檢查。
//
// 零依賴：只用 node 內建 http/https/fs。SSE 原樣直通、不緩衝。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.2.0';
const PORT = Number(process.env.CCHM_PORT || 8791);
const STARTED = Date.now();

/* ── 金鑰 ─────────────────────────────────────────────── */
function readKey(envFile, keyName) {
  try {
    const line = fs.readFileSync(envFile, 'utf8').split('\n')
      .find(l => l.startsWith(keyName + '='));
    if (line) return line.slice(keyName.length + 1).replace(/^"|"|\r$/g, '');
  } catch {}
  return '';
}

const WILDWEST_KEY =
  process.env.WILDWEST_API_KEY ||
  readKey(`${process.env.HERMES_SECRETS_FILE || `${process.env.HOME}/.hermes/.secrets/wildwest.env`}`, 'WILDWEST_API_KEY') ||
  readKey(`${process.env.HERMES_ENV_FILE || `${process.env.HOME}/.hermes/.env`}`, 'WILDWEST_API_KEY');
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ||
  readKey(`${process.env.HERMES_ENV_FILE || `${process.env.HOME}/.hermes/.env`}`, 'OPENROUTER_API_KEY');

if (!OPENROUTER_KEY) {
  console.error('[cchm] 缺 OPENROUTER_API_KEY（~/.hermes/.env）');
  process.exit(1);
}
if (!WILDWEST_KEY) {
  console.error('[cchm] 警告：缺 WILDWEST_API_KEY，調度腦（mimo）與重車道會失效，只剩 openrouter 工作手');
}

const UPSTREAMS = {
  wildwest:   { host: 'wildwestapi.com', port: 443, key: WILDWEST_KEY },
  openrouter: { host: 'openrouter.ai', port: 443, pathPrefix: '/api', key: OPENROUTER_KEY },
};

/* ── 車道定義（/v1/models 與文件用；實際路由仍看 model 名稱） ── */
const LANES = {
  brain:  { model: 'mimo-v2.6-flash-outlaw',                  upstream: 'wildwest',   note: '調度腦：拆解、派工、驗收' },
  worker: { model: 'deepseek/deepseek-v4.1-flash-1017:nitro', upstream: 'openrouter', note: '工作手：寫碼、測試、除錯' },
  heavy:  { model: 'hh-deepseek-v4.1-flash-1017',             upstream: 'wildwest',   note: '重車道：輸出短、動作導向' },
};

// hh- 前綴 = 同名模型改走 WildWest 的 outlaw 端點
//   實測 2026-11-10：outlaw 版直接輸出動作塊，輸出精簡；適合攻堅/枚舉，不適合長篇規劃
const ALIAS_MAP = {
  'hh-mimo-v2.6-flash': 'mimo-v2.6-flash-outlaw',
  'hh-deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash-1017-outlaw',
};

const ROUTE_RULES = [
  ['mimo', 'wildwest'],       // MiMo 2.6 Flash — 調度腦
  ['deepseek', 'openrouter'], // DeepSeek V4.1 Flash 1017 — 工作手
];
// 註：ROUTE_RULES 的比對已搬進 routeFor（需先解析 claude-* 別名），此處保留作為文件說明。

// Claude Code 只認自家模型名，遇到 mimo/deepseek 會警告 "doesn't recognize the model"，
// 連帶影響它對 context window / thinking 的假設。所以在設定檔用官方名字，這裡翻成真模型。
//   claude-opus-* / claude-sonnet-* → 調度腦（mimo, wildwest）
//   claude-haiku-*                  → 工作手（1017 nitro, openrouter）
const CLAUDE_ALIAS = [
  [/^claude-opus/i, 'mimo-v2.6-flash-outlaw'],
  [/^claude-sonnet/i, 'mimo-v2.6-flash-outlaw'],
  [/^claude-haiku/i, 'deepseek/deepseek-v4.1-flash-1017:nitro'],
];

function normalizeModel(model) {
  const m = String(model || '');
  for (const [re, real] of CLAUDE_ALIAS) if (re.test(m)) return real;
  // 保險：任何其他 claude-* 名字一律導到調度腦，絕不讓它原樣打到 OpenRouter 的真 Claude（帳單會爆）
  if (/^claude/i.test(m)) return 'mimo-v2.6-flash-outlaw';
  for (const [prefix, real] of Object.entries(ALIAS_MAP)) {
    if (m === prefix || m.startsWith(prefix + ':') || m.startsWith(prefix + '-')) {
      return real + m.slice(prefix.length);
    }
    if (m.startsWith(prefix)) return real;
  }
  return m;
}

function routeFor(rawModel, realModel) {
  const raw = String(rawModel || '').toLowerCase();
  if (raw.startsWith('hh-')) return process.env.CCHM_HEAVY_ROUTE || 'wildwest';
  const m = String(realModel || '').toLowerCase();
  if (m.includes('mimo')) return 'wildwest';
  if (m.includes('deepseek')) return 'openrouter';
  return process.env.CCHM_DEFAULT_ROUTE || 'openrouter';
}

// 換道計畫：只在「另一家有同款模型、只是名字不同」時成立，不猜不存在的模型。
// 目前確定可用的一對：openrouter 的 1017:nitro ⇄ wildwest 的 1017-outlaw（兩邊都實測 200）
function fallbackFor(model, target) {
  if (target === 'openrouter' && /deepseek/i.test(model)) {
    const bare = String(model).replace(/^.*\//, '').replace(/:.*$/, '');
    return { target: 'wildwest', model: `${bare}-outlaw` };
  }
  return null;
}

/* ── 連線池 & 用量日誌 ───────────────────────────────── */
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

/* ── 指紋清洗：只放行必要 header；user-agent / x-stainless-* / x-app 等一律不轉發 ── */
const PASSTHROUGH_HEADERS = new Set([
  'content-type', 'accept', 'accept-encoding',
  'anthropic-version', 'anthropic-beta',
]);
function cleanHeaders(req, up) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (PASSTHROUGH_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out['user-agent'] = process.env.CCHM_UA || 'cchm/0.2';
  out.authorization = `Bearer ${up.key}`;
  out['x-api-key'] = up.key;
  out['anthropic-version'] = out['anthropic-version'] || '2023-06-01';
  if (up === UPSTREAMS.openrouter) out['x-title'] = 'cchm';
  return out;
}

/* ── 本地權杖檢查（避免本機任何程式白嫖金鑰；CCHM_REQUIRE_TOKEN="" 可關） ── */
const REQUIRED_TOKEN = process.env.CCHM_REQUIRE_TOKEN ?? 'cchm-local';
function authorized(req) {
  if (!REQUIRED_TOKEN) return true;
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = String(req.headers['x-api-key'] || '');
  return auth === REQUIRED_TOKEN || key === REQUIRED_TOKEN;
}

function upstreamPath(up, url) {
  if (!up.pathPrefix) return url;
  return url.startsWith(up.pathPrefix) ? url : up.pathPrefix + url;
}

/* ── 本地估算（count_tokens 備援；CJK 約 1 token/字、英文約 4 字/token → 取 2.5 字/token） ── */
function estimateTokens(bodyObj) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(parsedMessages(bodyObj));
  return Math.max(1, Math.ceil(chars / 2.5));
}
function parsedMessages(b) {
  const out = [];
  if (b.system) out.push(b.system);
  if (Array.isArray(b.messages)) out.push(b.messages);
  return out;
}

/* ── 換道條件：這些狀態碼視為「這家不行」，換到另一家重試一次 ──
   429 限流、403 政策封鎖（繞審查的關鍵：被封就換 outlaw 車道）、5xx 上游掛掉 */
const FAILOVER_CODES = new Set(
  (process.env.CCHM_FAILOVER_CODES || '403,429,500,502,503,504,529')
    .split(',').map(s => Number(s.trim())).filter(Boolean)
);

/* ── 轉發（含一次換道重試） ──────────────────────────── */
function forward(rawBody, req, res, t0) {
  let parsed = {};
  try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch {}
  const rawModel = parsed.model || '';
  const model = normalizeModel(rawModel);
  const target = routeFor(rawModel, model);
  const fb = fallbackFor(model, target);

  const attempt = (whichName, modelName, isRetry) => {
    const which = UPSTREAMS[whichName];
    if (!which.key) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cchm: ${whichName} 沒有金鑰` } }));
    }
    const body = Buffer.from(JSON.stringify({ ...parsed, model: modelName }));
    const headers = cleanHeaders(req, which);
    headers['content-length'] = Buffer.byteLength(body);

    const r = https.request({
      hostname: which.host,
      port: which.port,
      path: upstreamPath(which, req.url),
      method: req.method,
      headers,
      agent,
    }, (ur) => {
      if (!isRetry && FAILOVER_CODES.has(ur.statusCode) && fb) {
        ur.resume();
        console.log(`[cchm] ${whichName} ${ur.statusCode} → failover 到 ${fb.target} (${fb.model})`);
        logUsage({ ts: new Date().toISOString(), op: 'failover', model, from: whichName, status: ur.statusCode, to: fb.target });
        return attempt(fb.target, fb.model, true);
      }
      res.writeHead(ur.statusCode, ur.headers);
      let bytes = 0;
      ur.on('data', (c) => { bytes += c.length; });
      ur.on('end', () => {
        const ms = Date.now() - t0;
        console.log(`[cchm] ${req.method} ${req.url} model=${modelName} → ${whichName} ${ur.statusCode} ${bytes}B ${ms}ms${isRetry ? ' (retry)' : ''}`);
        logUsage({ ts: new Date().toISOString(), op: 'messages', model: modelName, upstream: whichName, status: ur.statusCode, bytes, ms, retry: !!isRetry });
      });
      ur.pipe(res);
    });

    r.on('error', (err) => {
      if (!isRetry && fb) {
        console.log(`[cchm] ${whichName} 連線失敗 ${err.message} → failover 到 ${fb.target}`);
        logUsage({ ts: new Date().toISOString(), op: 'failover', model, from: whichName, error: err.message, to: fb.target });
        return attempt(fb.target, fb.model, true);
      }
      console.error(`[cchm] ${whichName} 失敗:`, err.message);
      logUsage({ ts: new Date().toISOString(), op: 'messages', model: modelName, upstream: whichName, error: err.message, ms: Date.now() - t0 });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cchm upstream error (${whichName}): ${err.message}` } }));
    });

    if (body.length) r.write(body);
    r.end();
  };

  attempt(target, model, false);
}

/* ── count_tokens：OpenRouter 沒有這端點（實測 404），一律用 wildwest 的 tokenizer，失敗則本地估 ── */
function handleCountTokens(rawBody, req, res, t0) {
  let parsed = {};
  try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch {}
  const up = UPSTREAMS.wildwest;
  const estimated = () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimateTokens(parsed), estimated: true }));
    logUsage({ ts: new Date().toISOString(), op: 'count_tokens', estimated: true, ms: Date.now() - t0 });
  };
  if (!up.key) return estimated();

  const body = Buffer.from(JSON.stringify({
    model: process.env.CCHM_TOKENIZER_MODEL || 'mimo-v2.6-flash-outlaw',
    messages: parsed.messages, system: parsed.system,
  }));
  const headers = cleanHeaders(req, up);
  headers['content-length'] = Buffer.byteLength(body);

  const r = https.request({
    hostname: up.host, port: up.port, path: '/v1/messages/count_tokens',
    method: 'POST', headers, agent,
  }, (ur) => {
    let buf = '';
    ur.on('data', (c) => { buf += c; });
    ur.on('end', () => {
      if (ur.statusCode === 200) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(buf);
        logUsage({ ts: new Date().toISOString(), op: 'count_tokens', status: 200, ms: Date.now() - t0 });
      } else estimated();
    });
  });
  r.on('error', estimated);
  r.write(body);
  r.end();
}

/* ── 本地模型清單（不直通上游，免得 Claude Code 看到別家目錄） ── */
function handleModels(res) {
  const now = new Date().toISOString();
  const data = Object.entries(LANES).map(([lane, v]) => ({
    id: v.model, type: 'model', display_name: `${lane} — ${v.note}`,
    created_at: now, lane, upstream: v.upstream,
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    data, has_more: false,
    first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null,
  }));
}

/* ── server ──────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const url = req.url || '/';

  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, version: VERSION,
      uptime_s: Math.round((Date.now() - STARTED) / 1000),
      routes: Object.keys(UPSTREAMS), lanes: Object.keys(LANES),
      auth: REQUIRED_TOKEN ? 'token' : 'open',
      keys: { wildwest: !!WILDWEST_KEY, openrouter: !!OPENROUTER_KEY },
    }));
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'cchm: bad token' } }));
  }

  if (req.method === 'GET' && url.startsWith('/v1/models')) return handleModels(res);

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (url.includes('/count_tokens')) return handleCountTokens(body, req, res, t0);
    forward(body, req, res, t0);
  });
});

// reusePort：新舊版可同時 bind 同一埠，換版不必斷線（Linux only，失敗就退回普通 listen）
let reuseOk = true;
server.on('error', (e) => {
  if (reuseOk) {
    reuseOk = false;
    console.error(`[cchm] reusePort 失敗（${e.code || e.message}），改用普通 listen`);
    server.listen(PORT, '127.0.0.1', () =>
      console.log(`[cchm] router ${VERSION} on http://127.0.0.1:${PORT} (mimo→wildwest, else→openrouter)`));
    return;
  }
  console.error('[cchm] listen 失敗:', e.message);
  process.exit(1);
});
server.listen({ port: PORT, host: '127.0.0.1', reusePort: true }, () => {
  console.log(`[cchm] router ${VERSION} on http://127.0.0.1:${PORT} (mimo→wildwest, else→openrouter)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 150); });
}

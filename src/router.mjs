#!/usr/bin/env node
// cchm-router — Claude Code 後方單一端點，依 model 名稱分流
//
// 請求全部走 Anthropic Messages 格式（Claude Code 只會發這種）：
//   model = mimo-v2.6-flash-outlaw      → https://wildwestapi.com/v1/messages   (調度腦)
//   其他（含 deepseek…）                → https://openrouter.ai/api/v1/messages (工作手)
//
// 零依賴：只用 node 內建 http/https。串流原樣直通（SSE 不緩衝）。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

const PORT = Number(process.env.CCHM_PORT || 8791);

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

if (!WILDWEST_KEY || !OPENROUTER_KEY) {
  console.error('[cchm] 缺金鑰：WILDWEST 或 OPENROUTER；來源：環境變數或 $HOME/.hermes 下 .env');
  process.exit(1);
}

const UPSTREAMS = {
  wildwest: { host: 'wildwestapi.com', port: 443, key: WILDWEST_KEY },
  openrouter: { host: 'openrouter.ai', pathPrefix: '/api', port: 443, key: OPENROUTER_KEY },
};

// 判斷某個 model 應該送到哪一家。前綴比對，方便之後加模型。
// hh- 前綴 = heavy hacker 車道：同名模型改走 WildWest outlaw 端點
//   實測 2026-11-10：outlaw 版回應快一倍（5s vs 9s）且直接輸出動作塊，適合攻堅/暴力枚舉類
const ALIAS_MAP = {
  'hh-mimo-v2.6-flash': 'mimo-v2.6-flash-outlaw',
  'hh-deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash-1017-outlaw',
};

const ROUTE_RULES = [
  ['mimo', 'wildwest'],       // MiMo 2.6 Flash — 調度腦
  ['deepseek', 'openrouter'], // DeepSeek V4.1 Flash 1017 — 工作手
];

function normalizeModel(model) {
  const m = String(model || '');
  for (const [prefix, real] of Object.entries(ALIAS_MAP)) {
    if (m === prefix || m.startsWith(prefix + ':') || m.startsWith(prefix + '-')) {
      return real + m.slice(prefix.length);
    }
    if (m.startsWith(prefix)) return real;
  }
  return m;
}

function routeFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('hh-')) return process.env.CCHM_HEAVY_ROUTE || 'wildwest';
  for (const [prefix, upstream] of ROUTE_RULES) {
    if (m.includes(prefix)) return upstream;
  }
  return process.env.CCHM_DEFAULT_ROUTE || 'openrouter';
}

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => forward(Buffer.concat(chunks), req, res));
});

function forward(body, req, res) {
  let parsedBody = {};
  try { parsedBody = JSON.parse(body.toString('utf8') || '{}'); } catch {}
  const rawModel = parsedBody.model || '';
  const target = routeFor(rawModel);          // 先定路由（hh- 前綴判斷要用原始名）
  parsedBody.model = normalizeModel(rawModel); // 再換成上游要的真名
  body = Buffer.from(JSON.stringify(parsedBody));
  const model = parsedBody.model;
  const up = UPSTREAMS[target];

  // /v1/messages 原樣轉發；OpenRouter 要掛 /api 前綴
  let path = req.url;
  if (up.pathPrefix && !path.startsWith(up.pathPrefix)) {
    path = up.pathPrefix + path.replace(/^\/v1\//, '/v1/');
    if (!path.includes('/v1/')) path = up.pathPrefix + path;
  }

  const headers = { ...req.headers };
  delete headers.host; delete headers['content-length'];
  headers.authorization = `Bearer ${up.key}`;
  // 兩家都吃 x-api-key / authorization 其中之一，雙寫最穩
  headers['x-api-key'] = up.key;
  headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
  if (target === 'openrouter' && !headers['http-referer']) {
    headers['x-title'] = 'cchm'; // OpenRouter 建議帶的識別 header
  }
  if (body.length) headers['content-length'] = Buffer.byteLength(body);

  const r = https.request({
    hostname: up.host,
    port: up.port,
    path,
    method: req.method,
    headers,
  }, ur => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);          // SSE 直通、不緩衝
  });

  r.on('error', err => {
    console.error(`[cchm] ${target} 失敗:`, err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `cchm upstream error (${target}): ${err.message}` } }));
  });

  if (body.length) r.write(body);
  r.end();
  console.log(`[cchm] ${req.method} ${req.url} model=${model || '?'} → ${target}`);
}

server.listen(PORT, '127.0.0.1', () =>
  console.log(`[cchm] router on http://127.0.0.1:${PORT} (mimo→wildwest, else→openrouter)`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => process.exit(0));
}

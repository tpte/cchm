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
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.3';
const PORT = Number(process.env.CCHM_PORT || 8791);
const STARTED = Date.now();
// 被 import（測試）時不啟動伺服器，也不要因為沒有金鑰就 exit
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

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

if (!SILK_KEY && IS_MAIN) {
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

/* ── 併發閘門與重試（2026-11-11 實測）─────────────────
   Silk 帳號上限：同時只能有 8 個請求在跑，第 9 個回
   429 rate_limit_error "This account already has 8 requests running"，
   而且不帶 Retry-After。v0.3 拿掉 failover 後 429 會原樣丟回 Claude Code，
   使用者看到的就是滿畫面的 API Error。這裡補兩件事：排隊節流＋有界重試。 */
const MAX_CONCURRENT = Number(process.env.CCHM_MAX_CONCURRENT || 6); // 留 2 個餘裕給自檢／bench
const MAX_RETRY = Number(process.env.CCHM_MAX_RETRY || 4);
const RETRY_CODES = new Set([408, 409, 429, 500, 502, 503, 504, 524, 529]);
let active = 0;
const waiting = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) return next();          // 槽直接交接給排隊者，active 不變
  if (active > 0) active--;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 單次上游請求（先拿到 status 再決定直通或重試，SSE 不緩衝）── */
function once(body, headers, req) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: UPSTREAM.host, port: UPSTREAM.port, path: req.url,
      method: req.method, headers, agent,
    }, (ur) => resolve({ ur }));
    r.on('error', (err) => resolve({ err }));
    if (body.length) r.write(body);
    r.end();
  });
}

/* ── 400 自動修復（2026-11-11 事故）────────────────────
   Claude Code 2.1.x 在對話中途會把工具抽掉／保留歷史 thinking，
   送出的 messages 就出現「孤兒 tool_use／tool_result」「歷史 thinking」
   這類格式問題。Silk 直接回 400「could not accept this request…
   the message format」，而且壞訊息留在歷史裡，之後每一輪都必然 400，
   Claude Code 再怎麼重試都救不回來（實測 12 次全 400）。
   這裡在原樣轉發失敗時做一次安全正規化再重送：不改語意，只修格式。 */
const SANITIZE_400 = process.env.CCHM_SANITIZE_400 ?? '1';
const MAX_REPAIR = Number(process.env.CCHM_MAX_REPAIR || 3);
const ERR_LOG = path.join(LOG_DIR, 'upstream-errors.jsonl');

function readAll(ur, limit = 512 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    ur.on('data', (c) => { if (size < limit) { chunks.push(c); size += c.length; } });
    ur.on('end', () => resolve(Buffer.concat(chunks).subarray(0, limit)));
    ur.on('error', () => resolve(Buffer.concat(chunks).subarray(0, limit)));
  });
}

function repairFor400(parsed, stage = 1) {
  const msgs = Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!msgs || !msgs.length) return null;
  const notes = [];

  // 1. 把 thinking 參數修到模型吃得下的範圍
  const mt = Number(parsed.max_tokens);
  if (parsed.thinking && parsed.thinking.type === 'enabled' && Number.isFinite(mt)) {
    const budget = Number(parsed.thinking.budget_tokens);
    if (!Number.isFinite(budget) || budget >= mt - 1024) {
      parsed.thinking = { ...parsed.thinking, budget_tokens: Math.max(1024, mt - 2048) };
      notes.push(`thinking budget ${budget}→${parsed.thinking.budget_tokens}`);
    }
  }

  // 2. 剝離歷史 thinking block（回送它們本來就沒有意義，卻是常見 400 來源）
  let stripped = 0;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    const before = m.content.length;
    m.content = m.content.filter((b) => !(b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
    stripped += before - m.content.length;
  }
  if (stripped) notes.push(`剝離歷史 thinking ${stripped} 個`);

  // 3. 移除孤兒 tool_use／tool_result（工具被抽掉後配對就斷了）
  const useIds = new Set(), resIds = new Set();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'tool_use' && b.id) useIds.add(b.id);
      if (b?.type === 'tool_result' && b.tool_use_id) resIds.add(b.tool_use_id);
    }
  }
  let dropped = 0;
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    const before = m.content.length;
    m.content = m.content.filter((b) => {
      if (b?.type === 'tool_use') return resIds.has(b.id);
      if (b?.type === 'tool_result') return useIds.has(b.tool_use_id);
      return true;
    });
    dropped += before - m.content.length;
  }
  if (dropped) notes.push(`移除孤兒工具區塊 ${dropped} 個`);

  // 4. 剝除歷史 base64 圖片（真正的主因：Claude Code 把每次截圖塞進對話歷史，
  //    實測 343 則訊息累積 11.5MB base64 ≈ 340 萬 token，遠超模型上限就一律 400）
  let imgBytes = 0, imgCount = 0;
  const killImage = (blk, drop) => {
    const data = blk?.source?.data || '';
    imgBytes += data.length;
    imgCount++;
    if (drop) return false;
    const kb = Math.round(data.length / 1024);
    blk.type = 'text';
    blk.text = `[歷史截圖已省略：base64 ${kb}KB]`;
    delete blk.source;
    return true;
  };
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    const kept = [];
    for (const blk of m.content) {
      if (blk?.type === 'image' && blk.source?.type === 'base64') {
        if (killImage(blk, false)) kept.push(blk);
        continue;
      }
      if (blk?.type === 'tool_result') {
        if (Array.isArray(blk.content)) {
          blk.content = blk.content.filter((c) => !(c?.type === 'image' && c.source?.type === 'base64') || killImage(c, true));
          if (!blk.content.length) blk.content = [{ type: 'text', text: '[歷史截圖已省略]' }];
        } else if (typeof blk.content === 'string' && blk.content.length > 200_000) {
          blk.content = blk.content.slice(0, 200_000) + '\n[內容過長已截斷]';
        }
      }
      kept.push(blk);
    }
    m.content = kept;
  }
  if (imgCount) notes.push(`剝除歷史圖片 ${imgCount} 張（${Math.round(imgBytes / 1048576 * 10) / 10}MB base64）`);

  // 4b. 收掉空訊息、合併連續同角色（上游要求 user／assistant 嚴格交替）
  const out = [];
  let mergedDrop = 0;
  for (const m of msgs) {
    const empty = Array.isArray(m.content) ? m.content.length === 0 : !String(m.content ?? '').trim();
    if (empty) { mergedDrop++; continue; }
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && Array.isArray(prev.content) && Array.isArray(m.content)) {
      prev.content = [...prev.content, ...m.content];
      mergedDrop++;
      continue;
    }
    out.push(m);
  }
  if (mergedDrop) notes.push(`收掉空／同角色訊息 ${mergedDrop} 則`);
  parsed.messages = out;

  // 5. 第二級：拿掉非 Anthropic 上游通常不吃的功能欄位（thinking／context_management／beta）
  if (stage >= 2) {
    if (parsed.thinking) { delete parsed.thinking; notes.push('移除 thinking 參數'); }
    if (parsed.context_management) { delete parsed.context_management; notes.push('移除 context_management'); }
    if (parsed.metadata) delete parsed.metadata;
    if (Number(parsed.max_tokens) > 32000) { parsed.max_tokens = 32000; notes.push('max_tokens→32000'); }

    // 5c. 仍然超長就從最舊的訊息丟（保留開頭一則與最後 30 則）
    const LIMIT = Number(process.env.CCHM_MAX_PROMPT_CHARS || 400000);
    const size = () => JSON.stringify(parsed.messages).length + JSON.stringify(parsed.system || '').length;
    if (size() > LIMIT && parsed.messages.length > 31) {
      const head = parsed.messages.slice(0, 1);
      const tail = parsed.messages.slice(-30);
      const mid = parsed.messages.slice(1, parsed.messages.length - 30);
      let dropped = 0;
      while (mid.length > 0 && JSON.stringify([...head, ...mid, ...tail]).length > LIMIT) { mid.shift(); dropped++; }
      const joined = [];
      for (const m of [...head, ...mid, ...tail]) {
        if (m.role === 'assistant' && !joined.length) continue;   // 首則必須是 user
        const p = joined[joined.length - 1];
        if (p && p.role === m.role && Array.isArray(p.content) && Array.isArray(m.content)) {
          p.content = [...p.content, ...m.content];
        } else joined.push(m);
      }
      parsed.messages = joined;
      if (dropped) notes.push(`丟棄最舊訊息 ${dropped} 則（${Math.round(size() / 1024)}KB）`);
    }

    // 5d. 還是超長（訊息很少但每則巨大，例如單則 5MB 的 tool_result、貼上的長文）：
    //     原本這裡只處理「>31 則」的情況，少則數但超大就一路 400。先把舊訊息整則丟到只剩最後一則。
    if (size() > LIMIT) {
      let dropped = 0;
      // 一次丟到「下一個 user 訊息」開頭，既能縮小又不會留成 assistant 開頭／空陣列
      while (size() > LIMIT) {
        const nextUser = parsed.messages.findIndex((m, i) => i > 0 && m.role === 'user');
        if (nextUser <= 0) break;                       // 丟不動了 → 交給 5e 截斷
        parsed.messages = parsed.messages.slice(nextUser);
        dropped += nextUser;
      }
      if (dropped) {
        notes.push(`訊息過少仍超長，丟棄較舊訊息 ${dropped} 則`);
        // 丟訊息會切斷工具配對，重新收掉孤兒，否則下一輪照樣 400
        const useIds = new Set(), resIds = new Set();
        for (const m of parsed.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (b?.type === 'tool_use' && b.id) useIds.add(b.id);
            if (b?.type === 'tool_result' && b.tool_use_id) resIds.add(b.tool_use_id);
          }
        }
        let orphans = 0;
        for (const m of parsed.messages) {
          if (!Array.isArray(m.content)) continue;
          const before = m.content.length;
          m.content = m.content.filter((b) => {
            if (b?.type === 'tool_use') return resIds.has(b.id);
            if (b?.type === 'tool_result') return useIds.has(b.tool_use_id);
            return true;
          });
          orphans += before - m.content.length;
        }
        if (orphans) notes.push(`重新收掉孤兒工具區塊 ${orphans} 個`);
      }
    }

    // 5e. 只剩一則仍超長：截斷超長文字塊，至少讓請求送得出去（原本這種情況直接回 400）
    if (size() > LIMIT) {
      const TRIM = 8000;
      const cutOf = (s) => (typeof s === 'string' && s.length > TRIM ? s.length - TRIM : 0);
      let cut = 0;
      const shrinkBlock = (b) => {
        if (cutOf(b?.text)) { cut += cutOf(b.text); b.text = b.text.slice(0, TRIM) + '\n[內容過長已截斷]'; }
        else if (cutOf(b?.content)) { cut += cutOf(b.content); b.content = b.content.slice(0, TRIM) + '\n[內容過長已截斷]'; }
        else if (Array.isArray(b?.content)) b.content.forEach(shrinkBlock);
      };
      for (const m of parsed.messages) {
        if (size() <= LIMIT) break;
        if (cutOf(m.content)) { cut += cutOf(m.content); m.content = m.content.slice(0, TRIM) + '\n[訊息過長已截斷]'; }
        else if (Array.isArray(m.content)) m.content.forEach(shrinkBlock);
      }
      if (cut) notes.push(`截斷過長內容 ${Math.round(cut / 1024)}KB（剩 ${Math.round(size() / 1024)}KB）`);
    }
  }

  // 5b. 第三級：只留最小可用欄位
  if (stage >= 3) {
    const KEEP = new Set(['model', 'messages', 'system', 'max_tokens', 'stream', 'temperature',
      'top_p', 'stop_sequences', 'tools', 'tool_choice']);
    for (const k of Object.keys(parsed)) if (!KEEP.has(k)) delete parsed[k];
    if (parsed.max_tokens) parsed.max_tokens = Math.min(Number(parsed.max_tokens) || 8192, 8192);
    notes.push('只保留最小欄位組');
  }

  // 第 1 級沒有任何可修項時不要放棄：直接降到下一級（參數降級 → 最小欄位）。
  // 原本這裡 return null，等於「格式乾淨但就是太大」的請求永遠試不到降級，一路 400。
  if (!notes.length) {
    if (stage === 1) return repairFor400(parsed, 2);
    if (stage === 2) return repairFor400(parsed, 3);
    return null;
  }
  return { body: parsed, notes };
}

/* ── 轉發（單一上游，SSE 直通）───────────────────────── */
async function forward(rawBody, req, res, t0) {
  let parsed = {};
  try { parsed = JSON.parse(rawBody.toString('utf8') || '{}'); } catch {}
  const model = normalizeModel(parsed.model);
  let body = Buffer.from(JSON.stringify({ ...parsed, model }));
  const headers = cleanHeaders(req);
  headers['content-length'] = Buffer.byteLength(body);
  let repairs = 0;

  await acquire();
  let released = false;
  const done = () => { if (!released) { released = true; release(); } };
  res.on('close', done);

  for (let attempt = 0; ; attempt++) {
    if (res.writableEnded || res.destroyed) { done(); return; }
    const { ur, err } = await once(body, headers, req);
    const status = ur?.statusCode;
    const retriable = !!err || (ur && RETRY_CODES.has(ur.statusCode));

    // 4xx（非重試碼）：先把上游講的話收下來，再判斷能不能自動修復重送
    if (ur && status >= 400 && status < 500 && !RETRY_CODES.has(status)) {
      const errBody = await readAll(ur);
      const text = errBody.toString('utf8');
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(ERR_LOG, JSON.stringify({
          ts: new Date().toISOString(), model, status, bytes: errBody.length,
          attempt, repairs, body: text.slice(0, 4000),
        }) + '\n');
      } catch {}
      console.error(`[cchm] 上游 ${status}（${errBody.length}B）: ${text.slice(0, 400)}`);
      logUsage({ ts: new Date().toISOString(), op: 'upstream_error', model, status,
                 bytes: errBody.length, body: text.slice(0, 1200), attempt, repairs, ms: Date.now() - t0 });

      const stage = repairs + 1;
      const fix = String(SANITIZE_400) !== '0' && repairs < MAX_REPAIR ? repairFor400(parsed, stage) : null;
      if (fix) {
        repairs++;
        if (stage >= 2 && headers['anthropic-beta']) {
          delete headers['anthropic-beta'];
          fix.notes.push('剝離 anthropic-beta');
        }
        console.log(`[cchm] 400 自動修復（第 ${repairs} 次）：${fix.notes.join('；')}`);
        logUsage({ ts: new Date().toISOString(), op: 'repair', model, status, attempt, repairs,
                   notes: fix.notes.join('；'), ms: Date.now() - t0 });
        parsed = fix.body;
        body = Buffer.from(JSON.stringify({ ...parsed, model }));
        headers['content-length'] = Buffer.byteLength(body);
        await sleep(150);
        continue;
      }

      // 修復用盡仍 400：把原始請求落檔，供事後定位（可用 CCHM_DUMP_FAILED=0 關掉）
      try {
        if (process.env.CCHM_DUMP_FAILED !== '0') {
          const dumpFile = path.join(LOG_DIR, 'failed-request.json');
          fs.writeFileSync(dumpFile, JSON.stringify({
            ts: new Date().toISOString(), model, status, repairs,
            anthropic_beta: headers['anthropic-beta'] || null,
            bytes: rawBody.length,
          }) + '\n' + rawBody.toString('utf8'));
        }
      } catch {}

      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(errBody);
      done();
      return;
    }

    if (retriable && attempt < MAX_RETRY) {
      const base = err ? 400 : 1000;
      const wait = Math.min(10_000, base * 2 ** attempt) + Math.floor(Math.random() * 300);
      console.log(`[cchm] 重試 ${attempt + 1}/${MAX_RETRY}（${err ? err.message : 'HTTP ' + ur.statusCode}）等 ${wait}ms model=${model} active=${active} queue=${waiting.length}`);
      logUsage({ ts: new Date().toISOString(), op: 'retry', model, attempt: attempt + 1,
                 status: ur?.statusCode, error: err?.message, wait_ms: wait, active, queued: waiting.length });
      if (ur) ur.resume();          // 丟棄這次的錯誤 body，不要轉給 client
      await sleep(wait);
      continue;
    }

    if (err) {
      console.error('[cchm] silk 失敗:', err.message);
      logUsage({ ts: new Date().toISOString(), op: 'messages', model, error: err.message, ms: Date.now() - t0 });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `cchm: silk ${err.message}` } }));
      done();
      return;
    }

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
        (attempt ? ` retries=${attempt}` : '') +
        (inTok != null ? ` in=${inTok} out=${outTok} cache=${cacheTok}` : '') + (cost != null ? ` $${cost}` : ''));
      logUsage({ ts: new Date().toISOString(), op: 'messages', model, status: ur.statusCode,
                 bytes, ms, retries: attempt, in_tokens: inTok, out_tokens: outTok, cache_tokens: cacheTok, cost_usd: cost });
      done();
    });
    ur.on('error', () => done());
    ur.pipe(res);
    return;
  }
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
      inflight: active, queued: waiting.length, max_concurrent: MAX_CONCURRENT,
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

if (IS_MAIN) {
  server.on('error', (e) => { console.error('[cchm] listen 失敗:', e.message); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => console.log(`[cchm] router ${VERSION} on http://127.0.0.1:${PORT} → ${UPSTREAM.host}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 100); });
}

export { repairFor400, normalizeModel, VERSION };

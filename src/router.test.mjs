// router.mjs 的 400 修復純函式測試（node --test src/router.test.mjs）
// 只測 repairFor400／normalizeModel，不起伺服器、不打上游。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairFor400, normalizeModel } from './router.mjs';

const withLimit = (chars) => {
  const old = process.env.CCHM_MAX_PROMPT_CHARS;
  process.env.CCHM_MAX_PROMPT_CHARS = String(chars);
  return () => {
    if (old === undefined) delete process.env.CCHM_MAX_PROMPT_CHARS;
    else process.env.CCHM_MAX_PROMPT_CHARS = old;
  };
};

const sizeOf = (p) => JSON.stringify(p.messages).length + JSON.stringify(p.system || '').length;

test('normalizeModel：claude-* 與未知名字都留在本機', () => {
  assert.match(normalizeModel('claude-sonnet-4-5'), /deepseek|glm|kimi|hy4/);
  assert.equal(normalizeModel('claude-opus-4-1'), normalizeModel('claude-sonnet-4-5'));
  assert.equal(normalizeModel('mimo-v2-flash'), normalizeModel('claude-sonnet-4-5'));
});

test('第 1 級沒有可修項時，會自動降到第 2 級，不再直接放棄', () => {
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 64000,
    context_management: { edits: [] },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ],
  };
  const fix = repairFor400(payload, 1);
  assert.ok(fix, '不該回 null');
  assert.equal(fix.body.context_management, undefined, 'context_management 應被移除');
  assert.equal(fix.body.max_tokens, 32000);
  assert.ok(fix.notes.some((n) => n.includes('context_management')), fix.notes.join('；'));
});

test('第 1 級：歷史 base64 圖片被換成佔位文字', () => {
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '看這張圖' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4096) } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ],
  };
  const fix = repairFor400(payload, 1);
  assert.ok(fix);
  const blk = fix.body.messages[0].content[1];
  assert.equal(blk.type, 'text');
  assert.match(blk.text, /歷史截圖已省略/);
  assert.equal(blk.source, undefined);
});

test('第 1 級：孤兒 tool_use／tool_result 被收掉', () => {
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'Bash', input: {} }] },
    ],
  };
  const fix = repairFor400(payload, 1);
  const blocks = fix.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.equal(blocks.filter((b) => b.type === 'tool_use').length, 0);
  assert.equal(blocks.filter((b) => b.type === 'tool_result').length, 0);
});

test('訊息少但每則巨大：會丟到不再超長（原本一律 400）', () => {
  const restore = withLimit(20000);
  try {
    const payload = {
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      messages: Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}:` + 'x'.repeat(10000),
      })),
    };
    const fix = repairFor400(payload, 1);
    assert.ok(fix, '不該回 null');
    assert.ok(sizeOf(fix.body) <= 20000, `仍超長：${sizeOf(fix.body)}`);
    assert.equal(fix.body.messages[0].role, 'user', '首則必須是 user');
    assert.ok(fix.notes.length > 0);
  } finally { restore(); }
});

test('單則就超長：截斷文字塊而不是直接失敗', () => {
  const restore = withLimit(5000);
  try {
    const payload = {
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: 'y'.repeat(50000) }],
    };
    const fix = repairFor400(payload, 1);
    assert.ok(fix, '不該回 null');
    assert.ok(fix.body.messages[0].content.length < 50000);
    assert.match(fix.body.messages[0].content, /已截斷/);
    assert.ok(fix.notes.some((n) => n.includes('截斷過長內容')), fix.notes.join('；'));
  } finally { restore(); }
});

test('丟訊息之後不會留下孤兒工具區塊', () => {
  const restore = withLimit(2000);
  try {
    const payload = {
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'z'.repeat(4000) }] },
        { role: 'assistant', content: 'w'.repeat(4000) },
        { role: 'user', content: 'tail' },
      ],
    };
    const fix = repairFor400(payload, 1);
    assert.ok(fix);
    const blocks = fix.body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const useIds = new Set(blocks.filter((b) => b.type === 'tool_use').map((b) => b.id));
    const orphanResults = blocks.filter((b) => b.type === 'tool_result' && !useIds.has(b.tool_use_id));
    assert.equal(orphanResults.length, 0, '不該留下孤兒 tool_result');
  } finally { restore(); }
});

test('沒有 messages 時回 null（讓呼叫端直接回 400）', () => {
  assert.equal(repairFor400({ model: 'x' }, 1), null);
  assert.equal(repairFor400({ model: 'x', messages: [] }, 1), null);
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSentences, judgeRewrites } from '../src/utils/jevClient.js';
import { MAX_ITEMS_PER_REQUEST } from '../src/config/jevQuestions.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 送られてきたitemsをそのまま「判定できた」ことにして返す偽のサーバー。 */
function fakeServer({ limit = MAX_ITEMS_PER_REQUEST, onBatch } = {}) {
  const batches = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    batches.push(body.items.length);
    onBatch?.(body);
    if (body.items.length > limit) {
      // api/jev.js と同じ拒否の仕方をする
      return new Response(JSON.stringify({ error: `items must be ${limit} or fewer (got ${body.items.length})` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      wallMs: 10,
      results: body.items.map((it) => ({
        id: it.id, ok: true, latencyMs: 5, usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          awkward: { type: 'score', score: 0.5, confidence: 0.9 },
          aiLike: { type: 'noul', noul: 0.1 },
          kind: { type: 'choice', choice: 'none', confidence: 0.9 },
          improved: { type: 'noul', noul: 0.9 },
          meaningKept: { type: 'noul', noul: 0.95 },
        },
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return batches;
}

const sentences = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: `${i}番目の文です。` }));

test('上限を超えた本文でも、分けて送って全件判定する', async () => {
  // 分けずに送ると、長い文書で1件も判定できない。長い文書ほど判定が要る。
  const batches = fakeServer();
  const { results } = await judgeSentences(sentences(150));
  assert.equal(results.length, 150);
  assert.deepEqual(batches, [64, 64, 22]);
  assert.equal(results.every((r) => r.ok), true);
});

test('分けて送っても入力の順に戻す', async () => {
  fakeServer();
  const { results } = await judgeSentences(sentences(100));
  assert.deepEqual(results.map((r) => r.id), sentences(100).map((s) => s.id));
});

test('上限ちょうどなら1回で送る', async () => {
  const batches = fakeServer();
  await judgeSentences(sentences(MAX_ITEMS_PER_REQUEST));
  assert.deepEqual(batches, [MAX_ITEMS_PER_REQUEST]);
});

test('途中で失敗したら、後続のリクエストを送らない', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ wallMs: 1, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(() => judgeSentences(sentences(200)));
  assert.equal(calls, 2, '倒れた時点で止まる');
});

test('まとめたときの所要時間を足し合わせる', async () => {
  fakeServer();
  const { wallMs } = await judgeSentences(sentences(130));
  assert.equal(wallMs, 30, '3回ぶん');
});

test('空の入力では一度も投げない', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  assert.deepEqual(await judgeSentences([]), { results: [], wallMs: 0 });
  assert.deepEqual(await judgeRewrites([]), { results: [], wallMs: 0 });
  assert.equal(calls, 0);
});

test('前後の文をstateに添える', async () => {
  let seen = null;
  fakeServer({ onBatch: (body) => { seen ??= body.items; } });
  await judgeSentences([
    { id: 'a', text: '前です。', after: '中です。' },
    { id: 'b', text: '中です。', before: '前です。', after: '後です。' },
  ]);
  assert.equal(seen[1].state.判定対象の文, '中です。');
  assert.equal(seen[1].state.直前の文, '前です。');
  assert.equal(seen[0].state.直前の文, undefined);
});

test('書き換えの検証も上限で分ける', async () => {
  const batches = fakeServer();
  const pairs = Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, original: `原文${i}`, rewritten: `書換${i}` }));
  const { results } = await judgeRewrites(pairs);
  assert.deepEqual(batches, [64, 6]);
  assert.equal(results.length, 70);
  assert.equal(results[0].gate.accept, true);
});

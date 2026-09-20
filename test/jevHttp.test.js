// 実際のHTTPを通す試験。
//
// これが無いと落とせない種類のバグがある。withClientAbortの最初の実装は
// reqの'close'を切断とみなしていたが、express.json()が本文を読み切った
// 時点でもそれは上がる。正常な往復を中断として扱い、応答を書かないまま
// 固まっていた。フェイクのreqを渡す単体試験はこれを通してしまう。

import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { respondToJev } from '../api/jev.js';

const realFetch = globalThis.fetch;
const QUESTIONS = { ok: { type: 'noul', instructions: 'これは日本語か' } };

const app = express();
app.use(express.json({ limit: '10mb' }));
app.post('/api/jev', (req, res) => respondToJev(req, res));
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
// 応答の返らないリクエストが残っているとcloseが返らず、試験の実行そのものが
// 終わらなくなる。失敗したときこそ終わってほしいので、接続ごと落とす。
after(() => { server.closeAllConnections?.(); server.close(); });

beforeEach(() => { process.env.TYPESAFE_API_KEY = 'test-key'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
});

/**
 * 上流のJevを装う。fetchはサーバー側の往復にだけ差し替わる。
 *
 * delayMsを0にしてはいけない。reqの'close'は本文を読み終えた時点、つまり
 * ほぼ0msで上がる。上流が即座に返すと、中断が届く前に往復が終わってしまい、
 * 壊れた実装でもこの試験が通る。実際の往復と同じく、時間のかかる上流で測る。
 */
function stubUpstream({ delayMs = 50, onCall } = {}) {
  const calls = [];
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push(url);
    onCall?.(init);
    // 本物のfetchは中断でrejectする。ここで無視すると、中断されても
    // 往復が成功してしまい、壊れた実装でもこの試験が通る。
    if (init?.signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      init?.signal?.removeEventListener('abort', onAbort);
      resolve(new Response(JSON.stringify({
        model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    init?.signal?.addEventListener('abort', onAbort, { once: true });
  });
  return calls;
}

// テスト側からサーバーを叩くのは素のfetch。差し替えたfetchはサーバー内で使う。
const post = (body, init = {}) => realFetch(`${base}/api/jev`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...init,
});

test('まとめ投げが応答を返す（固まらない）', async () => {
  stubUpstream({ delayMs: 50 });
  const res = await Promise.race([
    post({ items: [{ id: 'a', state: 'あ', questions: QUESTIONS }] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('応答が返らない')), 4000)),
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].ok, true);
});

test('単発も応答を返す', async () => {
  stubUpstream({ delayMs: 50 });
  const res = await Promise.race([
    post({ state: 'あ', questions: QUESTIONS }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('応答が返らない')), 4000)),
  ]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answers.ok.noul, 0.9);
});

test('上限を超える件数は400で返す', async () => {
  stubUpstream();
  const items = Array.from({ length: 65 }, (_, i) => ({ id: String(i), state: 'あ', questions: QUESTIONS }));
  const res = await post({ items });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /64 or fewer/);
});

test('形の壊れた項目は400で返す', async () => {
  stubUpstream();
  const res = await post({ items: [{ state: 'あ', questions: QUESTIONS }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /items\[0\]\.id/);
});

test('呼び出し元が切れたら、上流への往復を打ち切る', async () => {
  // 切れた相手のために外部APIを叩き続けない。
  let upstreamAborted = false;
  const calls = stubUpstream({
    delayMs: 3000,
    onCall: (init) => { init.signal?.addEventListener('abort', () => { upstreamAborted = true; }); },
  });

  const controller = new AbortController();
  const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), state: 'あ', questions: QUESTIONS }));
  const p = post({ items, concurrency: 2 }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await assert.rejects(() => p);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(upstreamAborted, true, '上流のfetchが中断されていない');
  assert.ok(calls.length < items.length, `中断後も投げ続けている: ${calls.length}件`);
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { systemOne, systemOneBatch, hasJevKey } from '../api/_jev.js';
import { handleJev } from '../api/jev.js';

const realFetch = globalThis.fetch;
const QUESTIONS = { ok: { type: 'noul', instructions: 'これは日本語か' } };

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

beforeEach(() => { process.env.TYPESAFE_API_KEY = 'test-key'; });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
});

test('鍵が無ければ投げる前に401にする', async () => {
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(hasJevKey(), false);
  await assert.rejects(() => systemOne({ state: 'あ', questions: QUESTIONS }), (e) => e.status === 401);
});

test('形の壊れた質問はネットワークに出す前に弾く', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(
    () => systemOne({ state: 'あ', questions: { bad: { type: 'score', criteria: ['1つだけ'] } } }),
    (e) => e.status === 400
  );
  assert.equal(called, false, '往復してから気づくと、どの文で壊れたか分からなくなる');
});

test('answersと所要時間とrequestIdを返す', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.state, 'これは日本語です。');
    return jsonResponse(
      { model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 12, output_tokens: 1 } },
      { headers: { 'x-typesafe-request-id': 'req_1' } }
    );
  };
  const r = await systemOne({ state: 'これは日本語です。', questions: QUESTIONS });
  assert.equal(r.answers.ok.noul, 0.97);
  assert.equal(r.requestId, 'req_1');
  assert.equal(typeof r.latencyMs, 'number');
});

test('429はRetry-Afterに従って引き直す', async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after-ms': '10' } });
    return jsonResponse({ model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.5 } }, usage: {} });
  };
  const r = await systemOne({ state: 'あ', questions: QUESTIONS });
  assert.equal(attempts, 2);
  assert.equal(r.answers.ok.noul, 0.5);
});

test('400は引き直さずそのまま返す', async () => {
  let attempts = 0;
  globalThis.fetch = async () => { attempts += 1; return jsonResponse({ error: 'bad' }, { status: 400 }); };
  await assert.rejects(() => systemOne({ state: 'あ', questions: QUESTIONS }), (e) => e.status === 400);
  assert.equal(attempts, 1);
});

test('応答が返らなければ待ち続けず504にする', async () => {
  // 遅れた判定は次の打鍵で上書きされて捨てられる。待ち続けるほうが画面は遅く見える。
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(
    () => systemOne({ state: 'あ', questions: QUESTIONS }, { timeoutMs: 10 }),
    (e) => e.status === 504 && /timed out/.test(e.message)
  );
});

test('呼び出し側の中断はタイムアウトと区別する', async () => {
  // 区別しないと、打鍵由来のキャンセルがベンチの遅延分布に混ざる。
  const controller = new AbortController();
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const p = systemOne({ state: 'あ', questions: QUESTIONS }, { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(() => p, (e) => e.status === 499);
});

test('まとめて投げたとき、1件の失敗で残りを落とさない', async () => {
  globalThis.fetch = async (url, init) => {
    const state = JSON.parse(init.body).state;
    if (state === 'ng') return jsonResponse({ error: 'nope' }, { status: 400 });
    return jsonResponse({ model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.8 } }, usage: {} });
  };
  const results = await systemOneBatch([
    { id: 'a', state: 'ok', questions: QUESTIONS },
    { id: 'b', state: 'ng', questions: QUESTIONS },
    { id: 'c', state: 'ok', questions: QUESTIONS },
  ]);
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['a', true], ['b', false], ['c', true]]);
  assert.match(results[1].error, /400/);
});

test('並列数を超えて同時に投げない', async () => {
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return jsonResponse({ model: 'jev-1', answers: {}, usage: {} });
  };
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), state: 'あ', questions: QUESTIONS }));
  await systemOneBatch(items, { concurrency: 3 });
  assert.equal(peak, 3);
});

test('1リクエストで受ける件数に上限を置く', async () => {
  // 上限が無いと、長い本文の1打鍵で数百件をJevに投げることになる。
  const items = Array.from({ length: 65 }, (_, i) => ({ id: String(i), state: 'あ', questions: QUESTIONS }));
  await assert.rejects(() => handleJev({ items }, {}), (e) => e.status === 400 && /64 or fewer/.test(e.message));
});

test('まとめたときの実時間を返す', async () => {
  globalThis.fetch = async () => jsonResponse({ model: 'jev-1', answers: {}, usage: {} });
  let payload = null;
  const res = { status: () => ({ json: (b) => { payload = b; } }) };
  await handleJev({ items: [{ id: 'a', state: 'あ', questions: QUESTIONS }] }, res);
  assert.equal(payload.results.length, 1);
  assert.equal(typeof payload.wallMs, 'number');
});

test('TYPESAFE_BASE_URLで宛先を差し替えられる', async () => {
  // ベンチを記録した応答で回すとき、ここを差し替える。
  process.env.TYPESAFE_BASE_URL = 'http://localhost:9999/';
  let seen = '';
  globalThis.fetch = async (url) => { seen = url; return jsonResponse({ model: 'jev-1', answers: {}, usage: {} }); };
  await systemOne({ state: 'あ', questions: QUESTIONS });
  assert.equal(seen, 'http://localhost:9999/v1/systemone');
});

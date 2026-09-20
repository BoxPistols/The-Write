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

// ─── 宛先の検証 ────────────────────────────────────
// BearerのAPIキーを載せる先なので、経路が平文になる設定を通さない。

test('非ループバックのhttpは宛先にしない', async () => {
  process.env.TYPESAFE_BASE_URL = 'http://jev.example.com';
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(
    () => systemOne({ state: 'あ', questions: QUESTIONS }),
    (e) => e.status === 500 && /https/.test(e.message)
  );
  assert.equal(called, false, 'APIキーを平文の経路に載せてはいけない');
});

test('ループバックのhttpは通す', async () => {
  // tools/jev-stub.mjs が手元に立つ。
  for (const base of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    process.env.TYPESAFE_BASE_URL = base;
    let seen = '';
    globalThis.fetch = async (url) => { seen = url; return jsonResponse({ model: 'jev-1', answers: {}, usage: {} }); };
    await systemOne({ state: 'あ', questions: QUESTIONS });
    assert.equal(seen, `${base}/v1/systemone`);
  }
});

test('URLとして読めない宛先は弾く', async () => {
  process.env.TYPESAFE_BASE_URL = 'not a url';
  await assert.rejects(() => systemOne({ state: 'あ', questions: QUESTIONS }), (e) => e.status === 500);
});

// ─── 中断 ──────────────────────────────────────────

test('中断済みで呼ばれたら、1回もfetchしない', async () => {
  // addEventListenerは中断済みのsignalに対して発火しない。先に見ないと
  // すでに中断された呼び出しでも1回目のfetchが出る。
  const controller = new AbortController();
  controller.abort();
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(
    () => systemOne({ state: 'あ', questions: QUESTIONS }, { signal: controller.signal }),
    (e) => e.status === 499
  );
  assert.equal(called, false);
});

test('再試行の待ちのあいだに中断されたら、次のfetchを始めない', async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // 1回目の応答を返した直後に中断する。以降は待ちに入っている。
    queueMicrotask(() => controller.abort());
    return jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after-ms': '500' } });
  };
  await assert.rejects(
    () => systemOne({ state: 'あ', questions: QUESTIONS }, { signal: controller.signal }),
    (e) => e.status === 499
  );
  assert.equal(calls, 1);
});

test('中断はbatch全体を止め、部分結果を返さない', async () => {
  // 項目の失敗と同じ扱いにすると、打鍵で中断したあとも残りの文を投げ続け、
  // 誰も見ない判定に費用を払うことになる。
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    return jsonResponse({ model: 'jev-1', answers: {}, usage: {} });
  };
  const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), state: 'あ', questions: QUESTIONS }));
  await assert.rejects(
    () => systemOneBatch(items, { concurrency: 2, signal: controller.signal }),
    (e) => e.status === 499
  );
  assert.ok(calls < items.length, `中断後も投げ続けている: ${calls}件`);
});

test('呼び出し元が切れたら、下流の往復も止める', async () => {
  const { withClientAbort } = await import('../api/jev.js');
  const listeners = new Map();
  const req = {
    on: (ev, fn) => listeners.set(ev, fn),
    off: (ev) => listeners.delete(ev),
  };
  let seenAborted = false;
  const p = withClientAbort(req, {}, async (signal) => {
    listeners.get('close')();          // 接続が切れた
    seenAborted = signal.aborted;
  });
  await p;
  assert.equal(seenAborted, true);
  assert.equal(listeners.has('close'), false, '後始末でリスナーを外す');
});

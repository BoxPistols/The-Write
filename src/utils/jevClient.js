// 画面からJevを呼ぶ口。鍵はサーバー側に置くので、ここは /api/jev を叩くだけにする。
// 閾値はsrc/config/jevQuestions.jsのverdictOfに任せ、ここでは判定しない。

import {
  SENTENCE_QUESTIONS, REWRITE_QUESTIONS, MAX_ITEMS_PER_REQUEST, verdictOf, gateOf,
} from '../config/jevQuestions.js';

/**
 * 1文ぶんのstateを組む。
 * 前後の文を添えるのは、指示語や省略された主語を「不明瞭」と誤って落とさないため。
 * 前後まで判定させたいわけではないので、見出しは「判定対象」と分ける。
 */
export function sentenceState(sentence, { before = '', after = '', purpose = '' } = {}) {
  const state = { 判定対象の文: sentence };
  if (before) state.直前の文 = before;
  if (after) state.直後の文 = after;
  if (purpose) state.文書の目的 = purpose;
  return state;
}

/**
 * 配列をn件ずつに割る。
 * @param {Array} xs
 * @param {number} n
 * @returns {Array<Array>}
 */
const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * /api/jev を1回叩く。エラー本文があれば、その文言をそのまま投げ直す。
 * @param {object} payload
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
async function postJev(payload, signal) {
  const res = await fetch('/api/jev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { const err = await res.json(); detail = err.error || ''; } catch { /* 本文が無いこともある */ }
    throw new Error(detail || `Jev error: ${res.status}`);
  }
  return res.json();
}

/**
 * まとめ投げを上限ごとに分けて送り、入力の順に戻す。
 *
 * 分けずに送ると、上限を超えた本文では1件も判定できない。長い文書ほど
 * 判定が要るので、そこで黙って全部落ちるのがいちばん困る。
 *
 * 順番に送るのは、中断と失敗を後続へそのまま伝えるため。並べて送ると、
 * 1つが倒れても残りが走り切ってしまう。
 *
 * @param {Array} items
 * @param {{clientKeys?: object, concurrency?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{results: Array, wallMs: number}>}
 */
async function postItems(items, { clientKeys, concurrency, signal } = {}) {
  let wallMs = 0;
  const results = [];
  for (const batch of chunk(items, MAX_ITEMS_PER_REQUEST)) {
    const data = await postJev({ items: batch, clientKeys, concurrency }, signal);
    wallMs += data.wallMs || 0;
    results.push(...data.results);
  }
  return { results, wallMs };
}

/**
 * 文の配列をまとめて判定する。返り値の並びは入力と同じ。
 * 失敗した文はflagged:falseではなくok:falseで返す。「指摘なし」と
 * 「判定できなかった」を同じ形にすると、画面で緑を出してしまう。
 *
 * @param {Array<{id: string, text: string, before?: string, after?: string}>} sentences
 * @param {{purpose?: string, clientKeys?: object, signal?: AbortSignal, concurrency?: number}} [options]
 * @returns {Promise<{results: Array<{id: string, ok: boolean, verdict?: object, usage?: object, latencyMs: number, error?: string}>, wallMs: number}>}
 */
export async function judgeSentences(sentences, options = {}) {
  if (!sentences.length) return { results: [], wallMs: 0 };

  const items = sentences.map((s) => ({
    id: s.id,
    state: sentenceState(s.text, { before: s.before, after: s.after, purpose: options.purpose }),
    questions: SENTENCE_QUESTIONS,
  }));

  const data = await postItems(items, options);

  return {
    wallMs: data.wallMs,
    results: data.results.map((r) => (r.ok
      ? { id: r.id, ok: true, verdict: verdictOf(r.answers), answers: r.answers, usage: r.usage, latencyMs: r.latencyMs }
      : { id: r.id, ok: false, latencyMs: r.latencyMs, error: r.error })),
  };
}

/**
 * 書き換えの前後を突き合わせ、採用してよいかを返す。
 * 生成モデルの出力をそのまま本文に入れないための関門で、
 * 意味が変わった書き換えはここで止める。
 *
 * @param {Array<{id: string, original: string, rewritten: string}>} pairs
 * @returns {Promise<{results: Array<{id: string, ok: boolean, gate?: object, error?: string, latencyMs: number}>, wallMs: number}>}
 */
export async function judgeRewrites(pairs, options = {}) {
  if (!pairs.length) return { results: [], wallMs: 0 };

  const items = pairs.map((p) => ({
    id: p.id,
    state: { 原文: p.original, 書き換え後: p.rewritten },
    questions: REWRITE_QUESTIONS,
  }));

  const data = await postItems(items, options);

  return {
    wallMs: data.wallMs,
    results: data.results.map((r) => (r.ok
      ? { id: r.id, ok: true, gate: gateOf(r.answers), answers: r.answers, usage: r.usage, latencyMs: r.latencyMs }
      : { id: r.id, ok: false, latencyMs: r.latencyMs, error: r.error })),
  };
}

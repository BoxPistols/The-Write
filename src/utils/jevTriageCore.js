// 入力中のトリアージの、Reactに依らない部分。
// フックに全部書くと打鍵のたびの挙動を確かめられなくなるので、
// 「何を投げ直すか」「どう畳むか」はここに置いてテストする。

import { hashSentence } from './sentences.js';

/**
 * 画面へ返す単位。
 * 転送の上限を守るのはjevClient側の仕事で、ここはそれより細かく刻んで
 * 途中経過を出すためにある。大きくすると最初の下線が出るまで待たされ、
 * 小さくするとリクエストの数だけ増える。
 */
export const CHUNK_SIZE = 32;

/**
 * 文の内容で引ける判定の置き場。
 * 打鍵のたびに全文を投げ直さないためのもので、直したのが1文なら
 * 投げ直すのも1文で済む。古い順に捨てる素朴なLRUで足りる。
 */
export function makeVerdictCache(limit = 500) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      // 取り出して入れ直すと、Mapの挿入順がそのまま参照順になる
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    has: (key) => map.has(key),
    get size() { return map.size; },
    clear: () => map.clear(),
  };
}

/**
 * 今の本文と手元の判定を突き合わせ、投げ直す文だけを選ぶ。
 * 同じ文が本文に2回出てきたら、判定は1回で足りる。
 *
 * saltには「文以外で判定を変えるもの」を渡す。今は文書の目的で、これを
 * 鍵に混ぜないと、目的を切り替えても前の目的の判定が使い回される。
 *
 * @param {Array<{text: string, start: number, end: number, index: number}>} sentences
 * @param {ReturnType<typeof makeVerdictCache>} cache
 * @param {string} [salt] 文書の目的など、判定の前提が変わるもの
 * @returns {{units: Array, toJudge: Array, cachedCount: number}}
 */
export function planJudgements(sentences, cache, salt = '') {
  const units = sentences.map((s, i) => ({
    ...s,
    key: hashSentence(salt ? `${salt}\u0000${s.text}` : s.text),
    before: sentences[i - 1]?.text || '',
    after: sentences[i + 1]?.text || '',
  }));

  const toJudge = [];
  const queued = new Set();
  let cachedCount = 0;

  for (const u of units) {
    if (cache.has(u.key)) { cachedCount += 1; continue; }
    if (queued.has(u.key)) continue;
    queued.add(u.key);
    toJudge.push(u);
  }

  return { units, toJudge, cachedCount };
}

/** まとめ投げを上限ごとに割る。 */
export function chunk(items, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 判定を1つの数字に畳む。
 *
 * 文字数で重みを付けるのは、長い1文の違和感が短い1文と同じ重さになると、
 * 本文の読み心地と数字がずれるため。
 *
 * naturalnessは「違和感のなさ」を0〜100で出したもの。
 * 判定の済んでいない文は分母に入れない。未判定を「自然」として数えると、
 * 打鍵した直後にスコアが跳ね上がり、下がってくる動きになる。
 * 代わりにcoverageで「どこまで見たか」を別に出す。
 */
export function summarize(units, verdicts) {
  const counts = { error: 0, warn: 0, info: 0 };
  let weighted = 0;
  let weight = 0;
  let judged = 0;
  let flagged = 0;

  for (const u of units) {
    const v = verdicts.get(u.key);
    if (!v) continue;
    judged += 1;
    const w = Math.max(1, u.text.length);
    weighted += v.awkward * w;
    weight += w;
    if (v.flagged) {
      flagged += 1;
      counts[v.severity] += 1;
    }
  }

  const awkward = weight ? weighted / weight : 0;
  return {
    total: units.length,
    judged,
    flagged,
    counts,
    awkward,
    // AWKWARD_LEVELSは0〜4の5段階。上限で割って百分率に直す。
    naturalness: weight ? Math.round((1 - awkward / 4) * 100) : null,
    coverage: units.length ? judged / units.length : 0,
  };
}

/**
 * 生成モデルに送る本文を、指摘の立った文だけに絞る。
 * 隣り合う文はまとめて1つの塊にする。細切れにすると、生成側が
 * 前後の関係を見失って同じ主語を何度も足す。
 *
 * 塊の中は本文から切り出す。文をつなぎ直すと、改行で区切られていた見出しや
 * 箇条書きが1行に潰れ（「はじめに本記事では…- 最適化を行う」）、生成側が返す
 * originalが本文のどこにも無い文字列になって、差し替えが効かなくなる。
 *
 * @param {Array} units
 * @param {Map} verdicts
 * @param {string} [text] 本文。渡すと塊の中を原文のまま切り出す
 * @returns {{text: string, sentences: Array, skipped: number}}
 */
export function triageScope(units, verdicts, text = null) {
  const picked = units.filter((u) => verdicts.get(u.key)?.flagged);
  if (!picked.length) return { text: '', sentences: [], skipped: units.length };

  const blocks = [];
  let current = null;
  for (const u of picked) {
    if (current && u.index === current.lastIndex + 1) {
      current.gaps.push(u.start - current.end);
      current.parts.push(u.text);
      current.end = u.end;
      current.lastIndex = u.index;
    } else {
      current = { parts: [u.text], gaps: [], start: u.start, end: u.end, lastIndex: u.index };
      blocks.push(current);
    }
  }

  // 本文があれば、塊の中はそこから切り出す。無いときは、文のオフセットから
  // 間に何か挟まっていたかだけは分かるので、隙間のある境目に改行を入れる。
  // 何も入れずにつなぐと、改行で区切られていた行が1行に潰れる。
  const glue = (b) => b.parts.reduce((acc, part, i) => (
    i === 0 ? part : acc + (b.gaps[i - 1] > 0 ? '\n' : '') + part
  ), '');
  const cut = (b) => (typeof text === 'string' ? text.slice(b.start, b.end) : glue(b));

  return {
    text: blocks.map(cut).join('\n'),
    sentences: picked,
    skipped: units.length - picked.length,
  };
}

// 測った値を畳む。ここに実行は入れない。入れると、数字の出し方を確かめるのに
// APIを叩くことになる。

/** 昇順に並べてからp分位を線形補間で取る。件数が少ないので素直に計算する。 */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const pos = (xs.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export const mean = (values) => {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};

/**
 * 「手を入れるべき文」を当てられたかを数える。
 *
 * precisionだけを見ると、何も指摘しない実装が満点になる。recallだけを見ると、
 * 全部に指摘を出す実装が満点になる。両方とF1を並べて出す。
 *
 * @param {Array<{gold: 'ok'|'ng', pred: boolean}>} pairs
 */
export function prf(pairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { gold, pred } of pairs) {
    if (gold === 'ng' && pred) tp += 1;
    else if (gold === 'ok' && pred) fp += 1;
    else if (gold === 'ng' && !pred) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return { tp, fp, fn, tn, precision, recall, f1, total: pairs.length };
}

/**
 * 100万トークンあたりの単価から費用を出す。
 * 単価が分からないものはnullを返す。0として足すと、合計が安いほうに寄って嘘になる。
 */
export function costUsd(usage, price) {
  if (!price || price.input == null || price.output == null) return null;
  const input = (usage?.input_tokens || 0) / 1e6 * price.input;
  const output = (usage?.output_tokens || 0) / 1e6 * price.output;
  return input + output;
}

/** 合計。1つでもnullがあれば合計もnullにする。 */
export function sumOrNull(values) {
  if (values.some((v) => v == null)) return null;
  return values.reduce((a, b) => a + b, 0);
}

export const addUsage = (a, b) => ({
  input_tokens: (a?.input_tokens || 0) + (b?.input_tokens || 0),
  output_tokens: (a?.output_tokens || 0) + (b?.output_tokens || 0),
});

/**
 * 生成モデルが返した指摘を文に割り当てる。
 * originalは原文の一部なので、それを含む文を探す。
 * どの文にも当たらない指摘（原文に無い文字列を返してきた場合）は数に入れず、
 * unmatchedとして別に出す。黙って捨てると、生成側の的外れが見えなくなる。
 */
export function mapSuggestionsToSentences(suggestions, sentences) {
  const hit = new Set();
  let unmatched = 0;
  for (const s of suggestions) {
    const original = (s?.original || '').trim();
    if (!original) { unmatched += 1; continue; }
    const found = sentences.find((x) => x.text.includes(original) || original.includes(x.text));
    if (found) hit.add(found.id);
    else unmatched += 1;
  }
  return { flagged: hit, unmatched };
}

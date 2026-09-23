import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, hashSentence } from '../src/utils/sentences.js';
import { makeVerdictCache, planJudgements, chunk, summarize, triageScope } from '../src/utils/jevTriageCore.js';

const verdict = (awkward, flagged, severity = 'warn') => ({ awkward, flagged, severity, aiLike: 0, kind: 'style', confidence: 0.9 });

test('手元にある文は投げ直さない', () => {
  const cache = makeVerdictCache();
  const sentences = splitSentences('一つ目です。二つ目です。三つ目です。');
  cache.set(hashSentence('一つ目です。'), verdict(0.2, false));

  const { toJudge, cachedCount } = planJudgements(sentences, cache);
  assert.equal(cachedCount, 1);
  assert.deepEqual(toJudge.map((u) => u.text), ['二つ目です。', '三つ目です。']);
});

test('1文だけ直したら、投げ直すのも1文で済む', () => {
  // これが無いと、打鍵のたびに全文ぶんのリクエストが出る。
  const cache = makeVerdictCache();
  for (const s of splitSentences('一つ目です。二つ目です。三つ目です。')) {
    cache.set(hashSentence(s.text), verdict(0.2, false));
  }
  const after = splitSentences('一つ目です。二つ目でした。三つ目です。');
  const { toJudge } = planJudgements(after, cache);
  assert.deepEqual(toJudge.map((u) => u.text), ['二つ目でした。']);
});

test('同じ文が2回出てきても判定は1回だけ投げる', () => {
  const { toJudge } = planJudgements(splitSentences('同じです。同じです。'), makeVerdictCache());
  assert.equal(toJudge.length, 1);
});

test('前後の文を添える', () => {
  const { units } = planJudgements(splitSentences('前です。中です。後です。'), makeVerdictCache());
  assert.equal(units[1].before, '前です。');
  assert.equal(units[1].after, '後です。');
  assert.equal(units[0].before, '');
});

test('古い判定から捨てる', () => {
  const cache = makeVerdictCache(2);
  cache.set('a', 1); cache.set('b', 2);
  cache.get('a');          // aを参照したので、次に捨てるのはb
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 2);
});

test('上限ごとに割る', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test('未判定の文は自然として数えない', () => {
  // 数えると、打鍵した直後にスコアが跳ね上がって下がってくる動きになる。
  const units = splitSentences('短い。とても長くて読みにくい文がここにあります。').map((s) => ({ ...s, key: hashSentence(s.text) }));
  const verdicts = new Map([[units[0].key, verdict(0, false)]]);
  const sum = summarize(units, verdicts);
  assert.equal(sum.judged, 1);
  assert.equal(sum.total, 2);
  assert.equal(sum.coverage, 0.5);
  assert.equal(sum.naturalness, 100);
});

test('長い文の違和感を短い文と同じ重さにしない', () => {
  const short = { text: 'あ。', key: 'k1' };
  const long = { text: 'あ'.repeat(99) + '。', key: 'k2' };
  const verdicts = new Map([['k1', verdict(0, false)], ['k2', verdict(4, true, 'error')]]);
  const sum = summarize([short, long], verdicts);
  // 単純平均なら2.0。文字数で重みを付けるので4寄りになる。
  assert.ok(sum.awkward > 3.5, `awkward=${sum.awkward}`);
  assert.equal(sum.counts.error, 1);
  assert.equal(sum.flagged, 1);
});

test('1文も判定できていなければスコアを出さない', () => {
  const sum = summarize([{ text: 'あ。', key: 'k' }], new Map());
  assert.equal(sum.naturalness, null);
});

test('指摘の立った文だけを生成モデルに送る', () => {
  const units = splitSentences('自然な文です。不自然な文でございますです。また自然。').map((s) => ({ ...s, key: hashSentence(s.text) }));
  const verdicts = new Map(units.map((u, i) => [u.key, verdict(i === 1 ? 3 : 0.2, i === 1)]));
  const scope = triageScope(units, verdicts);
  assert.equal(scope.text, '不自然な文でございますです。');
  assert.equal(scope.skipped, 2);
});

test('隣り合う指摘はまとめて1つの塊にする', () => {
  // 細切れにすると、生成側が前後の関係を見失って同じ主語を何度も足す。
  const units = splitSentences('一。二。三。四。').map((s) => ({ ...s, key: hashSentence(s.text) }));
  const verdicts = new Map(units.map((u, i) => [u.key, verdict(3, i === 0 || i === 1 || i === 3)]));
  const scope = triageScope(units, verdicts);
  assert.deepEqual(scope.text.split('\n'), ['一。二。', '四。']);
});

test('1件も立たなければ送る本文は空になる', () => {
  const units = splitSentences('自然です。これも自然です。').map((s) => ({ ...s, key: hashSentence(s.text) }));
  const verdicts = new Map(units.map((u) => [u.key, verdict(0.1, false)]));
  const scope = triageScope(units, verdicts);
  assert.equal(scope.text, '');
  assert.equal(scope.sentences.length, 0);
});

test('塊の中は本文から切り出す（改行を潰さない）', () => {
  // つなぎ直すと、見出しや箇条書きが1行に潰れる。潰れた本文を送ると、
  // 生成側が返すoriginalが本文のどこにも無い文字列になり、差し替えが効かない。
  const text = 'はじめに\n本記事では、業務を最適化する方法を解説します。\n- 最適化を行う\n- 価値を最大化する';
  const units = splitSentences(text).map((s) => ({ ...s, key: hashSentence(s.text) }));
  const verdicts = new Map(units.map((u) => [u.key, verdict(3, true)]));
  const scope = triageScope(units, verdicts, text);
  assert.equal(scope.text, text);
  for (const u of units) assert.ok(scope.text.includes(u.text), u.text);
});

test('文書の目的が変われば判定を引き直す', () => {
  const sentences = splitSentences('これは文です。');
  const cache = makeVerdictCache();
  const a = planJudgements(sentences, cache, 'メール');
  cache.set(a.units[0].key, verdict(1, false));

  // 同じ目的なら手元の判定で足りる
  assert.equal(planJudgements(sentences, cache, 'メール').toJudge.length, 0);
  // 目的が変われば前提が変わるので、引き直す
  assert.equal(planJudgements(sentences, cache, '社内向けの共有').toJudge.length, 1);
});

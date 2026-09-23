import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, mean, prf, costUsd, sumOrNull, mapSuggestionsToSentences } from '../bench/metrics.mjs';

test('分位を線形補間で取る', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([], 0.5), null);
});

test('数えられない値は平均から外す', () => {
  assert.equal(mean([1, 2, null, undefined, 3]), 2);
  assert.equal(mean([]), null);
});

test('何も指摘しない実装はrecallが0になる', () => {
  // precisionだけを見ていると、この実装が満点に見える。
  const r = prf([{ gold: 'ng', pred: false }, { gold: 'ok', pred: false }]);
  assert.equal(r.precision, null);
  assert.equal(r.recall, 0);
  assert.equal(r.f1, null);
});

test('全部に指摘を出す実装はprecisionが下がる', () => {
  const r = prf([{ gold: 'ng', pred: true }, { gold: 'ok', pred: true }]);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 0.5);
  assert.ok(Math.abs(r.f1 - 2 / 3) < 1e-9);
});

test('単価が分からなければ費用はnullにする', () => {
  // 0として足すと、合計が安いほうに寄って嘘になる。
  assert.equal(costUsd({ input_tokens: 1000, output_tokens: 10 }, null), null);
  assert.equal(costUsd({ input_tokens: 1000 }, { input: 1, output: null }), null);
  assert.equal(costUsd({ input_tokens: 1e6, output_tokens: 1e6 }, { input: 0.2, output: 1.2 }), 1.4);
});

test('1つでも欠けている合計はnullにする', () => {
  assert.equal(sumOrNull([1, 2, 3]), 6);
  assert.equal(sumOrNull([1, null]), null);
});

test('指摘を文に割り当てる', () => {
  const sentences = [{ id: 'a', text: 'これは自然な文です。' }, { id: 'b', text: '不自然なな文です。' }];
  const r = mapSuggestionsToSentences([{ original: '不自然なな' }], sentences);
  assert.deepEqual([...r.flagged], ['b']);
  assert.equal(r.unmatched, 0);
});

test('原文に無い指摘は当たりにせず、別に数える', () => {
  // 黙って捨てると、生成側の的外れが見えなくなる。
  const sentences = [{ id: 'a', text: 'これは自然な文です。' }];
  const r = mapSuggestionsToSentences([{ original: 'どこにも無い' }, { original: '' }], sentences);
  assert.equal(r.flagged.size, 0);
  assert.equal(r.unmatched, 2);
});

test('複数の文にまたがる指摘は、またいだ文すべてに当てる', () => {
  // 先頭の1文だけに当てると、その指摘で拾えていた残りの文がrecallから落ちる。
  const sentences = [
    { id: 'a', text: '不自然なな文です。' },
    { id: 'b', text: 'これも不自然でございますです。' },
    { id: 'c', text: '自然な文です。' },
  ];
  const r = mapSuggestionsToSentences([{ original: '不自然なな文です。これも不自然でございますです。' }], sentences);
  assert.deepEqual([...r.flagged].sort(), ['a', 'b']);
  assert.equal(r.unmatched, 0);
});

test('どの文か決まらない指摘は、当てたうえで別に数える', () => {
  const sentences = [{ id: 'a', text: '最適化します。' }, { id: 'b', text: '最適化しました。' }];
  const r = mapSuggestionsToSentences([{ original: '最適化' }], sentences);
  assert.equal(r.ambiguous, 1);
  assert.equal(r.unmatched, 0);
  assert.equal(r.flagged.size, 1);
});

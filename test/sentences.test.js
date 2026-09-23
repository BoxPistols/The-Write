import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, hashSentence } from '../src/utils/sentences.js';

test('句点で切り、オフセットを本文に一致させる', () => {
  const text = '私は行った。彼は来なかった。';
  const out = splitSentences(text);
  assert.equal(out.length, 2);
  assert.equal(out[1].text, '彼は来なかった。');
  assert.equal(text.slice(out[1].start, out[1].end), '彼は来なかった。');
});

test('括弧の中の句点では切らない', () => {
  const out = splitSentences('彼は「本当ですか。」と言った。');
  assert.equal(out.length, 1);
});

test('連続する終止記号と閉じ括弧は同じ文に含める', () => {
  const out = splitSentences('まさか！？（本当に）');
  assert.equal(out[0].text, 'まさか！？');
});

test('改行は常に境界にする', () => {
  const out = splitSentences('見出し\n本文です。');
  assert.deepEqual(out.map((s) => s.text), ['見出し', '本文です。']);
});

test('閉じていない括弧を改行で捨て、以降を飲み込まない', () => {
  // 入力中の本文には閉じていない「が残る。捨てないと残り全部が1文になり、
  // 打鍵のたびに全文を1回のJev判定に押し込むことになる。
  const out = splitSentences('彼は「言いかけた\n次の行です。さらに次。');
  assert.equal(out.length, 3);
  assert.equal(out[2].text, 'さらに次。');
});

test('空白だけの断片は返さない', () => {
  assert.deepEqual(splitSentences('。\n\n  \n本文。').map((s) => s.text), ['本文。']);
});

test('空文字と非文字列を受けても落ちない', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
});

test('同じ文は同じ鍵になり、1文字違えば変わる', () => {
  assert.equal(hashSentence('これは文です。'), hashSentence('これは文です。'));
  assert.notEqual(hashSentence('これは文です。'), hashSentence('これは文でず。'));
  assert.match(hashSentence('あ'), /^[0-9a-f]{8}$/);
});

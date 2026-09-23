import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitSentences } from '../src/utils/sentences.js';
import { assemble, buildDocuments } from '../bench/documents.mjs';

const corpus = JSON.parse(readFileSync(new URL('../bench/corpus.ja.json', import.meta.url), 'utf8'));

test('コーパスの形が揃っている', () => {
  const ids = new Set();
  for (const s of corpus.sentences) {
    assert.ok(s.id && s.text, JSON.stringify(s));
    assert.ok(['ok', 'ng'].includes(s.gold), s.id);
    assert.equal(ids.has(s.id), false, `idが重複: ${s.id}`);
    ids.add(s.id);
  }
  const ng = corpus.sentences.filter((s) => s.gold === 'ng').length;
  const ok = corpus.sentences.length - ng;
  // どちらかに寄っていると、precisionかrecallのどちらかが測れなくなる
  assert.ok(Math.abs(ng - ok) <= 3, `ok=${ok} ng=${ng}`);
});

test('goldがngの文には区分が付いている', () => {
  for (const s of corpus.sentences) {
    if (s.gold === 'ng') assert.notEqual(s.kind, 'none', s.id);
    else assert.equal(s.kind, 'none', s.id);
  }
});

test('終止記号で終わらない文の後ろは改行で区切る', () => {
  // 区切らないと次の文とつながり、文の数が合わなくなる。
  const sents = [{ text: '句点が無い文です' }, { text: '次の文です。' }];
  assert.equal(assemble(sents), '句点が無い文です\n次の文です。');
});

test('組み立てた文書を文に割り戻せる', () => {
  // 割り戻せないまま測ると、goldと予測の対応がずれて精度の数字が意味を失う。
  for (const doc of buildDocuments(corpus.sentences, [8, 20, 40])) {
    const split = splitSentences(doc.text);
    assert.equal(split.length, doc.sentences.length, doc.id);
    assert.deepEqual(split.map((s) => s.text), doc.sentences.map((s) => s.text), doc.id);
  }
});

test('文書にokとngの両方が入る', () => {
  for (const doc of buildDocuments(corpus.sentences, [8, 20, 40])) {
    const ng = doc.sentences.filter((s) => s.gold === 'ng').length;
    assert.ok(ng > 0 && ng < doc.sentences.length, `${doc.id}: ng=${ng}`);
  }
});

test('同じ種から同じ文書ができる', () => {
  const a = buildDocuments(corpus.sentences, [20]);
  const b = buildDocuments(corpus.sentences, [20]);
  assert.equal(a[0].text, b[0].text);
});

test('1項目が2文に割れるコーパスは、組み立てる前に弾く', () => {
  // 組み立ててから気づくと、どの項目が原因か分からないまま落ちる。
  const broken = [
    { id: 'x1', gold: 'ok', text: '自然な文です。' },
    { id: 'x2', gold: 'ng', text: '二文です。これで二つ目。' },
  ];
  assert.throws(() => buildDocuments(broken, [2]), /x2/);
});

test('コーパスの全文を使い切る大きさでも文に割り戻せる', () => {
  // 既定の大きさだけ試していると、割り戻せない項目を見落とす。
  for (const size of [8, 20, 40, corpus.sentences.length]) {
    const [doc] = buildDocuments(corpus.sentences, [size]);
    assert.equal(splitSentences(doc.text).length, doc.sentences.length, `size=${size}`);
  }
});

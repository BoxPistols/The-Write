// コーパスの文から、測定用の文書を組み立てる。
//
// 文書にしてから測るのは、今のアプリが本文を丸ごと生成モデルに渡しているため。
// 文を1つずつ投げて比べると、実際に払っているコストと合わない。
//
// 組み立てたあと、文に割り戻せることを必ず確かめる。割り戻せないまま測ると、
// goldと予測の対応がずれ、精度の数字が意味を失う。

import { splitSentences } from '../src/utils/sentences.js';

/** 同じ並びを何度でも作れるようにする線形合同法。無作為である必要はない。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const TERMINATORS = ['。', '！', '？', '.', '!', '?'];

/**
 * 文を並べて本文にする。終止記号で終わっていない文の後ろは改行で区切る。
 * 区切らないと次の文とつながり、文の数が合わなくなる。
 */
export function assemble(sentences, perParagraph = 4) {
  let out = '';
  sentences.forEach((s, i) => {
    out += s.text;
    const last = i === sentences.length - 1;
    if (last) return;
    const ended = TERMINATORS.some((t) => s.text.endsWith(t));
    const paragraphBreak = (i + 1) % perParagraph === 0;
    out += (!ended || paragraphBreak) ? '\n' : '';
  });
  return out;
}

/**
 * okとngを混ぜた文書を組む。
 * @param {Array} corpus corpus.ja.json の sentences
 * @param {number[]} sizes 文書ごとの文数
 */
export function buildDocuments(corpus, sizes = [8, 20, 40], seed = 20260920) {
  const rand = rng(seed);
  const shuffle = (xs) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const ok = shuffle(corpus.filter((s) => s.gold === 'ok'));
  const ng = shuffle(corpus.filter((s) => s.gold === 'ng'));

  const docs = [];
  for (const size of sizes) {
    const picked = [];
    // okとngを交互に取り、足りなくなったら残っている側から補う。
    // 片寄せにすると、precisionとrecallのどちらかが測れなくなる。
    for (let i = 0; i < size; i += 1) {
      const fromOk = i % 2 === 0;
      const pool = fromOk ? ok : ng;
      const other = fromOk ? ng : ok;
      const s = pool[Math.floor(i / 2) % pool.length] || other[i % other.length];
      picked.push(s);
    }
    // 同じ文が2回入ると、文への割り戻しが一意でなくなる
    const seen = new Set();
    const unique = picked.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));

    const text = assemble(unique);
    const split = splitSentences(text);
    if (split.length !== unique.length) {
      throw new Error(`文書を文に割り戻せない: 組み立て${unique.length}件 / 分割${split.length}件`);
    }
    docs.push({ id: `doc${unique.length}`, sentences: unique, text, chars: text.length });
  }
  return docs;
}

// 日本語の文分割。Jevには文単位で投げるので、判定を本文の位置に戻せるよう
// 文字列ではなくオフセット付きで返す。位置が無いと下線も差し替えも打てない。

// 文末として扱う記号。「…」は「…。」のように文中にも出るので単独では切らない。
const TERMINATORS = new Set(['。', '．', '！', '？', '!', '?']);

// 括弧の中の「。」で切ると引用が壊れるので、開いている間は文末を見ない。
const OPENERS = {
  '「': '」', '『': '』', '（': '）', '(': ')', '【': '】',
  '《': '》', '〈': '〉', '［': '］', '[': ']', '｛': '｝', '{': '}',
};
const CLOSERS = new Set(Object.values(OPENERS));

/**
 * 本文を文に分ける。
 * 改行は常に境界にする。書きかけの本文には閉じていない括弧が残るため、
 * 改行で括弧の深さを捨てる。捨てないと「が1つ残っただけで以降が1文になり、
 * 入力中ずっと全文を1回のJev判定に押し込むことになる。
 *
 * @param {string} text
 * @param {{minLength?: number}} [options] minLength未満の断片は返さない（既定2文字）
 * @returns {Array<{text: string, start: number, end: number, index: number}>}
 */
export function splitSentences(text, { minLength = 2 } = {}) {
  if (typeof text !== 'string' || !text) return [];

  const out = [];
  const stack = [];
  let start = 0;
  let i = 0;

  // 前後の空白を除いた範囲をオフセットごと確定する。trim後の文字列と
  // start/endがずれると、画面の下線が1文字ぶん手前に出る。
  const flush = (end) => {
    const raw = text.slice(start, end);
    if (raw.trim().length >= minLength) {
      const lead = raw.length - raw.trimStart().length;
      const trail = raw.length - raw.trimEnd().length;
      out.push({ text: raw.trim(), start: start + lead, end: end - trail, index: out.length });
    }
    start = end;
  };

  while (i < text.length) {
    const ch = text[i];

    if (OPENERS[ch]) { stack.push(OPENERS[ch]); i += 1; continue; }
    if (stack.length && ch === stack[stack.length - 1]) { stack.pop(); i += 1; continue; }

    if (ch === '\n') {
      flush(i);
      stack.length = 0;
      start = i + 1;
      i += 1;
      continue;
    }

    if (!stack.length && TERMINATORS.has(ch)) {
      // 「！？」「。。。」の連なりと、直後の閉じ括弧・閉じ引用は同じ文に含める。
      let j = i + 1;
      while (j < text.length && (TERMINATORS.has(text[j]) || CLOSERS.has(text[j]))) j += 1;
      flush(j);
      i = j;
      continue;
    }

    i += 1;
  }

  flush(text.length);
  return out;
}

/**
 * 文の内容から安定した鍵を作る。打鍵のたびに全文を投げ直さないためのキャッシュ用で、
 * 衝突しても困らない用途なのでFNV-1aで足りる。
 * @param {string} s
 * @returns {string} 8桁の16進
 */
export function hashSentence(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // 32bitに丸めたままFNVの素数を掛ける
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

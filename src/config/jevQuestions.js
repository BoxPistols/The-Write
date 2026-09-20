// Jev(TypeSafe AI)に投げる質問の定義。
// Jevは文章を書かず、型の付いた判定だけを返す。だからここに置けるのは
// 「何を尋ねるか」と「どこから指摘とみなすか」だけで、直し方は書けない。
// 直すのは従来どおり生成モデルの仕事で、Jevはその前段の選別に使う。
//
// 質問の形は3つしかない（SDK @typesafe-ai/sdk の型定義と同じ）。
//   noul   … 「〜か？」への「はい」の確率(0-1)
//   choice … 名前付きの選択肢から1つ＋確率分布
//   score  … 0から始まる順序付きルーブリックの期待値＋確率分布
// criteriaは選択肢そのものの説明で、質問文ではない。ここを曖昧にすると
// 確率が割れるだけで、後段の閾値をいくら動かしても精度は上がらない。

/** はい／いいえの質問を作る。 */
export const noul = (instructions, criteria) => ({
  type: 'noul',
  instructions,
  ...(criteria ? { criteria } : {}),
});

/** 名前付きの選択肢から1つ選ばせる質問を作る。 */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

/** 0から始まる順序付きルーブリックで採点させる質問を作る。criteriaは2件以上必要。 */
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

/**
 * 違和感の段階。添字がそのままスコアになるので、並べ替えると意味が変わる。
 * 「直すべきか」ではなく「読者が引っかかるか」で刻む。直すべきかは
 * 目的や媒体で変わるが、引っかかるかは本文だけで決まり、判定が安定する。
 */
export const AWKWARD_LEVELS = [
  '自然な日本語。読んでいて引っかかる箇所がない。',
  'わずかに硬い、または一語ぶん冗長。読み飛ばせる程度で、意味は明確。',
  '読んで引っかかる。助詞の選び方、語順、修飾の係り先、同じ語の重複のいずれかが気になる。',
  '明らかに不自然。書き手が読み返していないと読者に分かる。',
  '意味が取りにくい。主述のねじれ、脱字、係り受けの断絶があり、読者が読み直す必要がある。',
];

/** 文のどこに手を入れるべきかの区分。アプリ側のCATEGORIESと同じ語彙に揃える。 */
export const KIND_CRITERIA = {
  none: '直すべき点がない。',
  grammar: '助詞の誤り、主述のねじれ、係り受けの断絶など、文法そのものの誤り。',
  spelling: '誤字、脱字、変換ミス、同一文書内での表記ゆれ。',
  punctuation: '読点の位置や不足、句点の抜け、記号の使い方。',
  style: '冗長、同じ語の重複、語尾の単調さ、敬体と常体の混在。',
  clarity: '一文が長い、指示語の指す先が曖昧、主語が落ちていて意味が取りにくい。',
  'ai-writing': 'AIが書いた文章に特有の型。定型の前置き、接続詞の過剰、根拠のない評価語、使い古された比喩など。',
};

/**
 * 1文ぶんの質問。stateには文そのものと前後の文を入れる。
 * 前後を渡さないと、指示語や主語の省略を「不明瞭」と誤って落とす。
 *
 * 文字数や語尾の連続のような機械的に数えられるものはここで尋ねない。
 * 数えれば分かることに確率を使うと、遅くなるうえに答えが揺れる。
 */
export const SENTENCE_QUESTIONS = {
  awkward: score('この文は日本語として不自然か。推敲された日本語の文章を基準に判定する。', AWKWARD_LEVELS),
  aiLike: noul('この文はAIが生成した文章に特有の型にはまっているか。', {
    true: '定型の前置き、接続詞の過剰、根拠のない評価語、使い古された比喩、「〜することができます」のような冗長表現のいずれかが出ている。',
    false: '書き手が目的を持って書いた文に読める。型にはまった言い回しが無い。',
  }),
  kind: choice('この文で最も手を入れるべき点はどれか。', KIND_CRITERIA),
};

/**
 * 書き換え前後を突き合わせる質問。生成モデルの出力をそのまま採用せず、
 * 良くなったかどうかをJevに確かめさせるために使う。
 * 「自然になったか」と「意味が保たれているか」は別に尋ねる。
 * まとめて尋ねると、自然だが事実が変わった書き換えを通してしまう。
 */
export const REWRITE_QUESTIONS = {
  improved: noul('書き換え後の文は、原文より日本語として自然になっているか。', {
    true: '原文にあった引っかかりが消えている。',
    false: '変わっていない、または悪くなっている。',
  }),
  meaningKept: noul('書き換え後の文は、原文の意味と事実を保っているか。', {
    true: '数値、固有名詞、否定、条件、時制がすべて原文のままである。',
    false: '数値、固有名詞、否定、条件、時制のいずれかが変わった、または原文に無い情報が足された。',
  }),
  awkward: score('書き換え後の文は日本語として不自然か。', AWKWARD_LEVELS),
};

/**
 * 指摘として画面に出す境目。
 * awkwardは期待値なので整数に揃わない。1.6は「2(読んで引っかかる)寄り」の位置で、
 * 1.0(わずかに硬い)を全部拾うと指摘が多すぎて読まれなくなる。
 * 実測で動かす前提の数値なので、散らさずここだけに置く。
 */
export const FLAG_THRESHOLD = {
  awkward: 1.6,
  aiLike: 0.6,
  // 分布が割れている判定は、当てずっぽうと区別が付かないので指摘に格上げしない。
  confidence: 0.35,
};

/** 書き換えを採用してよいかの境目。意味の保持は自然さより厳しく取る。 */
export const GATE_THRESHOLD = {
  improved: 0.5,
  meaningKept: 0.7,
};

/**
 * Jevの答えを画面と後段が使う形に畳む。閾値の適用はここだけで行う。
 * @param {object} answers systemOneのanswers
 * @returns {{flagged: boolean, awkward: number, aiLike: number, kind: string, confidence: number, severity: 'error'|'warn'|'info', reason: string[]}}
 */
export function verdictOf(answers) {
  const awkward = Number(answers?.awkward?.score ?? 0);
  const aiLike = Number(answers?.aiLike?.noul ?? 0);
  const kind = answers?.kind?.choice || 'none';
  // scoreとchoiceの自信のうち低いほうを、その文の判定の自信とみなす。
  const confidence = Math.min(
    Number(answers?.awkward?.confidence ?? 0),
    Number(answers?.kind?.confidence ?? 0)
  );

  const reason = [];
  if (awkward >= FLAG_THRESHOLD.awkward) reason.push('awkward');
  if (aiLike >= FLAG_THRESHOLD.aiLike) reason.push('aiLike');

  // kindがnoneでも、awkwardが高ければ拾う。区分が付かないこと自体は
  // 「直す点が無い」ことの証明にならない。
  const flagged = reason.length > 0 && confidence >= FLAG_THRESHOLD.confidence;

  const severity = awkward >= 3 ? 'error' : awkward >= 2 ? 'warn' : 'info';

  return { flagged, awkward, aiLike, kind, confidence, severity, reason };
}

/**
 * 書き換えを採用してよいかを判定する。
 * @returns {{accept: boolean, improved: number, meaningKept: number, awkward: number, reason: string}}
 */
export function gateOf(answers) {
  const improved = Number(answers?.improved?.noul ?? 0);
  const meaningKept = Number(answers?.meaningKept?.noul ?? 0);
  const awkward = Number(answers?.awkward?.score ?? 0);

  // 意味が変わった疑いのほうを先に見る。自然になっていても採用できない。
  if (meaningKept < GATE_THRESHOLD.meaningKept) {
    return { accept: false, improved, meaningKept, awkward, reason: 'meaning' };
  }
  if (improved < GATE_THRESHOLD.improved) {
    return { accept: false, improved, meaningKept, awkward, reason: 'not-improved' };
  }
  return { accept: true, improved, meaningKept, awkward, reason: 'ok' };
}

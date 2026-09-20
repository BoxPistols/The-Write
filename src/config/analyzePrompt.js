// 校正のプロンプト。画面とベンチの両方がここを読む。
//
// 画面の中に置いたままだと、ベンチは似せたプロンプトを自前で持つことになり、
// 測っているものが本番と少しずつずれていく。ずれた比較に意味は無い。

/**
 * @param {{isJa: boolean, text: string, customInstruction?: string, isFragment?: boolean}} args
 * @returns {string}
 */
export function buildAnalyzePrompt({ isJa, text, customInstruction = '', isFragment = false }) {
  const customPart = customInstruction.trim()
    ? `\n\n${isJa ? 'ユーザーからの追加指示' : 'Additional instructions from the user'}: ${customInstruction.trim()}`
    : '';
  // Jevが選んだ文だけを送るとき、前後が欠けていることを伝える。伝えないと
  // 「主語が無い」「唐突だ」のような、切り出したせいでしかない指摘が並ぶ。
  const fragmentPart = isFragment
    ? (isJa
      ? '\n\n渡すのは長い文章から抜き出した文です。抜き出した範囲の中だけで判断し、前後が無いことを理由にした指摘は出さないでください。'
      : '\n\nThe text below consists of sentences pulled out of a longer document. Judge only what is shown, and do not raise issues that exist only because the surrounding context is missing.')
    : '';
  const userPrompt = isJa
    ? `あなたはプロの日本語編集者です。以下の文章を分析し、改善提案を提示してください。${customPart}${fragmentPart}

各提案はJSON配列で、各要素は以下の形式にしてください：
- "type": "grammar", "spelling", "punctuation", "style", "clarity", "ai-writing" のいずれか
- "original": 変更対象の原文（完全一致）
- "suggestion": 改善後のテキスト
- "explanation": 変更理由の簡潔な説明（日本語で）

"ai-writing" タイプは、AI生成文に特有のパターンに使用してください：
- 構造の定型化：「以下では〜を説明します」「結論から言うと」等の前置き宣言、STEP/ステップによる構造化
- 「さらに」「また」「したがって」「そのため」「加えて」等の接続詞の過剰使用
- 同じ語尾の3回以上の連続（「〜です。〜です。〜です。」等）
- 「最適化」「本質」「価値を最大化」「エコシステム」「ランドスケープ」等の抽象的バズワード
- 「一概には言えませんが」「場合によります」等の過度なヘッジング（逃げ表現）
- 「参考になれば幸いです」「ぜひ活用してみてください」等の定型的な締め
- 「非常に重要です」「大きなメリット」等の根拠のない評価語
- 「〜ではなく〜です」（not A but B）構文の多用
- 「羅針盤」「土台」「エンジン」「設計図」等の使い古された比喩
- 太字ヘッダー＋コロン＋説明文の箇条書きパターン（インラインヘッダー）
- 「〜することができます」等の冗長な表現（→「〜できます」）
- Markdown記法の混入（**太字**、#見出しなど）
- —（emダッシュ）の多用
- 3つの並列要素を無理に作る（ルール・オブ・スリー）
ai-writing の提案では、人間が書いたように自然な日本語に書き換えてください。

有効なJSON配列のみを出力してください。それ以外のテキストは一切出力しないでください。

分析対象の文章：
${text}`
    : `You are a professional writing assistant. Analyze the following text and provide suggestions for improvement.${customPart}${fragmentPart}

For each suggestion, provide a JSON array where each item has:
- "type": one of "grammar", "spelling", "punctuation", "style", "clarity", "ai-writing"
- "original": the exact text that should be changed
- "suggestion": the improved text
- "explanation": brief explanation of the change (in English)

Use "ai-writing" type for patterns typical of AI-generated text, including:
- Formulaic structure: long preambles, announcing structure in body text, STEP formatting
- Overuse of abstract buzzwords, hedging language, or cliché metaphors
- Repetitive sentence-ending patterns or excessive conjunctions
- Formulaic closings ("I hope this helps", "Feel free to reach out")
- Inline-header bullet lists (bold header + colon + description)
- Em dash (—) overuse
- Negative parallelisms ("It's not just X; it's Y")
- Rule of three overuse (forcing ideas into triplets)
- Elegant variation / excessive synonym cycling
- Sycophantic or overly agreeable tone
- Filler phrases ("In order to", "Due to the fact that")
- Generic positive conclusions ("The future looks bright")
For ai-writing suggestions, rewrite to sound more natural and human.

Respond ONLY with a valid JSON array. No other text.

Text to analyze:
${text}`;

  return userPrompt;
}

#!/usr/bin/env node
/**
 * 各モデルの一括駆動テスト + リライト口調テスト
 *
 * 使い方:
 *   node tools/model-test.js [--server http://localhost:3456]
 *
 * 環境変数またはサーバーの.envでAPIキーが設定されている前提。
 * クライアントキーを使う場合は --keys '{"openai":"sk-..."}' で指定。
 */

const BASE_URL = process.argv.includes('--server')
  ? process.argv[process.argv.indexOf('--server') + 1]
  : 'http://localhost:3456';

const CLIENT_KEYS = process.argv.includes('--keys')
  ? JSON.parse(process.argv[process.argv.indexOf('--keys') + 1])
  : {};

// テスト用テキスト（日本語）
const SAMPLE_TEXT = `AIは近年急速に発展しており、多くの分野で活用されています。特に自然言語処理の分野では、大規模言語モデルの登場により、文章の生成や翻訳、要約などのタスクが飛躍的に向上しました。今後もAI技術の進化は続くと考えられ、社会に大きな影響を与えることが予想されます。`;

// モデル一覧（models.jsと同期）
const MODELS = [
  { id: 'gpt-5-nano', provider: 'openai' },
  { id: 'gpt-5-mini', provider: 'openai' },
  { id: 'gpt-4.1-nano', provider: 'openai' },
  { id: 'gpt-4.1-mini', provider: 'openai' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
  { id: 'gemini-2.5-flash', provider: 'gemini' },
];

// 口調テスト: だ/である調が含まれていないかチェック
const DEARU_PATTERNS = [
  /[^ん]だ。/,     // 〜だ。（「んだ。」は除外）
  /なのだ[。、]/,   // 〜なのだ。
  /である[。、]/,   // 〜である。
  /であった[。、]/, // 〜であった。
  /のだ[。、]/,     // 〜のだ。
  /だった[。、]/,   // 〜だった。（ですます調では「でした」が正）
  /だろう[。、]/,   // 〜だろう。（ですます調では「でしょう」が正）
];

function checkTone(text) {
  const violations = [];
  for (const pattern of DEARU_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // マッチ箇所周辺を抽出
      const idx = text.indexOf(match[0]);
      const ctx = text.slice(Math.max(0, idx - 10), idx + match[0].length + 5);
      violations.push({ pattern: pattern.source, context: `...${ctx}...` });
    }
  }
  return violations;
}

// --- テスト実行 ---

async function testAnalyze(modelId) {
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{
        role: 'user',
        content: `You are a professional writing assistant. Analyze the following text and provide suggestions for improvement.

For each suggestion, provide a JSON array where each item has:
- "type": one of "grammar", "spelling", "punctuation", "style", "clarity", "ai-writing"
- "original": the exact text that should be changed
- "suggestion": the improved text
- "explanation": brief explanation of the change (in Japanese)

Respond ONLY with a valid JSON array. No other text.

Text to analyze:
${SAMPLE_TEXT}`,
      }],
      clientKeys: CLIENT_KEYS,
      maxTokens: 4000,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.content?.[0]?.text || '';
  const cleaned = content.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return { ok: false, error: 'No JSON array found', raw: content.slice(0, 200) };
  const parsed = JSON.parse(jsonMatch[0]);
  return { ok: true, suggestions: parsed.length, usage: data.usage };
}

async function testRewrite(modelId) {
  const prompt = `あなたは日本語のプロ編集者です。以下の文章を、人間が書いたと感じさせる自然な文章に書き直してください。意味・事実・トーンは変えないでください。

【厳守ルール：文体】
- 語尾は「〜です」「〜ます」「〜と思います」「〜だと考えられます」など丁寧体（です・ます調）を基本とする
- 「〜だ。」「〜なのだ。」「〜である。」などの常体（だ・である調）は使わない

【出力形式】
書き換え後の文章だけを出力する。説明・前置き・注意書きは一切出力しない。

---
元の文章：
${SAMPLE_TEXT}`;

  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      clientKeys: CLIENT_KEYS,
      maxTokens: 3000,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rewritten = data.content?.[0]?.text?.trim() || '';
  if (!rewritten) return { ok: false, error: 'Empty response' };
  const toneViolations = checkTone(rewritten);
  return {
    ok: toneViolations.length === 0,
    text: rewritten.slice(0, 150) + (rewritten.length > 150 ? '...' : ''),
    toneViolations,
    usage: data.usage,
  };
}

async function runAll() {
  // まずプロバイダーの利用可否を確認
  let providers = {};
  try {
    const res = await fetch(`${BASE_URL}/api/providers`);
    providers = await res.json();
  } catch (e) {
    console.error(`サーバー接続失敗: ${BASE_URL}/api/providers`, e.message);
    process.exit(1);
  }

  console.log(`\nサーバー: ${BASE_URL}`);
  console.log(`プロバイダー状況: ${Object.entries(providers).map(([k, v]) => `${k}=${v || !!CLIENT_KEYS[k] ? 'OK' : '-'}`).join(', ')}\n`);
  console.log('='.repeat(80));

  let passCount = 0;
  let failCount = 0;

  for (const model of MODELS) {
    const available = providers[model.provider] || !!CLIENT_KEYS[model.provider];
    if (!available) {
      console.log(`\n[SKIP] ${model.id} — APIキー未設定`);
      continue;
    }

    console.log(`\n--- ${model.id} ---`);

    // 分析テスト
    try {
      const t0 = Date.now();
      const result = await testAnalyze(model.id);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (result.ok) {
        console.log(`  [PASS] 分析: ${result.suggestions}件の提案 (${elapsed}s, in:${result.usage?.input_tokens} out:${result.usage?.output_tokens})`);
        passCount++;
      } else {
        console.log(`  [FAIL] 分析: ${result.error}`);
        if (result.raw) console.log(`         レスポンス先頭: ${result.raw}`);
        failCount++;
      }
    } catch (e) {
      console.log(`  [FAIL] 分析: ${e.message}`);
      failCount++;
    }

    // リライト（口調テスト）
    try {
      const t0 = Date.now();
      const result = await testRewrite(model.id);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (result.ok) {
        console.log(`  [PASS] リライト口調: です/ます調 OK (${elapsed}s)`);
        console.log(`         出力: ${result.text}`);
        passCount++;
      } else if (result.toneViolations?.length > 0) {
        console.log(`  [FAIL] リライト口調: だ/である調を検出 (${elapsed}s)`);
        for (const v of result.toneViolations) {
          console.log(`         ${v.pattern} → "${v.context}"`);
        }
        console.log(`         出力: ${result.text}`);
        failCount++;
      } else {
        console.log(`  [FAIL] リライト: ${result.error}`);
        failCount++;
      }
    } catch (e) {
      console.log(`  [FAIL] リライト: ${e.message}`);
      failCount++;
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`結果: ${passCount} PASS / ${failCount} FAIL`);
  process.exit(failCount > 0 ? 1 : 0);
}

runAll();

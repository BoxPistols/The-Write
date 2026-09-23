#!/usr/bin/env node
// Jevを挟む前と挟んだ後を、同じ文書・同じプロンプトで実測する。
//
//   TYPESAFE_API_KEY=... OPENAI_API_KEY=... node bench/run.mjs
//   node bench/run.mjs --repeat=5 --model=gemini-2.5-flash
//   node bench/run.mjs --mock          配線だけを確かめる。測定値ではない
//
// 測るのは3つ。
//   1) 最初の判定が出るまで(ttff)   「書いていて、いつ反応が返るか」
//   2) 全文を見終わるまで(wall)     「一通り見るのに、いくらかかるか」
//   3) 1文直したあとの更新(update)  「直したら、いつスコアが変わるか」
//
// 3つ目が本題。1文直すたびに全文を生成モデルへ送り直す作りだと、更新は
// 常に全文ぶんかかる。文単位で判定できるなら、更新は1文ぶんで済む。

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

// アプリ（server.js）と同じように .env を読む。読まないと、.env に鍵を書いた人が
// 「TYPESAFE_API_KEY が設定されていません」で止まる。鍵の置き場が2つあるように
// 見えるのがそもそも間違いなので、同じ場所を見る。
// dotenvは先勝ちなので、コマンドの前に書いた指定のほうが勝つ。
dotenv.config({ path: ['.env.local', '.env'] });

import { systemOneBatch } from '../api/_jev.js';
import { analyzeRequest } from '../api/_shared.js';
import { buildAnalyzePrompt } from '../src/config/analyzePrompt.js';
import { SENTENCE_QUESTIONS, verdictOf } from '../src/config/jevQuestions.js';
import { AVAILABLE_MODELS, resolveDefaultModelId } from '../src/config/models.js';
import { buildDocuments } from './documents.mjs';
import { percentile, mean, prf, costUsd, addUsage, mapSuggestionsToSentences } from './metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

const { values: args } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '3' },
    // 既定はアプリと同じ決め方にする。ここにidを書き写すと、モデルを入れ替えた
    // ときにベンチだけ古いモデルを測り続ける。
    //
    // 値はここで取り出す。models.js の DEFAULT_MODEL_ID は import.meta.env から
    // 読むので、Nodeでは常に素の既定になる。加えてimportは本文より先に評価される
    // ので、モジュールの定数にすると上の dotenv.config() がまだ効いていない。
    model: { type: 'string', default: resolveDefaultModelId(process.env.VITE_DEFAULT_MODEL) },
    sizes: { type: 'string', default: '8,20,40' },
    out: { type: 'string' },
  },
});
const REPEAT = Number(args.repeat);
const SIZES = args.sizes.split(',').map(Number);

// 先に弾く。0回や文字列のまま進むと、集計で undefined を読んで落ちる。
// どこで落ちたのか分からない例外より、何が悪いかを言って止まるほうがよい。
if (!Number.isInteger(REPEAT) || REPEAT < 1) {
  console.error(`--repeat は1以上の整数で指定する（受け取った値: ${args.repeat}）`);
  process.exit(1);
}
if (!SIZES.length || SIZES.some((n) => !Number.isInteger(n) || n < 1)) {
  console.error(`--sizes は1以上の整数をカンマ区切りで指定する（受け取った値: ${args.sizes}）`);
  process.exit(1);
}

// ─── 単価 ───────────────────────────────────────────
// Jevの単価は環境変数で渡す。調べずに書くと、比較の結論が作り話になる。
const llmPrice = (() => {
  const m = AVAILABLE_MODELS.find((x) => x.id === args.model);
  return m ? { input: m.inputPrice, output: m.outputPrice } : null;
})();
const jevPrice = (process.env.JEV_PRICE_INPUT && process.env.JEV_PRICE_OUTPUT)
  ? { input: Number(process.env.JEV_PRICE_INPUT), output: Number(process.env.JEV_PRICE_OUTPUT) }
  : null;

// ─── 実行系 ─────────────────────────────────────────
function parseSuggestions(raw) {
  // 画面と同じ読み方をする。ここだけ寛容にすると、画面で捨てている応答を
  // ベンチが拾ってしまい、指摘の件数が実際より多く出る。
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const realIo = {
  label: 'live',
  async judge(sentences) {
    const items = sentences.map((s, i) => ({
      id: s.id,
      state: {
        判定対象の文: s.text,
        ...(sentences[i - 1] ? { 直前の文: sentences[i - 1].text } : {}),
        ...(sentences[i + 1] ? { 直後の文: sentences[i + 1].text } : {}),
      },
      questions: SENTENCE_QUESTIONS,
    }));
    return systemOneBatch(items, { concurrency: 6 });
  },
  async analyze(text, { isFragment }) {
    return analyzeRequest({
      model: args.model,
      messages: [{ role: 'user', content: buildAnalyzePrompt({ isJa: true, text, isFragment }) }],
      maxTokens: 16000,
    });
  },
};

// 記録した応答で配線だけを確かめるための偽物。遅延は定数で、内容は本文から
// 機械的に決める。**これで出した数字は測定値ではない。**
const MOCK_JEV_MS = 140;
const MOCK_LLM_BASE_MS = 900;
const MOCK_LLM_PER_KCHAR_MS = 4200;
const mockIo = {
  label: 'mock',
  async judge(sentences) {
    await new Promise((r) => setTimeout(r, MOCK_JEV_MS));
    return sentences.map((s) => ({
      id: s.id,
      ok: true,
      latencyMs: MOCK_JEV_MS,
      usage: { input_tokens: Math.ceil(s.text.length / 2), output_tokens: 3 },
      answers: {
        awkward: { type: 'score', score: s.gold === 'ng' ? 2.6 : 0.4, confidence: 0.8 },
        aiLike: { type: 'noul', noul: s.kind === 'ai-writing' ? 0.85 : 0.1 },
        kind: { type: 'choice', choice: s.kind, confidence: 0.75 },
      },
    }));
  },
  async analyze(text) {
    await new Promise((r) => setTimeout(r, MOCK_LLM_BASE_MS + (text.length / 1000) * MOCK_LLM_PER_KCHAR_MS));
    const lines = text.split('\n').flatMap((l) => l.split('。').filter(Boolean).map((x) => `${x}。`));
    // goldと相関しない選び方にする。相関させると精度が満点に見えて、
    // 断り書きを読み飛ばした人に本物の結果として伝わる。
    const picked = lines.filter((l) => l.length % 3 === 0).slice(0, 12);
    return {
      content: [{ type: 'text', text: JSON.stringify(picked.map((l) => ({ type: 'style', original: l, suggestion: l, explanation: 'mock' }))) }],
      usage: { input_tokens: Math.ceil(text.length / 1.6) + 420, output_tokens: picked.length * 60 },
    };
  },
};

// ─── 腕 ─────────────────────────────────────────────
const chunk = (xs, n) => { const o = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };

/** 今のアプリ。本文を丸ごと生成モデルに渡し、JSONが揃うまで画面には何も出ない。 */
async function armLlmOnly(doc, io) {
  const t0 = now();
  const res = await io.analyze(doc.text, { isFragment: false });
  const wallMs = now() - t0;

  const suggestions = parseSuggestions(res.content?.[0]?.text || '');
  const parsed = suggestions != null;
  const { flagged, unmatched, ambiguous } = mapSuggestionsToSentences(suggestions || [], doc.sentences);

  return {
    // 途中経過が無いので、最初の判定が出るのは全部が揃ったときになる。
    ttffMs: wallMs, wallMs, judgeMs: null, llmMs: wallMs,
    llmUsage: res.usage, jevUsage: null,
    flagged, unmatched, ambiguous, parsed, suggestionCount: suggestions?.length ?? 0,
  };
}

/** Jevで選んでから生成モデルに渡す。 */
async function armJevTriage(doc, io) {
  const t0 = now();
  const verdicts = new Map();
  let jevUsage = { input_tokens: 0, output_tokens: 0 };
  let ttffMs = null;
  let failed = 0;

  for (const batch of chunk(doc.sentences, 32)) {
    const results = await io.judge(batch);
    if (ttffMs === null) ttffMs = now() - t0;
    for (const r of results) {
      if (!r.ok) { failed += 1; continue; }
      verdicts.set(r.id, verdictOf(r.answers));
      jevUsage = addUsage(jevUsage, r.usage);
    }
  }
  const judgeMs = now() - t0;

  const picked = doc.sentences.filter((s) => verdicts.get(s.id)?.flagged);
  const jevFlagged = new Set(picked.map((s) => s.id));

  let llmMs = 0;
  let llmUsage = { input_tokens: 0, output_tokens: 0 };
  let suggestions = [];
  let parsed = true;
  if (picked.length) {
    const t1 = now();
    const res = await io.analyze(picked.map((s) => s.text).join('\n'), { isFragment: true });
    llmMs = now() - t1;
    llmUsage = res.usage;
    const p = parseSuggestions(res.content?.[0]?.text || '');
    parsed = p != null;
    suggestions = p || [];
  }

  const { unmatched, ambiguous } = mapSuggestionsToSentences(suggestions, doc.sentences);

  return {
    // 最初の塊が返った時点で画面のスコアは動く。
    ttffMs, wallMs: now() - t0, judgeMs, llmMs,
    llmUsage, jevUsage,
    flagged: jevFlagged, unmatched, ambiguous, parsed,
    suggestionCount: suggestions.length,
    sentSentences: picked.length, failedJudgements: failed,
  };
}

/** 1文だけ直したあと、スコアが更新されるまで。 */
async function armUpdate(doc, io) {
  const target = doc.sentences[Math.floor(doc.sentences.length / 2)];
  const edited = { ...target, text: `${target.text.replace(/。$/, '')}、と考えている。` };
  const editedDoc = { ...doc, sentences: doc.sentences.map((s) => (s.id === target.id ? edited : s)) };
  editedDoc.text = doc.text.replace(target.text, edited.text);

  const tJ = now();
  await io.judge([edited]);
  const jevMs = now() - tJ;

  const tL = now();
  const res = await io.analyze(editedDoc.text, { isFragment: false });
  const llmMs = now() - tL;

  return { jevMs, llmMs, llmUsage: res.usage };
}

// ─── 実行 ───────────────────────────────────────────
async function main() {
  const io = args.mock ? mockIo : realIo;
  if (!args.mock) {
    if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY が設定されていません（配線だけ見るなら --mock）');
    if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) throw new Error('生成モデルの鍵が設定されていません');
  }

  const corpus = JSON.parse(readFileSync(join(__dirname, 'corpus.ja.json'), 'utf8'));
  const docs = buildDocuments(corpus.sentences, SIZES);

  const runs = [];
  for (let i = 0; i < REPEAT; i += 1) {
    for (const doc of docs) {
      process.stderr.write(`[${i + 1}/${REPEAT}] ${doc.id} (${doc.chars}文字) `);
      const llmOnly = await armLlmOnly(doc, io);
      process.stderr.write('llm-only ');
      const jevTriage = await armJevTriage(doc, io);
      process.stderr.write('jev-triage ');
      const update = await armUpdate(doc, io);
      process.stderr.write('update\n');
      runs.push({ iteration: i, docId: doc.id, chars: doc.chars, sentences: doc.sentences.length, llmOnly, jevTriage, update });
    }
  }

  // ─── 畳む ───
  const byDoc = {};
  for (const doc of docs) {
    const rs = runs.filter((r) => r.docId === doc.id);
    const pairsFor = (arm) => rs.flatMap((r) => doc.sentences.map((s) => ({ gold: s.gold, pred: r[arm].flagged.has(s.id) })));

    const armStats = (arm) => {
      const xs = rs.map((r) => r[arm]);
      return {
        ttffMs: { p50: percentile(xs.map((x) => x.ttffMs), 0.5), p95: percentile(xs.map((x) => x.ttffMs), 0.95) },
        wallMs: { p50: percentile(xs.map((x) => x.wallMs), 0.5), p95: percentile(xs.map((x) => x.wallMs), 0.95) },
        judgeMs: { p50: percentile(xs.map((x) => x.judgeMs), 0.5) },
        llmMs: { p50: percentile(xs.map((x) => x.llmMs), 0.5) },
        llmTokens: {
          input: mean(xs.map((x) => x.llmUsage?.input_tokens ?? null)),
          output: mean(xs.map((x) => x.llmUsage?.output_tokens ?? null)),
        },
        jevTokens: xs[0].jevUsage ? {
          input: mean(xs.map((x) => x.jevUsage.input_tokens)),
          output: mean(xs.map((x) => x.jevUsage.output_tokens)),
        } : null,
        llmCostUsd: mean(xs.map((x) => costUsd(x.llmUsage, llmPrice))),
        jevCostUsd: xs[0].jevUsage ? mean(xs.map((x) => costUsd(x.jevUsage, jevPrice))) : null,
        unmatched: mean(xs.map((x) => x.unmatched)),
        ambiguous: mean(xs.map((x) => x.ambiguous)),
        suggestionCount: mean(xs.map((x) => x.suggestionCount)),
        parseFailures: xs.filter((x) => !x.parsed).length,
        sentSentences: xs[0].sentSentences != null ? mean(xs.map((x) => x.sentSentences)) : null,
        failedJudgements: xs[0].failedJudgements != null ? xs.reduce((a, x) => a + x.failedJudgements, 0) : null,
        accuracy: prf(pairsFor(arm)),
      };
    };

    byDoc[doc.id] = {
      chars: doc.chars,
      sentences: doc.sentences.length,
      ngSentences: doc.sentences.filter((s) => s.gold === 'ng').length,
      llmOnly: armStats('llmOnly'),
      jevTriage: armStats('jevTriage'),
      update: {
        jevMs: { p50: percentile(rs.map((r) => r.update.jevMs), 0.5), p95: percentile(rs.map((r) => r.update.jevMs), 0.95) },
        llmMs: { p50: percentile(rs.map((r) => r.update.llmMs), 0.5), p95: percentile(rs.map((r) => r.update.llmMs), 0.95) },
        llmCostUsd: mean(rs.map((r) => costUsd(r.update.llmUsage, llmPrice))),
      },
    };
  }

  const report = {
    mode: io.label,
    warning: args.mock
      ? 'これは記録した応答で配線を確かめただけの出力で、測定値ではない。遅延は定数、判定はコーパスのラベルから作っている。'
      : null,
    ranAt: new Date().toISOString(),
    model: args.model,
    repeat: REPEAT,
    corpusVersion: corpus.version,
    corpusStats: {
      total: corpus.sentences.length,
      ng: corpus.sentences.filter((s) => s.gold === 'ng').length,
    },
    prices: { llm: llmPrice, jev: jevPrice },
    priceNote: jevPrice ? null : 'Jevの単価が渡されていないため、Jev側の費用は出していない（JEV_PRICE_INPUT / JEV_PRICE_OUTPUT）。',
    byDoc,
  };

  mkdirSync(join(__dirname, 'results'), { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/g, '-');
  const out = args.out || join(__dirname, 'results', `${io.label}-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(out);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

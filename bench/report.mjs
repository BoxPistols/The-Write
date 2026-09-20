#!/usr/bin/env node
// 実測の結果をレポートに起こす。
//
//   node bench/report.mjs                      直近の結果を使う
//   node bench/report.mjs bench/results/x.json
//
// --mockで取った結果はdocs/に書かない。書けるようにすると、いつか偽の数字が
// レポートの顔になる。モックの出力はbench/results/に、断り書き付きで置く。

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { updateLatencyChart } from './chart.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ms = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()}ms`);
const num = (v, d = 0) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d }));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const usd = (v) => (v == null ? '—' : `$${v.toFixed(5)}`);
const times = (a, b) => (a && b ? `${(b / a).toFixed(1)}×` : '—');

function latest() {
  const dir = join(__dirname, 'results');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new Error('bench/results/ に結果がない。先に node bench/run.mjs を回す。');
  return join(dir, files[files.length - 1]);
}

function build(report) {
  const docs = Object.entries(report.byDoc);
  const mock = report.mode === 'mock';

  // 図にするのは更新までの時間だけ。Jevを挟む理由がそこにあるため。
  const svg = updateLatencyChart({
    title: '1文直したあと、スコアが更新されるまで',
    subtitle: `${report.mode} / 中央値・ミリ秒 / 短いほど速い`,
    series: ['Jev（変わった1文だけ）', '生成モデル（全文をやり直す）'],
    rows: docs.map(([id, d]) => ({ label: `${id} (${d.chars}文字)`, a: d.update.jevMs.p50, b: d.update.llmMs.p50 })),
  });

  // いちばん長い文書を結論の代表にする。短い文書では差が出にくい。
  const [headId, head] = docs[docs.length - 1];

  const lines = [];
  lines.push('# Jevを挟む前と後');
  lines.push('');

  if (mock) {
    lines.push('> [!WARNING]');
    lines.push('> **これは測定値ではない。** 記録した応答で配線を確かめただけの出力で、');
    lines.push('> 遅延は定数、判定はコーパスのラベルから作っている。精度が満点に見えるのは');
    lines.push('> 答えを見て答えているからで、Jevの性能とは何の関係も無い。');
    lines.push('> 実測は `TYPESAFE_API_KEY` と生成モデルの鍵を入れて `node bench/run.mjs` を回す。');
    lines.push('');
  }

  lines.push(`- 実行: ${report.ranAt}（${report.repeat}回）`);
  lines.push(`- 生成モデル: \`${report.model}\``);
  lines.push(`- コーパス: \`bench/corpus.ja.json\` v${report.corpusVersion}（手書き、生成モデルにも辞書にも作らせていない）`);
  lines.push(`- 実行系: \`bench/run.mjs\`（プロンプトは画面と同じ \`src/config/analyzePrompt.js\` を読む）`);
  lines.push('');

  lines.push('## 結論');
  lines.push('');
  lines.push(`${headId}（${head.chars}文字 / ${head.sentences}文、うち手を入れるべき文 ${head.ngSentences}）での中央値。`);
  lines.push('');
  lines.push('| | 前（生成モデルだけ） | 後（Jevで選んでから） | |');
  lines.push('|---|---|---|---|');
  lines.push(`| 1文直したあとの更新 | ${ms(head.update.llmMs.p50)} | ${ms(head.update.jevMs.p50)} | ${times(head.update.jevMs.p50, head.update.llmMs.p50)} |`);
  lines.push(`| 最初の反応が出るまで | ${ms(head.llmOnly.ttffMs.p50)} | ${ms(head.jevTriage.ttffMs.p50)} | ${times(head.jevTriage.ttffMs.p50, head.llmOnly.ttffMs.p50)} |`);
  lines.push(`| 一通り見終わるまで | ${ms(head.llmOnly.wallMs.p50)} | ${ms(head.jevTriage.wallMs.p50)} | ${times(head.jevTriage.wallMs.p50, head.llmOnly.wallMs.p50)} |`);
  lines.push(`| 生成モデルへの入力トークン | ${num(head.llmOnly.llmTokens.input)} | ${num(head.jevTriage.llmTokens.input)} | |`);
  lines.push('');
  lines.push('「最初の反応」は、前者では**JSONが全部揃った瞬間**になる。途中経過が無いため、');
  lines.push('画面には最後まで何も出ない。後者では最初の塊が返った時点でスコアが動く。');
  lines.push('');
  lines.push(`![1文直したあとの更新時間](${mock ? basename(svgName(report)) : 'jev-benchmark.svg'})`);
  lines.push('');

  lines.push('## 遅延');
  lines.push('');
  lines.push('| 文書 | 腕 | 最初の反応 p50 | p95 | 全体 p50 | 判定 p50 | 生成 p50 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [id, d] of docs) {
    lines.push(`| ${id} (${d.chars}字) | 生成モデルだけ | ${ms(d.llmOnly.ttffMs.p50)} | ${ms(d.llmOnly.ttffMs.p95)} | ${ms(d.llmOnly.wallMs.p50)} | — | ${ms(d.llmOnly.llmMs.p50)} |`);
    lines.push(`| | Jevで選んでから | ${ms(d.jevTriage.ttffMs.p50)} | ${ms(d.jevTriage.ttffMs.p95)} | ${ms(d.jevTriage.wallMs.p50)} | ${ms(d.jevTriage.judgeMs.p50)} | ${ms(d.jevTriage.llmMs.p50)} |`);
  }
  lines.push('');

  lines.push('## トークンと費用');
  lines.push('');
  lines.push('| 文書 | 腕 | 生成 入力 | 生成 出力 | 生成 費用 | Jev 入力 | Jev 費用 | 送った文 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [id, d] of docs) {
    lines.push(`| ${id} | 生成モデルだけ | ${num(d.llmOnly.llmTokens.input)} | ${num(d.llmOnly.llmTokens.output)} | ${usd(d.llmOnly.llmCostUsd)} | — | — | ${d.sentences}/${d.sentences} |`);
    lines.push(`| | Jevで選んでから | ${num(d.jevTriage.llmTokens.input)} | ${num(d.jevTriage.llmTokens.output)} | ${usd(d.jevTriage.llmCostUsd)} | ${num(d.jevTriage.jevTokens?.input)} | ${usd(d.jevTriage.jevCostUsd)} | ${num(d.jevTriage.sentSentences)}/${d.sentences} |`);
  }
  lines.push('');
  if (report.priceNote) lines.push(`> ${report.priceNote}`);
  lines.push('');

  lines.push('## 手を入れるべき文を当てられたか');
  lines.push('');
  if (mock) {
    // モックのJevはコーパスのラベルから答えを作っている。表を出すと満点が並び、
    // 断り書きを読み飛ばした人に本物の結果として伝わる。数字ごと出さない。
    lines.push('モックでは出さない。判定をコーパスのラベルから作っているので、');
    lines.push('答えを見て答えているだけになる。実測で回すとここに表が出る。');
  } else {
    lines.push('コーパスの `gold` との突き合わせ。**片方だけ見ない。** 何も指摘しない実装は precision が、');
    lines.push('全部に指摘を出す実装は recall が満点になる。');
    lines.push('');
    lines.push('| 文書 | 腕 | precision | recall | F1 | 取りこぼし | 誤検出 | 原文に無い指摘 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const [id, d] of docs) {
      for (const [label, a] of [['生成モデルだけ', d.llmOnly], ['Jevで選んでから', d.jevTriage]]) {
        const x = a.accuracy;
        lines.push(`| ${id} | ${label} | ${pct(x.precision)} | ${pct(x.recall)} | ${pct(x.f1)} | ${x.fn} | ${x.fp} | ${num(a.unmatched, 1)} |`);
      }
    }
  }
  lines.push('');

  lines.push('## 測っていないこと');
  lines.push('');
  lines.push('- **書き換えの質**は測っていない。ここで見ているのは「どの文に手を入れるべきか」までで、');
  lines.push('  直したあとの文が良くなったかは別の話。検証ゲート（`REWRITE_QUESTIONS`）の出力は記録していない。');
  lines.push(`- **コーパスは手書きで、書いた人の癖が入っている。** ${report.corpusStats?.total ?? '?'}文のうち手を入れるべき文は${report.corpusStats?.ng ?? '?'}。`);
  lines.push('  実際の下書きの分布とは違う。');
  lines.push('- `gold` は二値で、「わずかに硬い」を手を入れる理由にしていない。閾値を下げれば recall は上がり、');
  lines.push('  precision は下がる。`FLAG_THRESHOLD` を動かして測り直せる。');
  if (!report.prices?.jev) {
    lines.push('- **Jev側の費用は出していない。** 単価を渡していないため（`JEV_PRICE_INPUT` / `JEV_PRICE_OUTPUT`）。');
    lines.push('  0として足すと、合計が安いほうに寄って嘘になる。');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('このレポートは `node bench/report.mjs` が生成する。手で書き足さない。');
  lines.push('');

  return { md: lines.join('\n'), svg };
}

const svgName = (report) => `${report.mode}-${report.ranAt.replace(/[:.]/g, '-')}.svg`;

function main() {
  const file = process.argv[2] || latest();
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const { md, svg } = build(report);

  if (report.mode === 'mock') {
    const dir = join(__dirname, 'results');
    mkdirSync(dir, { recursive: true });
    const base = basename(file, '.json');
    writeFileSync(join(dir, `${base}.md`), md);
    writeFileSync(join(dir, svgName(report)), svg);
    console.log(join('bench', 'results', `${base}.md`));
    return;
  }

  mkdirSync(join(ROOT, 'docs'), { recursive: true });
  writeFileSync(join(ROOT, 'docs', 'jev-benchmark.md'), md);
  writeFileSync(join(ROOT, 'docs', 'jev-benchmark.svg'), svg);
  console.log('docs/jev-benchmark.md');
}

main();

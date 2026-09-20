import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Sparkles, Check, X, Loader2, Sun, Moon, Copy, FileText, Eraser,
  Bold, Italic, Underline, Link, AlignLeft, AlignCenter,
  AlignRight, List, ListOrdered, Outdent, Indent,
  Type, Highlighter, MoveVertical, MoveHorizontal, RotateCcw, Feather, ChevronDown, Settings, Key, Eye, EyeOff, Wand2, Maximize2, Minimize2,
  Undo2, Redo2, Volume2, Square, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
} from 'lucide-react';
import { t, locale } from '../locales';
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, PROVIDERS, getModel, autoSelectModel } from '../config/models';
import { SAMPLES } from '../config/samples';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { useTextToSpeech } from '../hooks/useTextToSpeech';
import TtsSettings, { TtsSettingsForm } from './TtsSettings';
import { isModKey, formatShortcut, loadShortcuts, saveShortcuts, shortcutFromEvent, matchShortcut, DEFAULT_SHORTCUTS } from '../utils/platform';
import { canUse, recordUsage, getRemaining, getResetTime, RATE_LIMIT, hasUserKeys } from '../utils/rateLimit';
import { OUTPUT_TARGETS, listTargets, getTarget, targetInstruction, markdownRule, DEFAULT_TARGET_ID } from '../config/outputTargets';
import { sanitizeForTarget, summarizeRemovals } from '../utils/sanitize';
import { autoFix, checkText, countBySeverity, diffReport, getWritingGuard } from '../utils/deadCliche';
import { useJevTriage } from '../hooks/useJevTriage';
import { judgeRewrites } from '../utils/jevClient';
import JevMeter from './JevMeter';

// {key}形式の穴埋め。文言はlocales側に置き、ここでは組み立てだけ行う。
const fmt = (key, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), t(key));

const SEV_COLOR = { error: 'var(--cat-grammar)', warn: 'var(--cat-style)', info: 'var(--text-muted)' };
const SEV_ORDER = { error: 2, warn: 1, info: 0 };

// 検出例をルール単位に畳む。和欧間スペースのように1つのルールが何十件も当たることがあり、
// 生の一致をそのまま並べると他の指摘が埋もれる。件数の多い順に、読める見出しで出す。
// 自動修正の内訳。ルール単位に畳んで件数を出し、代表例をbeforeからafterの形で1つ添える。
// 和欧間スペースの除去は差が空白なので、そのまま出すと何も変わっていないように見える。可視化する。
const visibleSpace = (s) => s.replace(/ /g, '␣').replace(/\t/g, '⇥');
const fixSamples = (applied) => {
  const groups = new Map();
  for (const a of applied) {
    const g = groups.get(a.ruleId) || { count: 0, before: a.before, after: a.after };
    g.count++;
    groups.set(a.ruleId, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((g) => `${visibleSpace(g.before)}→${visibleSpace(g.after)} ${g.count}`)
    .join('、');
};

const clicheSamples = (violations) => {
  const groups = new Map();
  for (const v of violations) {
    const g = groups.get(v.ruleId) || { count: 0, label: '', catLabel: v.catLabel };
    g.count++;
    // 空白や記号だけの一致は見出しにならないので、読める一致が出るまで探す。
    if (!g.label) {
      const s = (v.matched || '').trim();
      if (s && /[^\s\p{P}\p{S}\d]/u.test(s)) g.label = s;
    }
    groups.set(v.ruleId, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  const shown = sorted.slice(0, 4).map((g) => {
    const name = g.label || g.catLabel || '';
    return g.count > 1 ? `${name} ${g.count}` : name;
  }).filter(Boolean);
  return shown.join('、') + (sorted.length > 4 ? '…' : '');
};

/**
 * 検出したクリシェを、なぜ問題か(why)と何を書くべきか(ask)つきで並べる。
 * 辞書がwhyとaskを必須にしているのは、置換候補だけ示すと別のクリシェに置き換わって終わるため。
 * 同じルールの重複は畳み、一致語と件数と最初の行番号を添える。
 */
function ClicheDetails({ violations }) {
  const groups = new Map();
  for (const v of violations) {
    const g = groups.get(v.ruleId) || { ...v, count: 0, samples: [] };
    g.count++;
    const s = (v.matched || '').trim();
    if (s && !g.samples.includes(s) && g.samples.length < 3) g.samples.push(s);
    groups.set(v.ruleId, g);
  }
  const list = [...groups.values()].sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || b.count - a.count);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
      {list.map((g) => (
        <div key={g.ruleId} style={{ paddingLeft: 8, borderLeft: `2px solid ${SEV_COLOR[g.severity]}` }}>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 700, color: SEV_COLOR[g.severity] }}>
              {g.samples.join('、') || g.catLabel}
            </span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
              {g.severity}{g.count > 1 ? ` ${g.count}` : ''}・{g.count > 1 ? `${g.line}行目ほか` : `${g.line}行目`}
            </span>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-muted)' }}>{g.why}</div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
            <span style={{ color: SEV_COLOR[g.severity], fontWeight: 600 }}>{t('reportAsk')} </span>
            {g.ask}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 生成結果に何をしたかを出す。
 * 検査で0件だったことを「問題なし」と読ませないため、検査範囲を常に併記する。
 */
function ResultReport({ report }) {
  const { removed, fixed, cliche, clicheError, diff, targetLabel, unchanged, jevGate, jevGateError } = report;
  const counts = cliche?.counts;
  const total = cliche ? cliche.violations.length : 0;

  const Row = ({ label, children }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ flexShrink: 0, width: 108, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{children}</div>
    </div>
  );

  return (
    <div style={{
      flexShrink: 0, maxHeight: 300, overflowY: 'auto',
      padding: '12px 24px', borderTop: '1px solid var(--border-subtle)',
      background: 'var(--bg-toolbar)', display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
        {t('reportTitle')} — {targetLabel}
      </div>

      {unchanged && (
        <div style={{ padding: '8px 10px', borderRadius: 'var(--radius)', border: `1px solid ${SEV_COLOR.warn}`, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700, color: SEV_COLOR.warn }}>{t('reportUnchanged')} </span>
          {t('reportUnchangedNote')}
        </div>
      )}

      <Row label={t('reportRemoved')}>
        {removed.length
          ? removed.map((r) => `${r.label} ${r.count}`).join(' / ')
          : t('reportNothingRemoved')}
      </Row>

      {fixed?.length > 0 && (
        <Row label={t('reportFixed')}>{fixSamples(fixed)}</Row>
      )}

      <Row label={t('reportCliche')}>
        {clicheError ? (
          <span style={{ color: 'var(--cat-grammar)' }}>{fmt('reportClicheFailed', { error: clicheError })}</span>
        ) : (
          <>
            {total > 0 && (
              <>
                <div style={{ marginBottom: 3 }}>
                  {['error', 'warn', 'info'].filter((k) => counts[k] > 0).map((k) => (
                    <span key={k} style={{ marginRight: 10, color: SEV_COLOR[k], fontWeight: 600 }}>{k} {counts[k]}</span>
                  ))}
                  <span style={{ color: 'var(--text-muted)' }}>{clicheSamples(cliche.violations)}</span>
                </div>
                <ClicheDetails violations={cliche.violations} />
              </>
            )}
            {total === 0 && <div style={{ marginBottom: 3 }}>{t('reportClicheNone')}</div>}
            {cliche?.scope && (
              <div style={{ color: 'var(--text-muted)' }}>
                {fmt('reportClicheScope', {
                  preset: cliche.scope.preset,
                  count: cliche.scope.activeCount,
                  version: cliche.scope.version,
                })}
              </div>
            )}
          </>
        )}
      </Row>

      {(jevGate || jevGateError) && (
        <Row label={t('jevGateTitle')}>
          {jevGateError ? (
            // 検証できなかったことを「通った」として見せない。
            <span style={{ color: 'var(--cat-grammar)' }}>{fmt('jevGateFailed', { error: jevGateError })}</span>
          ) : (
            <>
              <div style={{ color: jevGate.accept ? 'var(--accept)' : 'var(--cat-spelling)' }}>
                {jevGate.accept
                  ? t('jevGateAccepted')
                  : jevGate.reason === 'meaning' ? t('jevGateMeaning') : t('jevGateNotImproved')}
              </div>
              <div style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                improved {jevGate.improved.toFixed(2)} / meaningKept {jevGate.meaningKept.toFixed(2)} / awkward {jevGate.awkward.toFixed(2)}
              </div>
            </>
          )}
        </Row>
      )}

      <Row label={t('reportDiff')}>
        {diff.hasWarnings ? (
          <>
            {diff.lineCountChanged && <div>{fmt('reportDiffLines', { before: diff.lineCountBefore, after: diff.lineCountAfter })}</div>}
            {diff.removedNumbers.length > 0 && (
              <div style={{ color: 'var(--cat-grammar)' }}>{fmt('reportDiffNumbersRemoved', { list: diff.removedNumbers.join(', ') })}</div>
            )}
            {diff.addedNumbers.length > 0 && (
              <div style={{ color: 'var(--cat-grammar)' }}>{fmt('reportDiffNumbersAdded', { list: diff.addedNumbers.join(', ') })}</div>
            )}
            {diff.driftedLines.length > 0 && <div>{fmt('reportDiffDrifted', { count: diff.driftedLines.length })}</div>}
            <div style={{ color: 'var(--text-muted)' }}>{t('reportDiffAsk')}</div>
          </>
        ) : t('reportDiffClean')}
      </Row>
    </div>
  );
}

const JP_SANS_FALLBACK = "'Noto Sans JP', 'BIZ UDPGothic', 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Meiryo', 'Segoe UI', -apple-system, sans-serif";
const JP_SERIF_FALLBACK = "'Noto Serif JP', 'BIZ UDPMincho', 'Hiragino Mincho ProN', 'Yu Mincho', 'MS PMincho', serif";
const JP_MONO_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

const FONTS = [
  { name: 'Cormorant Garamond', label: 'Cormorant Garamond', stack: `'Cormorant Garamond', ${JP_SERIF_FALLBACK}` },
  { name: 'Georgia', label: 'Georgia', stack: `'Georgia', ${JP_SERIF_FALLBACK}` },
  { name: 'Times New Roman', label: 'Times New Roman', stack: `'Times New Roman', ${JP_SERIF_FALLBACK}` },
  { name: 'Noto Serif JP', label: 'Noto Serif JP', stack: `'Noto Serif JP', 'BIZ UDPMincho', 'Hiragino Mincho ProN', 'Yu Mincho', 'MS PMincho', serif` },
  { name: 'BIZ UDPMincho', label: 'BIZ UDPMincho', stack: `'BIZ UDPMincho', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', 'MS PMincho', serif` },
  { name: 'Noto Sans JP', label: 'Noto Sans JP', stack: `${JP_SANS_FALLBACK}` },
  { name: 'BIZ UDPGothic', label: 'BIZ UDPGothic', stack: `'BIZ UDPGothic', 'Noto Sans JP', 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Meiryo', 'Segoe UI', -apple-system, sans-serif` },
  { name: 'Source Sans 3', label: 'Source Sans 3', stack: `'Source Sans 3', ${JP_SANS_FALLBACK}` },
  { name: 'Verdana', label: 'Verdana', stack: `'Verdana', ${JP_SANS_FALLBACK}` },
  { name: 'Courier New', label: 'Courier New', stack: `'Courier New', ${JP_MONO_FALLBACK}` },
];
const FONT_STACKS = FONTS.reduce((acc, font) => {
  acc[font.name] = font.stack;
  return acc;
}, {});
const getFontStack = (name) => FONT_STACKS[name] || `${name}, ${JP_SANS_FALLBACK}`;
const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'];
const LINE_SPACINGS = ['1', '1.25', '1.5', '1.75', '2', '2.5'];
const LETTER_SPACINGS = ['0', '0.04em', '0.08em', '0.12em', '0.16em', '0.2em', '0.28em'];
const CONTENT_STORAGE_KEY = 'wa-content';

const EDITOR_DEFAULTS = {
  fontFamily: 'Cormorant Garamond',
  fontSize: '16px',
  lineSpacing: '1.75',
  letterSpacing: '0.12em',
  darkMode: false,
};

const loadEditorSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('wa-editor') || '{}');
    return { ...EDITOR_DEFAULTS, ...saved };
  } catch { return { ...EDITOR_DEFAULTS }; }
};

const saveEditorSettings = (settings) => {
  try { localStorage.setItem('wa-editor', JSON.stringify(settings)); } catch {}
};
const loadEditorContent = () => {
  try { return JSON.parse(localStorage.getItem(CONTENT_STORAGE_KEY) || '{}'); }
  catch (err) { console.warn('Failed to load editor content', err); return {}; }
};
const saveEditorContent = (content) => {
  try { localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(content)); }
  catch (err) { console.warn('Failed to save editor content', err); }
};
const CATEGORIES = ['all', 'grammar', 'spelling', 'punctuation', 'style', 'clarity', 'ai-writing'];

const CAT_STYLES = {
  grammar: { color: 'var(--cat-grammar)', bg: 'var(--cat-grammar-bg)' },
  spelling: { color: 'var(--cat-spelling)', bg: 'var(--cat-spelling-bg)' },
  punctuation: { color: 'var(--cat-punctuation)', bg: 'var(--cat-punctuation-bg)' },
  style: { color: 'var(--cat-style)', bg: 'var(--cat-style-bg)' },
  clarity: { color: 'var(--cat-clarity)', bg: 'var(--cat-clarity-bg)' },
  'ai-writing': { color: 'var(--cat-ai-writing)', bg: 'var(--cat-ai-writing-bg)' },
};

const analyzeViaProxy = async (model, text, clientKeys, customInstruction = '', isFragment = false) => {
  const isJa = locale.startsWith('ja');
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

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: userPrompt }],
      clientKeys,
      maxTokens: 16000,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { const err = await res.json(); detail = err.error || ''; } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
};

const rewriteViaProxy = async (model, text, clientKeys, targetRules = '', markdown = 'none') => {
  const isJa = locale.startsWith('ja');
  // 出力先の指示が無いとき(自由)は緩和しない。緩和が要るのは、後段で
  // Markdownを許す指示と前段の禁止が食い違う場合だけ。
  const mdRule = markdownRule(targetRules ? markdown : 'none', isJa);
  // クリシェの一覧はここに書かない。辞書から自動生成された規律を使う。
  // 手元に一覧を持つと、辞書に語が増えても生成側が古いままになる。
  const guard = isJa ? await getWritingGuard() : '';
  const basePrompt = isJa
    ? `あなたは日本語のプロ編集者です。以下の文章を、人間が書いたと感じさせる自然な文章に書き直してください。意味・事実は変えないでください。トーンも基本的に維持しますが、文体ルール（です・ます調の統一等）が優先されます。

【厳守ルール：記号・表記】
${mdRule}
- 「」のカギ括弧による強調を削り、文脈に溶かす
- （）による補足を最小限にし、必要なら文に組み込む
- 「： 」（コロン直後に半角スペース）を使わない。太字ヘッダー＋コロン＋説明文の箇条書きパターンも禁止
- ／で概念を並列しない（「戦略／実行」→「戦略と実行」など）
- —（emダッシュ）を言い換えに使わない
- 絵文字を装飾的に使わない

${guard}

【厳守ルール：文体・リズム】
- 元の文章が丁寧体（です・ます調）の場合はそれを維持し、常体（だ・である調）の場合は常体を維持する
- ただし丁寧体・常体が混在している場合は、文章の大部分が使っている方に統一する
- 同じ語尾の3連続以上を避ける。「〜です」「〜でしょう」「〜かもしれません」「〜と言えます」「〜のようです」「〜になります」等を織り交ぜる
- 体言止め（「〜という選択。」）も適度に使い、リズムに変化をつける
- 短い文と長い文を意図的に混ぜる。段落の長さも不揃いにする
- 主語が自明な場合は省略する（日本語として自然な省略）
- 漢字が連続しすぎないよう、ひらがなに開ける箇所を意識する（「予め」→「あらかじめ」、「殆ど」→「ほとんど」、「更に」→「さらに」等）
- 読点（、）は意味の区切りに打ち、均等配置を避ける

【厳守ルール：内容・構成】
- 「以下では〜を説明します」「結論から言うと」「本記事では」等の前置き宣言を入れない
- 「一概には言えませんが」「場合によります」「一般的に」等の過度なヘッジング（逃げ表現）を削る
- 「参考になれば幸いです」「ぜひ活用してみてください」「何かありましたらお気軽にどうぞ」等の定型的な締めを入れない
- 「もちろんです！」「素晴らしいご質問ですね」等のおべっか表現を入れない
- STEP/ステップによる構造宣言を避ける
- 「課題と今後の展望」のようなテンプレ的なセクション構成を避ける
- 評価語（「非常に重要です」「大きなメリット」「画期的な」）には根拠を伴わせるか削る
- 「〜における」「〜に関して」を多用しない。もっと短く言い換える
- 漠然と明るい結論（「今後の発展が期待されます」「未来は明るい」等）がAI的な定型表現である場合は、元の意図を保ちつつ具体的な結びに言い換える（意味やトーンが変わる場合は無理に変えない）

`
    : `You are a professional editor. Rewrite the following text to sound natural and human-written. Preserve the original meaning, facts, and tone exactly.

Strictly follow these rules:

Symbols & Formatting:
${mdRule}
- No inline-header bullet lists (bold header + colon + description pattern)
- Minimize quotation marks used for emphasis; integrate into prose
- Minimize parenthetical asides; incorporate naturally into sentences
- No colon-space pattern (": " as labels or section headers)
- No slashes (/) for parallel concepts; rephrase as prose
- No em dashes (—) for rephrasing or clarification
- No decorative emojis

AI Pattern Removal:
- Cut excessive conjunctions (furthermore, moreover, additionally, therefore, consequently)
- Replace abstract buzzwords ("optimize", "maximize value", "ecosystem", "landscape", "paradigm", "leverage", "synergy") with concrete expressions
- Remove undue significance claims ("stands as", "serves as", "pivotal moment", "marking a shift", "vital role")
- Remove superficial "-ing" analyses ("highlighting", "symbolizing", "reflecting", "encompassing")
- Remove negative parallelisms ("It's not just X; it's Y", "Not only... but also...")
- Avoid rule-of-three overuse (forcing ideas into triplets)
- Avoid elegant variation / excessive synonym cycling (don't keep replacing the same noun with different synonyms)
- Remove false ranges ("from X to Y" where items aren't on a meaningful scale)
- Remove filler phrases ("In order to", "Due to the fact that", "At this point in time", "has the ability to")
- Remove sycophantic language ("Of course!", "Great question!", "Absolutely!")
- No hyphenated compound overuse ("data-driven", "cross-functional", "client-facing")

Content & Style:
- No advance notices ("Here I will explain...", "In conclusion, ...", "Let me outline three points")
- Remove excessive hedging ("generally speaking", "it depends", "in most cases", "could potentially")
- Avoid repeating the same sentence-ending pattern
- Mix short and long sentences for varied rhythm. Vary paragraph lengths
- No formulaic closings ("I hope this helps", "Feel free to reach out", "The future looks bright")
- Avoid cliché metaphors (compass, foundation, engine, blueprint, bridge, tapestry)
- No "Challenges and Future Prospects" template sections when they are AI-filler (preserve if the original genuinely discusses challenges/prospects)
- Back up strong evaluations with evidence or cut them, only when they are clearly AI-generated filler
- No promotional language ("groundbreaking", "breathtaking", "stunning", "vibrant") unless it reflects the original author's intent

`;

  // 出力先テンプレートの制約は基本ルールの後、出力形式の前に置く。
  // 出力先固有の指示のほうが後に来るので、衝突したときはそちらが優先される。
  const targetSection = targetRules ? `\n\n${targetRules}` : '';
  const outputRule = isJa
    ? '\n\n【出力形式】\n書き換え後の文章だけを出力する。説明・前置き・注意書きは一切出力しない。'
    : '\n\nOutput: Output ONLY the rewritten text. No explanation, preamble, or notes.';
  const prompt = `${basePrompt}${targetSection}${outputRule}\n\n---\n${isJa ? '元の文章：' : 'Original text:'}\n${text}`;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      clientKeys,
      maxTokens: 16000,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { const err = await res.json(); detail = err.error || ''; } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
};

/**
 * 検出したクリシェを、辞書のaskに沿って直させる。
 * 制約を規律より前に置くのは、askに「本文の要点を1文で再掲する」のように、
 * 中身の無い入力では捏造を促すものがあるため。矛盾したら制約を優先させる。
 */
const refineViaProxy = async (model, text, clientKeys, violations, targetRules = '') => {
  const isJa = locale.startsWith('ja');
  // 同じルールの重複は畳む。同じ指示を何度も並べても効かない。
  const seen = new Map();
  for (const v of violations) if (!seen.has(v.ruleId)) seen.set(v.ruleId, v);
  const items = [...seen.values()].map((v, i) => (isJa
    ? `${i + 1}. 「${(v.matched || '').trim()}」(${v.line}行目) 問題: ${v.why} 直し方: ${v.ask}`
    : `${i + 1}. "${(v.matched || '').trim()}" (line ${v.line}) Problem: ${v.why} Fix: ${v.ask}`)).join('\n');

  // 直し方の優先順と制約は辞書の規律が持っている。ここで書き写さない。
  const guard = isJa ? await getWritingGuard() : '';
  const head = isJa
    ? `以下の文章から、指摘されたクリシェを取り除いてください。

【守る制約(規律より優先)】
- 本文に無い情報を足さない。事実・数値・固有名詞を新しく作らない
- 行を新設しない。段落の数を増やさない
- 指摘されていない箇所は変えない

${guard}`
    : `Remove the flagged cliches from the text below.

Constraints (these override the guidance):
- Do not add information absent from the text. Do not invent facts, numbers, or names
- Do not add lines or paragraphs
- Do not change anything that was not flagged

Priority order:
1. Replace with a plain word of the same meaning. If the sentence works, stop there
2. If that does not fit, restructure the sentence
3. If the meaning cannot be determined from the text, leave that sentence unchanged. Do not guess

Writing:
- Do not simply delete words, leaving a sentence without a subject, object, or predicate
- Replace a metaphor with the thing it refers to in the text
- Do not alter Markdown syntax, and do not rewrite code block or inline code contents`;

  const outputRule = isJa
    ? '\n\n【出力形式】\n直した文章だけを出力する。説明・前置き・注意書きは一切出力しない。'
    : '\n\nOutput: Output ONLY the corrected text. No explanation, preamble, or notes.';
  const listLabel = isJa ? '\n\n【指摘】\n' : '\n\nFlagged items:\n';
  const bodyLabel = isJa ? '\n\n---\n対象の文章：\n' : '\n\n---\nText:\n';
  const prompt = `${head}${targetRules ? `\n\n${targetRules}` : ''}${listLabel}${items}${outputRule}${bodyLabel}${text}`;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], clientKeys, maxTokens: 16000 }),
  });
  if (!res.ok) {
    let detail = '';
    try { const err = await res.json(); detail = err.error || ''; } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
};

/* ─── Compose（文脈整形）用プロンプト本文 ─────────
   下書き・背景・目的セクションは composeViaProxy で末尾に付加する。
   プロンプトはジャッジパネル（構成再設計 / 目的適合 / 忠実性の3案統合）で設計。 */
const COMPOSE_PROMPT_JA = (mdRule) => `あなたは日本語の編集者です。この後に示す未整理の【下書き】を、【背景・状況】と【目的・ゴール】に沿って、人間が書いた自然な一本の文章に再構成してください。下書きは音声入力などの走り書きを想定しています。誤字直しや語尾の整えではなく、構成そのものを設計し直すことが主な仕事です。同じ下書きでも、背景や目的が違えば書くべき文章は変わります。たとえば目的が上司への謝罪と報告なら丁寧な報告と対応策の文書に、チームへの共有なら簡潔な状況共有に、というように、構成・語彙・トーン・敬体/常体を読み手と目的に合わせて組み立て直してください。

【最優先：構成を組み立て直す】
- 【下書き】は、順序も粒度もバラついた素材とみなす。書かれた並び順に縛られない。
- 【目的・ゴール】を最短で果たす順序・段落・論理展開を先に決めてから書く。何を冒頭に置き、何を根拠や補足として後段へ回すかを設計する。
- 目的の型に必要な要素を満たす。おおよその骨組みは次を目安にする。
  - 謝罪・お詫び：お詫び→状況と原因→対応策→今後の見通し。相手を気づかう一言を添える。
  - 依頼・相談：用件（結論）→理由・背景→具体的な依頼内容→期限や希望。
  - 報告・共有：結論→要点→次のアクションや懸念。
  - 告知・案内：何を・いつ・どこで・誰に→してほしい行動。
  - SNS・投稿：要点を1つに絞り、短く口語で。
- 話が飛ぶ箇所は自然な繋ぎを補い、重複・脱線・独り言や、目的に照らして不要な情報は削る。

【背景と目的の反映】
- 【背景・状況】から、誰が誰に向けて・どんな関係と場面かを読み取り、敬語レベルとトーンを決める。目上・社外はより丁寧に、同僚・チーム内は簡潔にする。相手名・締切・経緯など具体情報は文章に活かす。
- 【目的・ゴール】から、文書の型（メール／チャット共有／報告／依頼など）と着地点を決め、構成と情報の並び順を組み立てる。
- 【背景・状況】の記載がなければ、下書きの語彙や文体から相手と場面を推定する。【目的・ゴール】の記載がなければ、その下書きが最も自然に果たす意図を1つ推定して構成する。どのセクションが省略されても破綻させない。

【事実への忠実さ】
- 下書きにない事実・数字・固有名詞・日付・約束を足さない。書かれていないことを創作しない。
- 誇張や脚色をせず、下書きの主張の強さや温度感を勝手に上げ下げしない。
- 情報が足りなくても、埋めるために内容を作らない。文をつなぐ言い換えや自然な言い回しなど、意味を変えない範囲の補完にとどめる。読み取りにくい箇所は最も自然な解釈を1つ選び、事実として断定しすぎない。

【文体】
- 敬体（です・ます）か常体（だ・である）かは、目的と読み手にふさわしい方へ全体を統一する。下書きの混在に引きずられない。手がかりがなければ下書きで多い方に合わせる。
${mdRule}。装飾記号と絵文字は使わない。箇条書きが自然な形式でも、記号を並べない

【自然な日本語（AIっぽさを消す）】
- 「さらに」「また」「したがって」「そのため」などの接続詞を多用しない。
- 「最適化」「本質」「エコシステム」などの抽象語は、何がどうなるかが伝わる具体表現に言い換える。
- not A but B 構文（〜ではなく〜です）、3語の並列（ルール・オブ・スリー）、同じ語尾の3連続を避ける。短い文と長い文を混ぜてリズムをつける。
- 「〜することができます」→「〜できます」のように冗長表現を簡潔にする。
- 「以下では説明します」などの前置きや「参考になれば幸いです」などの中身のない締めを入れない。ただしメールなど目的上必要な宛名・挨拶・結びは自然な範囲で残す。

【出力】
- 再構成後の本文だけを出力する。説明・前置き・注記・見出しラベル・セクション名は一切出力しない。「件名：」のようなラベルは付けず、そのまま貼り付けられる本文に仕上げる。`;

const COMPOSE_PROMPT_EN = (mdRule) => `You are a Japanese-language editor. Reconstruct the unstructured [Draft] shown below into a single, natural piece of writing that reads as if a human wrote it, following the [Background/Situation] and [Purpose/Goal]. The draft is assumed to be rough notes, such as from voice input. Your main job is to redesign the structure itself, not to fix typos or smooth sentence endings. The same draft should become different writing when the background or purpose differs: for example, if the purpose is an apology and report to a manager, produce a polite report with a plan of action; if it is a quick share to the team, produce a concise status update. Rebuild the structure, wording, tone, and formality (polite/plain form) to fit the reader and the purpose.

[Top priority: rebuild the structure]
- Treat the [Draft] as raw material whose order and level of detail are uneven. Do not be bound by the order in which it was written.
- Before writing, decide the sequence, paragraphs, and logical flow that achieve the [Purpose/Goal] most directly. Decide what goes first and what moves later as supporting detail.
- Satisfy the elements the purpose requires. Use these skeletons as a guide:
  - Apology: apology -> situation and cause -> corrective action -> outlook. Add a line of consideration for the reader.
  - Request/consultation: the ask (conclusion) -> reason/background -> specific request -> deadline or preference.
  - Report/share: conclusion -> key points -> next actions or concerns.
  - Announcement: what, when, where, to whom -> the action you want.
  - Social post: narrow to one point; keep it short and conversational.
- Add natural transitions where the thread jumps, and cut repetition, digressions, muttering, and anything the purpose does not need.

[Reflecting background and purpose]
- From [Background/Situation], read who is writing to whom and in what relationship and setting, and set the level of politeness and tone. Be more polite for superiors and external parties; be concise within a team. Use concrete details such as names, deadlines, and history.
- From [Purpose/Goal], decide the document type (email / chat share / report / request, etc.) and its landing point, and build the structure and order of information.
- If [Background/Situation] is not given, infer the reader and setting from the draft's vocabulary and style. If [Purpose/Goal] is not given, infer the single most natural intent the draft serves and structure around it. Never break down when a section is omitted.

[Fidelity to facts]
- Do not add facts, numbers, proper nouns, dates, or commitments that are not in the draft. Do not invent what is not written.
- Do not exaggerate or embellish, and do not raise or lower the strength or emotional temperature of the draft's claims.
- Even when information is missing, do not fabricate content to fill gaps. Limit completion to rewording and natural phrasing that connect sentences without changing meaning. Where the intent is unclear, choose the single most natural reading and avoid asserting it too firmly as fact.

[Style]
- Unify the whole text into either polite form (desu/masu) or plain form (da/dearu), whichever suits the purpose and reader; do not be dragged by mixed forms in the draft. If there is no clue, follow whichever is more common in the draft.
${mdRule}. No decorative symbols or emoji.

[Natural Japanese (removing the AI feel)]
- Do not overuse conjunctions such as "furthermore," "also," "therefore," "for that reason."
- Replace abstract words such as "optimize," "essence," "ecosystem" with concrete expressions that convey what actually changes.
- Avoid the "not A but B" construction, three-item parallels (rule of three), and three identical sentence endings in a row. Mix short and long sentences for rhythm.
- Simplify wordy expressions (e.g., "is able to do" -> "can do").
- Do not add preambles like "The following explains..." or empty closings like "I hope this helps." However, keep the salutation, greeting, and closing that the purpose genuinely requires, such as in an email, within a natural range.

[Output]
- Output only the reconstructed body text. Do not output any explanation, preamble, notes, heading labels, or section names. Do not add labels like "Subject:"; produce body text ready to paste as is.`;

const composeViaProxy = async (model, text, clientKeys, { background = '', purpose = '', targetRules = '', markdown = 'none' } = {}) => {
  const isJa = locale.startsWith('ja');
  // 出力先の指示が無いとき(自由)は緩和しない。緩和が要るのは、後段で
  // Markdownを許す指示と前段の禁止が食い違う場合だけ。
  const mdRule = markdownRule(targetRules ? markdown : 'none', isJa);
  const guard = isJa ? await getWritingGuard() : '';
  const instructions = (isJa ? COMPOSE_PROMPT_JA : COMPOSE_PROMPT_EN)(mdRule);
  const bg = background.trim();
  const pp = purpose.trim();
  // 背景・目的は入力がある時だけセクションとして付加（空欄でも破綻しない設計）
  const bgSection = bg ? (isJa ? `\n\n【背景・状況】\n${bg}` : `\n\n[Background/Situation]\n${bg}`) : '';
  const ppSection = pp ? (isJa ? `\n\n【目的・ゴール】\n${pp}` : `\n\n[Purpose/Goal]\n${pp}`) : '';
  // 出力先の制約は背景・目的より後に置く。宛先の規約は書き手の意図より強い
  const targetSection = targetRules ? `\n\n${targetRules}` : '';
  const draftLabel = isJa ? '【下書き】' : '[Draft]';
  const guardSection = guard ? `\n\n${guard}` : '';
  const prompt = `${instructions}${guardSection}${bgSection}${ppSection}${targetSection}\n\n${draftLabel}\n${text}`;

  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      clientKeys,
      maxTokens: 16000,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { const err = await res.json(); detail = err.error || ''; } catch {}
    throw new Error(detail || `API error: ${res.status}`);
  }
  return res.json();
};

/* ─── Speed/Quality dots ───────────────────────── */
function Dots({ count, max = 5, color }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: i < count ? color : 'var(--border-subtle)',
            transition: 'background 0.15s',
          }}
        />
      ))}
    </span>
  );
}

/* ─── Toolbar Separator ────────────────────────── */
function Sep() {
  return <div style={{ width: 1, height: 20, background: 'var(--border-primary)', margin: '0 6px', opacity: 0.6 }} />;
}

/* ─── Toolbar Button ───────────────────────────── */
function TBtn({ onClick, title, children, className = '' }) {
  return (
    <button onMouseDown={(e) => e.preventDefault()} onClick={onClick} title={title} className={`toolbar-btn ${className}`}>
      {children}
    </button>
  );
}

/* ─── Color Swatches — click to apply color ─────── */
const TEXT_COLORS = [
  '#1f2430', '#4b5563', '#7b6ba5', '#4e7ea8', '#2563eb',
  '#16a34a', '#dc2626', '#a855f7', '#db2777', '#ffffff',
];
const HIGHLIGHT_COLORS = [
  'transparent', '#fde68a', '#bbf7d0', '#bfdbfe', '#e9d5ff',
  '#fecaca', '#fed7aa', '#fce7f3', '#d1d5db', '#fef9c3',
];

function ColorSwatches({ title, icon, colors, activeColor, onApplyColor, saveSelection, restoreSelection }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className="toolbar-btn"
        title={title}
        onMouseDown={(e) => { e.preventDefault(); saveSelection(); }}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span style={{
          position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
          width: 14, height: 3, borderRadius: 1,
          background: activeColor === 'transparent' ? 'var(--border-primary)' : activeColor,
          border: activeColor === 'transparent' ? '1px dashed var(--text-tertiary)' : 'none',
        }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 4,
          background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
          borderRadius: 8, padding: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4,
        }}>
          {colors.map((c) => (
            <button
              key={c}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                restoreSelection();
                onApplyColor(c === 'transparent' ? 'transparent' : c);
                setOpen(false);
              }}
              style={{
                width: 24, height: 24, borderRadius: 4, border: '1.5px solid var(--border-primary)',
                background: c === 'transparent'
                  ? 'linear-gradient(135deg, #fff 45%, #ef4444 45%, #ef4444 55%, #fff 55%)'
                  : c,
                cursor: 'pointer', padding: 0,
                outline: c === activeColor ? '2px solid var(--accent)' : 'none',
                outlineOffset: 1,
              }}
              title={c === 'transparent' ? 'None' : c}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Dropdown ─────────────────────────────────── */
function Dropdown({ open, onClose, trigger, children, align = 'left' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger}
      {open && <div className="dropdown-menu" style={align === 'right' ? { left: 'auto', right: 0 } : {}}>{children}</div>}
    </div>
  );
}

/* ─── Main Component ───────────────────────────── */
export default function TextEditor() {
  const [editorSettings, setEditorSettingsRaw] = useState(loadEditorSettings);
  const { fontFamily, fontSize, lineSpacing, letterSpacing, darkMode } = editorSettings;

  const updateSetting = useCallback((key, value) => {
    setEditorSettingsRaw((prev) => {
      const next = { ...prev, [key]: value };
      saveEditorSettings(next);
      return next;
    });
  }, []);

  const resetEditorSettings = useCallback(() => {
    setEditorSettingsRaw({ ...EDITOR_DEFAULTS });
    saveEditorSettings({ ...EDITOR_DEFAULTS });
  }, []);

  const setFontFamily = (v) => updateSetting('fontFamily', v);
  const setFontSize = (v) => updateSetting('fontSize', v);
  const setLineSpacing = (v) => updateSetting('lineSpacing', v);
  const setLetterSpacing = (v) => updateSetting('letterSpacing', v);
  const setDarkMode = (v) => updateSetting('darkMode', v);

  const [customInstruction, setCustomInstruction] = useState(() => {
    try { return localStorage.getItem('wa-custom-instruction') || ''; } catch { return ''; }
  });
  // 出力先（PR本文 / issue / コミット / PRレビュー / Slack依頼）。
  // プロンプトの制約・生成後のサニタイズ・辞書プリセットの3つを一括で決める。
  const [outputTargetId, setOutputTargetId] = useState(() => {
    try {
      const saved = localStorage.getItem('wa-output-target');
      // 保存値が既知のidでなければ既定に書き戻す。idを変えたときにチップの選択と説明が空になるため。
      if (saved && OUTPUT_TARGETS.some((tg) => tg.id === saved)) return saved;
      if (saved) localStorage.setItem('wa-output-target', DEFAULT_TARGET_ID);
      return DEFAULT_TARGET_ID;
    } catch { return DEFAULT_TARGET_ID; }
  });
  // 文脈整形（compose）用の背景・目的・パネル開閉状態
  const [background, setBackground] = useState(() => {
    try { return localStorage.getItem('wa-compose-bg') || ''; } catch { return ''; }
  });
  const [purpose, setPurpose] = useState(() => {
    try { return localStorage.getItem('wa-compose-purpose') || ''; } catch { return ''; }
  });
  // 文脈整形はモーダルで開く（メインの編集エリアを圧迫しないため）
  const [composeModalOpen, setComposeModalOpen] = useState(false);
  // 左（操作パネル）/ 右（改善提案）サイドバーの開閉。モバイル幅は初期状態を閉じておく
  const [leftOpen, setLeftOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('wa-left-open');
      if (saved != null) return saved === '1';
    } catch {}
    return typeof window === 'undefined' || window.innerWidth > 768;
  });
  const [rightOpen, setRightOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('wa-right-open');
      if (saved != null) return saved === '1';
    } catch {}
    return typeof window === 'undefined' || window.innerWidth > 768;
  });
  const [suggestions, setSuggestions] = useState([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState(null);
  const [composeResult, setComposeResult] = useState(null);
  const [isComposing, setIsComposing] = useState(false);
  // 結果モーダルから、検出されたクリシェを辞書のaskに沿って直す
  const [isRefining, setIsRefining] = useState(false);
  const [isModalMaximized, setIsModalMaximized] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [charCount, setCharCount] = useState(0);
  // Jevへ文単位で投げるための本文。contentEditableの中身は状態に載っていないので、
  // 文字数と同じ場所で写しを取る。
  const [plainText, setPlainText] = useState('');
  // 直近の校正で、何文のうち何文を生成モデルに送ったか。削った事実を隠さない。
  const [triageInfo, setTriageInfo] = useState(null);
  const [openDropdown, setOpenDropdown] = useState(null);
  const [copied, setCopied] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => {
    try {
      const saved = localStorage.getItem('wa-model');
      if (!saved) return DEFAULT_MODEL_ID;
      // 旧モデル ID が残存していたらデフォルトにリセット
      if (saved !== 'auto' && !AVAILABLE_MODELS.some((m) => m.id === saved)) {
        localStorage.setItem('wa-model', DEFAULT_MODEL_ID);
        return DEFAULT_MODEL_ID;
      }
      return saved;
    } catch { return DEFAULT_MODEL_ID; }
  });
  const [availableProviders, setAvailableProviders] = useState({});
  // Client-side API keys (stored in localStorage, sent with requests as fallback)
  const [clientKeys, setClientKeys] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa-keys') || '{}'); } catch { return {}; }
  });
  const [keyVisibility, setKeyVisibility] = useState({});
  const [testResults, setTestResults] = useState({});
  const [lastUsage, setLastUsage] = useState(null);
  const [shortcuts, setShortcuts] = useState(loadShortcuts);
  const [recordingAction, setRecordingAction] = useState(null); // ショートカット記録中のアクション名
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [estimatedSecs, setEstimatedSecs] = useState(0);
  const [remaining, setRemaining] = useState(getRemaining);
  const elapsedRef = useRef(null); // setInterval ID
  const editorRef = useRef(null);
  const savedSelectionRef = useRef(null);
  const isComposingRef = useRef(false); // IME変換中フラグ

  const refreshEditorContent = useCallback(() => {
    if (!editorRef.current) return;
    const raw = editorRef.current.innerText || '';
    setCharCount(raw.trim().length);
    setPlainText(raw);
    saveEditorContent({ html: editorRef.current.innerHTML });
  }, []);

  const { snapshot, undo, redo, canUndo, canRedo } = useUndoRedo(editorRef, refreshEditorContent);
  const tts = useTextToSpeech();

  const refreshProviders = useCallback(() => {
    fetch('/api/providers').then((r) => r.json()).then(setAvailableProviders).catch(() => {});
  }, []);

  const handleTestConnection = async (provider) => {
    setTestResults((prev) => ({ ...prev, [provider]: { loading: true } }));
    try {
      const res = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, clientKeys }),
      });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [provider]: data }));
    } catch {
      setTestResults((prev) => ({ ...prev, [provider]: { ok: false, error: 'Network error' } }));
    }
  };

  useEffect(() => {
    refreshProviders();
    // 初回読み込み時に各プロバイダーの接続テストを自動実行
    for (const key of Object.keys(PROVIDERS)) handleTestConnection(key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const isOpen = !!(rewriteResult || composeResult || composeModalOpen);
    if (!isOpen) return;
    const handleKey = (e) => { if (e.key === 'Escape') { tts.stop(); setRewriteResult(null); setComposeResult(null); if (!isComposing) setComposeModalOpen(false); } };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [rewriteResult, composeResult, composeModalOpen, isComposing, tts.stop]);

  useEffect(() => {
    try { localStorage.setItem('wa-model', selectedModel); } catch {}
  }, [selectedModel]);

  useEffect(() => {
    try { localStorage.setItem('wa-keys', JSON.stringify(clientKeys)); } catch {}
  }, [clientKeys]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    try { localStorage.setItem('wa-custom-instruction', customInstruction); } catch {}
  }, [customInstruction]);

  useEffect(() => {
    try { localStorage.setItem('wa-output-target', outputTargetId); } catch {}
  }, [outputTargetId]);

  useEffect(() => { try { localStorage.setItem('wa-compose-bg', background); } catch {} }, [background]);
  useEffect(() => { try { localStorage.setItem('wa-compose-purpose', purpose); } catch {} }, [purpose]);
  useEffect(() => { try { localStorage.setItem('wa-left-open', leftOpen ? '1' : '0'); } catch {} }, [leftOpen]);
  useEffect(() => { try { localStorage.setItem('wa-right-open', rightOpen ? '1' : '0'); } catch {} }, [rightOpen]);

  useEffect(() => {
    if (!editorRef.current) return;
    const saved = loadEditorContent();
    if (saved?.html) {
      editorRef.current.innerHTML = saved.html;
    }
    const raw = editorRef.current.innerText || '';
    setCharCount(raw.trim().length);
    setPlainText(raw);
  }, []);

  useEffect(() => {
    let snapshotTimer = null;
    const handleInput = () => {
      if (!editorRef.current) return;
      refreshEditorContent();
      // 入力操作のスナップショットをデバウンス（1秒間隔）
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => snapshot(), 1000);
    };
    const editor = editorRef.current;
    if (editor) {
      editor.addEventListener('input', handleInput);
      return () => { editor.removeEventListener('input', handleInput); clearTimeout(snapshotTimer); };
    }
  }, [snapshot, refreshEditorContent]);

  const execCmd = (command, value = null) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  };

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0) savedSelectionRef.current = sel.getRangeAt(0).cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    if (savedSelectionRef.current) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedSelectionRef.current);
    }
  }, []);

  const resetEditorContent = useCallback(() => {
    snapshot();
    if (editorRef.current) editorRef.current.innerHTML = '';
    setSuggestions([]);
    setLastUsage(null);
    setCopied(false);
    setOpenDropdown(null);
    setCharCount(0);
    saveEditorContent({ html: '' });
  }, [snapshot]);

  const rejectAllSuggestions = useCallback(() => {
    setSuggestions((prev) => prev.map((s) => (s.status === 'pending' ? { ...s, status: 'rejected' } : s)));
  }, []);

  const handleAddLink = () => {
    if (linkUrl) {
      restoreSelection();
      execCmd('createLink', linkUrl);
      setLinkUrl('');
      setShowLinkDialog(false);
    }
  };

  const handleCopy = () => {
    if (editorRef.current) {
      navigator.clipboard.writeText(editorRef.current.innerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Check if provider is available (server env OR client key, AND not failed test)
  const isProviderAvailable = (provider) => {
    const hasKey = !!availableProviders[provider] || !!clientKeys[provider];
    if (!hasKey) return false;
    // 接続テスト実施済みで失敗した場合は無効
    const test = testResults[provider];
    if (test && !test.loading && !test.ok) return false;
    return true;
  };

  // Auto Modeならテキスト長に応じてモデルを決定、そうでなければ選択中のモデルを返す
  const resolveModel = useCallback((textLength) => {
    if (selectedModel === 'auto') return autoSelectModel(textLength, isProviderAvailable);
    return selectedModel;
  }, [selectedModel, availableProviders, clientKeys]);

  // プログレスタイマー開始
  const startProgress = useCallback((modelId, textLength) => {
    const model = getModel(modelId);
    const est = Math.max(3, Math.round((model?.secsPerKChar || 5) * (textLength / 1000)));
    setEstimatedSecs(est);
    setElapsedSecs(0);
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    elapsedRef.current = setInterval(() => setElapsedSecs((s) => s + 1), 1000);
  }, []);

  const stopProgress = useCallback(() => {
    if (elapsedRef.current) { clearInterval(elapsedRef.current); elapsedRef.current = null; }
  }, []);

  const checkRateLimit = useCallback(() => {
    if (!canUse()) {
      const resetTime = getResetTime();
      const timeStr = resetTime ? new Date(resetTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      alert(t('rateLimitReached').replace('{time}', timeStr));
      return false;
    }
    return true;
  }, []);

  // 入力中の判定。鍵が無ければ動かず、画面には理由だけを出す。
  const jevAvailable = !!availableProviders.jev || !!clientKeys.jev;
  const jevPurpose = useMemo(() => {
    const target = getTarget(outputTargetId);
    return target ? target.label[locale.startsWith('ja') ? 'ja' : 'en'] : '';
  }, [outputTargetId]);
  const jev = useJevTriage(plainText, { enabled: jevAvailable, purpose: jevPurpose, clientKeys });
  // 判定は打鍵のたびに変わる。handleAnalyzeの依存に入れると、キー割り当ての
  // useEffectが打鍵ごとに貼り直しになるので、最新の判定は参照で渡す。
  const jevRef = useRef(jev);
  jevRef.current = jev;

  // メーターの一覧から本文の該当箇所へ飛ぶ。
  // innerTextはブロックの境目に改行を足すので、文のオフセットはテキストノードの
  // 位置と一致しない。既存のapplySuggestionと同じく本文から探す。
  const selectSentence = useCallback((unit) => {
    const root = editorRef.current;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(unit.text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + unit.text.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      root.focus();
      return;
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    const text = editorRef.current?.innerText?.trim();
    if (!text) { alert(t('pleaseEnterText')); return; }
    if (!checkRateLimit()) return;

    // Jevが全文を見終わっているときだけ、指摘の立った文に絞って送る。
    // 見終わっていない文を外すと「判定していない」を「問題なし」として捨てることになる。
    const live = jevRef.current;
    const scope = jevAvailable && live.status === 'ready' && live.summary.coverage === 1 ? live.scope() : null;
    const useScope = !!scope?.text;
    const payload = useScope ? scope.text : text;

    const modelId = resolveModel(payload.length);
    setIsAnalyzing(true);
    setSuggestions([]);
    setLastUsage(null);
    setTriageInfo(useScope ? { sent: scope.sentences.length, total: scope.sentences.length + scope.skipped } : null);
    startProgress(modelId, payload.length);

    try {
      const data = await analyzeViaProxy(modelId, payload, clientKeys, customInstruction, useScope);
      recordUsage(); setRemaining(getRemaining());
      if (data.usage) setLastUsage({ ...data.usage, model: modelId });
      const content = data.content?.[0]?.text || '';
      try {
        const cleaned = content.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          setSuggestions(parsed.map((s, i) => ({ ...s, id: i, status: 'pending', type: s.type?.replace(/_/g, '-') })));
          setRightOpen(true); // 提案が届いたら改善提案パネルを自動的に開く
        } else {
          console.warn('No JSON array found in response:', content);
          alert(t('failedToParse'));
        }
      } catch (e) {
        console.warn('JSON parse error:', e.message, '\nResponse:', content);
        alert(t('failedToParse'));
      }
    } catch (e) {
      console.error('Analyze error:', e);
      alert(e.message?.includes('401') ? t('failedUnauthorized') : t('failedToAnalyze'));
    }
    finally { setIsAnalyzing(false); stopProgress(); }
  }, [resolveModel, clientKeys, customInstruction, startProgress, stopProgress, checkRateLimit, jevAvailable]);

  const isJa = locale.startsWith('ja');
  const targets = useMemo(() => listTargets(isJa), [isJa]);
  const activeTarget = useMemo(() => getTarget(outputTargetId), [outputTargetId]);

  /**
   * 生成結果を出力先の規約に合わせて確定させる。
   * 1) 署名、絵文字、Markdownを決定論的に除去する(LLMの指示追従に任せない)
   * 2) 辞書が決定論的に直せるもの(和欧間スペース等)を修正する
   * 3) 残りを辞書で検査する(検査範囲を必ず添える。0件は「問題なし」ではない)
   * 4) 原文と照合し、行数、数値、原文と重ならない行を警告する(意味の破綻は辞書では捕れない)
   */
  const finalizeResult = useCallback(async (original, raw, target) => {
    const { text: sanitized, removed } = sanitizeForTarget(raw, target);
    const report = {
      targetId: target.id,
      targetLabel: target.label[isJa ? 'ja' : 'en'],
      removed: summarizeRemovals(removed),
      fixed: [],
      diff: null,
      cliche: null,
      clicheError: null,
    };
    // 辞書の読み込みに失敗しても、サニタイズ済みの本文は返す。
    let finalText = sanitized;
    try {
      const { text: fixedText, applied } = await autoFix(sanitized, target.preset);
      finalText = fixedText;
      report.fixed = applied;
      const { violations, scope } = await checkText(finalText, target.preset);
      report.cliche = { violations, scope, counts: countBySeverity(violations) };
    } catch (e) {
      // 検査できなかったことを0件として見せない。失敗は失敗として出す。
      console.error('Dictionary check failed:', e);
      report.clicheError = e.message || String(e);
    }
    report.diff = diffReport(original, finalText);
    // 何も変わらなかったことを黙って返さない。利用者には失敗に見える。
    report.unchanged = finalText.trim() === original.trim();

    // 書き換えの前後をJevに突き合わせる。diffReportは行数と数値しか見ないので、
    // 数値を保ったまま意味が変わった書き換えは捕れない。
    // 「自然になったか」と「意味が保たれているか」を別に尋ね、意味のほうを厳しく取る。
    if (jevAvailable && !report.unchanged) {
      try {
        const { results } = await judgeRewrites(
          [{ id: 'whole', original, rewritten: finalText }],
          { clientKeys }
        );
        const r = results[0];
        if (r?.ok) report.jevGate = r.gate;
        else report.jevGateError = r?.error || 'unknown';
      } catch (e) {
        // 検証できなかったことを「通った」として見せない。
        console.error('Jev gate failed:', e);
        report.jevGateError = e.message || String(e);
      }
    }

    return { original, rewritten: finalText, report };
  }, [isJa, jevAvailable, clientKeys]);

  const handleRewrite = useCallback(async () => {
    const text = editorRef.current?.innerText?.trim();
    if (!text) { alert(t('pleaseEnterText')); return; }
    if (!checkRateLimit()) return;

    const modelId = resolveModel(text.length);
    setIsRewriting(true);
    setSuggestions([]);
    startProgress(modelId, text.length);
    try {
      const data = await rewriteViaProxy(modelId, text, clientKeys, targetInstruction(activeTarget, isJa), activeTarget.markdown);
      recordUsage(); setRemaining(getRemaining());
      const rewritten = data.content?.[0]?.text?.trim() || '';
      if (rewritten) setRewriteResult(await finalizeResult(text, rewritten, activeTarget));
      else alert(t('failedToRewrite'));
    } catch (e) {
      console.error('Rewrite error:', e);
      alert(e.message?.includes('401') ? t('failedUnauthorized') : t('failedToRewrite'));
    } finally { setIsRewriting(false); stopProgress(); }
  }, [resolveModel, clientKeys, startProgress, stopProgress, checkRateLimit, activeTarget, isJa, finalizeResult]);

  const handleCompose = useCallback(async () => {
    const text = editorRef.current?.innerText?.trim();
    if (!text) { alert(t('pleaseEnterText')); return; }
    if (!checkRateLimit()) return;

    const modelId = resolveModel(text.length);
    setIsComposing(true);
    setSuggestions([]);
    startProgress(modelId, text.length);
    try {
      const data = await composeViaProxy(modelId, text, clientKeys, {
        background, purpose, targetRules: targetInstruction(activeTarget, isJa), markdown: activeTarget.markdown,
      });
      recordUsage(); setRemaining(getRemaining());
      const composed = data.content?.[0]?.text?.trim() || '';
      if (composed) { setComposeResult(await finalizeResult(text, composed, activeTarget)); setComposeModalOpen(false); }
      else alert(t('failedToCompose'));
    } catch (e) {
      console.error('Compose error:', e);
      alert(e.message?.includes('401') ? t('failedUnauthorized') : t('failedToCompose'));
    } finally { setIsComposing(false); stopProgress(); }
  }, [resolveModel, clientKeys, background, purpose, startProgress, stopProgress, checkRateLimit, activeTarget, isJa, finalizeResult]);

  const handleRunAll = useCallback(async () => {
    const text = editorRef.current?.innerText?.trim();
    if (!text) { alert(t('pleaseEnterText')); return; }
    // RunAllは2回分消費するので事前チェック
    if (getRemaining() < 2) {
      const resetTime = getResetTime();
      const timeStr = resetTime ? new Date(resetTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      alert(t('rateLimitReached').replace('{time}', timeStr));
      return;
    }

    const modelId = resolveModel(text.length);
    setIsAnalyzing(true);
    setIsRewriting(true);
    setSuggestions([]);
    setLastUsage(null);
    startProgress(modelId, text.length);

    let pendingRewrite = null;

    await Promise.allSettled([
      analyzeViaProxy(modelId, text, clientKeys, customInstruction)
        .then((data) => {
          recordUsage();
          if (data.usage) setLastUsage({ ...data.usage, model: modelId });
          const content = data.content?.[0]?.text || '';
          try {
            const cleaned = content.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
            const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              setSuggestions(parsed.map((s, i) => ({ ...s, id: i, status: 'pending', type: s.type?.replace(/_/g, '-') })));
              setRightOpen(true); // 提案が届いたら改善提案パネルを自動的に開く
            } else console.warn('[runAll] analyze: no JSON array found in response');
          } catch (e) { console.error('[parse]', e, content); }
        })
        .catch((e) => { console.error('[analyze]', e); if (e.message?.includes('401')) alert(t('failedUnauthorized')); })
        .finally(() => setIsAnalyzing(false)),

      rewriteViaProxy(modelId, text, clientKeys, targetInstruction(activeTarget, isJa), activeTarget.markdown)
        .then(async (data) => {
          recordUsage();
          const rewritten = data.content?.[0]?.text?.trim() || '';
          if (rewritten) pendingRewrite = await finalizeResult(text, rewritten, activeTarget);
          else alert(t('failedToRewrite'));
        })
        .catch((e) => { console.error('[rewrite]', e); alert(e.message?.includes('401') ? t('failedUnauthorized') : t('failedToRewrite')); })
        .finally(() => setIsRewriting(false)),
    ]);

    setRemaining(getRemaining());
    stopProgress();
    if (pendingRewrite) setRewriteResult(pendingRewrite);
  }, [resolveModel, clientKeys, customInstruction, startProgress, stopProgress, activeTarget, isJa, finalizeResult]);

  /**
   * 結果モーダルの本文に対して、検出されたクリシェを辞書のaskに沿って直す。
   * 直した結果は再びサニタイズと自動修正と再検査に通す。
   * 原文との照合は最初の原文に対して行うので、繰り返すほど差分の累積が見える。
   */
  const handleRefine = useCallback(async () => {
    const current = rewriteResult || composeResult;
    const violations = current?.report?.cliche?.violations;
    if (!current || !violations?.length) return;
    if (!checkRateLimit()) return;

    const target = getTarget(current.report.targetId);
    const modelId = resolveModel(current.rewritten.length);
    setIsRefining(true);
    startProgress(modelId, current.rewritten.length);
    try {
      const data = await refineViaProxy(modelId, current.rewritten, clientKeys, violations, targetInstruction(target, isJa));
      recordUsage(); setRemaining(getRemaining());
      const refined = data.content?.[0]?.text?.trim() || '';
      if (!refined) { alert(t('failedToRefine')); return; }
      // 照合は最初の原文に対して行う。書き直しを重ねても、原文からのずれが見える。
      const next = await finalizeResult(current.original, refined, target);
      if (rewriteResult) setRewriteResult(next); else setComposeResult(next);
    } catch (e) {
      console.error('Refine error:', e);
      alert(e.message?.includes('401') ? t('failedUnauthorized') : t('failedToRefine'));
    } finally { setIsRefining(false); stopProgress(); }
  }, [rewriteResult, composeResult, clientKeys, isJa, resolveModel, startProgress, stopProgress, checkRateLimit, finalizeResult]);

  // rewrite / compose 両方の結果モーダルで共用
  const applyResult = useCallback(() => {
    tts.stop();
    const data = rewriteResult || composeResult;
    if (data && editorRef.current) {
      snapshot(); // Undo用にスナップショット
      editorRef.current.innerText = data.rewritten;
      refreshEditorContent();
      setSuggestions([]);
    }
    setRewriteResult(null);
    setComposeResult(null);
  }, [rewriteResult, composeResult, refreshEditorContent, snapshot, tts.stop]);

  const closeResult = useCallback(() => { tts.stop(); setRewriteResult(null); setComposeResult(null); }, [tts.stop]);

  const applySuggestion = useCallback((suggestion) => {
    if (!editorRef.current) return;
    snapshot(); // Undo用にスナップショット
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(suggestion.original);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + suggestion.original.length);
        range.deleteContents();
        range.insertNode(document.createTextNode(suggestion.suggestion));
        break;
      }
    }
    refreshEditorContent();
    setSuggestions((prev) => prev.map((s) => (s.id === suggestion.id ? { ...s, status: 'accepted' } : s)));
  }, [refreshEditorContent, snapshot]);

  const dismissSuggestion = useCallback((suggestion) => {
    setSuggestions((prev) => prev.map((s) => (s.id === suggestion.id ? { ...s, status: 'rejected' } : s)));
  }, []);

  const filteredSuggestions = activeCategory === 'all' ? suggestions : suggestions.filter((s) => s.type === activeCategory);
  const pendingFiltered = filteredSuggestions.filter((s) => s.status === 'pending');
  const applyAllSuggestions = () => { pendingFiltered.forEach((s) => applySuggestion(s)); };

  const loadSample = (text) => {
    if (editorRef.current) {
      snapshot();
      editorRef.current.innerText = text;
      refreshEditorContent();
      setSuggestions([]);
      setOpenDropdown(null);
    }
  };

  const isAutoMode = selectedModel === 'auto';
  const currentModel = isAutoMode ? null : (getModel(selectedModel) || AVAILABLE_MODELS[0]);
  const groupedModels = Object.keys(PROVIDERS).map((pKey) => ({
    provider: pKey,
    label: PROVIDERS[pKey].name,
    available: isProviderAvailable(pKey),
    models: AVAILABLE_MODELS.filter((m) => m.provider === pKey),
  }));

  // ─── ショートカットキー ─────────────────────
  // 文字入力中（contentEditable, input, textarea, IME変換中）は無効
  useEffect(() => {
    const handleKeyDown = (e) => {
      // IME変換中は無効
      if (isComposingRef.current) return;

      // ショートカット記録モード中は記録処理に委譲（後述のuseEffectで処理）
      if (recordingAction) return;

      // テキスト入力系要素にフォーカスがある場合、Mod系のみ処理
      const tag = document.activeElement?.tagName;
      const isEditable = document.activeElement?.isContentEditable;
      const isInputField = tag === 'INPUT' || tag === 'TEXTAREA' || isEditable;

      if (!isModKey(e)) return; // モディファイアなしは常にスキップ

      // Undo (入力欄でもエディタならカスタムUndo)
      if (matchShortcut(e, shortcuts.undo) && isEditable) {
        e.preventDefault();
        undo();
        return;
      }
      // Redo (入力欄でもエディタならカスタムRedo)
      if (matchShortcut(e, shortcuts.redo) && isEditable) {
        e.preventDefault();
        redo();
        return;
      }

      // input/textarea 内では以降のショートカットは無効
      if (isInputField && !isEditable) return;

      // 分析 & AI文体修正
      if (matchShortcut(e, shortcuts.runAll)) {
        e.preventDefault();
        handleRunAll();
        return;
      }
      // 分析のみ
      if (matchShortcut(e, shortcuts.analyze)) {
        e.preventDefault();
        handleAnalyze();
        return;
      }
      // AI文体修正のみ
      if (matchShortcut(e, shortcuts.rewrite)) {
        e.preventDefault();
        handleRewrite();
        return;
      }
    };

    const handleCompositionStart = () => { isComposingRef.current = true; };
    const handleCompositionEnd = () => { isComposingRef.current = false; };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('compositionstart', handleCompositionStart);
    window.addEventListener('compositionend', handleCompositionEnd);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('compositionstart', handleCompositionStart);
      window.removeEventListener('compositionend', handleCompositionEnd);
    };
  }, [undo, redo, handleRunAll, handleAnalyze, handleRewrite, shortcuts, recordingAction]);

  // ─── ショートカット記録モード ─────────────────────
  useEffect(() => {
    if (!recordingAction) return;
    const handleRecord = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Escで記録キャンセル
      if (e.key === 'Escape') { setRecordingAction(null); return; }
      const sc = shortcutFromEvent(e);
      if (!sc) return; // モディファイアキー単体は無視
      // 重複チェック: 他のアクションに同じキーが割り当て済みか
      const duplicate = Object.entries(shortcuts).find(
        ([action, def]) => action !== recordingAction && def.match.key === sc.match.key && def.match.shift === sc.match.shift && !!def.match.alt === !!sc.match.alt
      );
      if (duplicate) {
        const labels = { runAll: t('shortcutRunAll'), analyze: t('shortcutAnalyze'), rewrite: t('shortcutRewrite'), undo: t('shortcutUndo'), redo: t('shortcutRedo') };
        const msg = locale.startsWith('ja')
          ? `${formatShortcut(sc.parts)} は「${labels[duplicate[0]]}」に割り当て済みです`
          : `${formatShortcut(sc.parts)} is already assigned to "${labels[duplicate[0]]}"`;
        alert(msg);
        return;
      }
      const updated = { ...shortcuts, [recordingAction]: sc };
      setShortcuts(updated);
      saveShortcuts(updated);
      setRecordingAction(null);
    };
    window.addEventListener('keydown', handleRecord, true);
    return () => window.removeEventListener('keydown', handleRecord, true);
  }, [recordingAction, shortcuts]);

  const closeDropdown = useCallback(() => setOpenDropdown(null), []);

  // 結果モーダル（rewrite / compose 共用）の現在値
  const activeResult = rewriteResult || composeResult;
  const activeKind = rewriteResult ? 'rewrite' : (composeResult ? 'compose' : null);

  return (
    <div className="grain" style={{ minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)', transition: 'background 0.3s, color 0.3s' }}>

      {/* ─── Header ─────────────────────────────── */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* 左（操作パネル）トグル */}
          <TBtn onClick={() => setLeftOpen((v) => !v)} title={leftOpen ? t('collapseControls') : t('expandControls')}>
            {leftOpen ? <PanelLeftClose style={{ width: 17, height: 17 }} /> : <PanelLeftOpen style={{ width: 17, height: 17 }} />}
          </TBtn>
          <Feather style={{ width: 20, height: 20, color: 'var(--accent)', flexShrink: 0 }} />
          <h1 className="app-title">
            <span className="title-full">{t('appTitle')}</span>
            <span className="title-short">{t('appTitleShort')}</span>
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 残り利用回数（デフォルトキー使用時のみ） */}
          {!hasUserKeys() && (
            <span style={{ fontSize: 12, color: remaining <= 10 ? 'var(--cat-grammar)' : 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
              {remaining}/{RATE_LIMIT}
            </span>
          )}
          {/* Model Selector */}
          <Dropdown
            open={openDropdown === 'model'}
            onClose={closeDropdown}
            align="right"
            trigger={
              <button
                onClick={() => setOpenDropdown(openDropdown === 'model' ? null : 'model')}
                title={t('selectModel')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 10px', fontSize: 12, fontWeight: 500,
                  color: 'var(--text-secondary)', background: 'var(--bg-primary)',
                  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-accent)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: isAutoMode ? 'var(--accent)' : (isProviderAvailable(currentModel.provider) ? 'var(--accept)' : 'var(--cat-spelling)'), flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{isAutoMode ? t('autoMode') : currentModel.name}</span>
                {isAutoMode && <span style={{ fontSize: 12, opacity: 0.6, fontWeight: 400 }}>
                  {getModel(autoSelectModel(charCount, isProviderAvailable))?.name || ''}
                </span>}
                <ChevronDown style={{ width: 12, height: 12, opacity: 0.4 }} />
              </button>
            }
          >
            <div style={{ width: 360, maxHeight: 420, overflow: 'auto', padding: '6px 0' }}>
              {/* Auto Mode */}
              <button
                onClick={() => { setSelectedModel('auto'); closeDropdown(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '10px 14px', fontSize: 13, fontWeight: isAutoMode ? 600 : 400,
                  background: isAutoMode ? 'var(--accent-soft)' : 'transparent',
                  border: 'none', borderLeft: isAutoMode ? '3px solid var(--accent)' : '3px solid transparent',
                  color: isAutoMode ? 'var(--accent)' : 'var(--text-primary)',
                  cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s',
                }}
                onMouseEnter={(e) => { if (!isAutoMode) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { if (!isAutoMode) e.currentTarget.style.background = 'transparent'; }}
              >
                <Sparkles style={{ width: 14, height: 14, color: 'var(--accent)' }} />
                <div>
                  <div>{t('autoMode')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 1 }}>{t('autoModeDesc')}</div>
                </div>
              </button>
              <div style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
              {groupedModels.map((group) => (
                <div key={group.provider} style={{ marginBottom: 4 }}>
                  {/* Provider header */}
                  <div style={{
                    padding: '8px 14px 4px',
                    fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                    color: group.available ? 'var(--text-muted)' : 'var(--text-faint)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: group.available ? 'var(--accept)' : 'var(--text-faint)' }} />
                    {group.label}
                  </div>

                  {/* Model grid */}
                  {group.models.map((m) => {
                    const isSelected = selectedModel === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => { if (group.available) { setSelectedModel(m.id); closeDropdown(); } }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr auto auto auto',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '8px 14px',
                          fontSize: 12,
                          background: isSelected ? 'var(--accent-soft)' : 'transparent',
                          border: 'none',
                          borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                          color: group.available ? 'var(--text-primary)' : 'var(--text-faint)',
                          cursor: group.available ? 'pointer' : 'default',
                          textAlign: 'left',
                          transition: 'all 0.12s',
                          opacity: group.available ? 1 : 0.4,
                        }}
                        onMouseEnter={(e) => { if (group.available && !isSelected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      >
                        {/* Name + description */}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: isSelected ? 600 : 400, fontSize: 13, color: isSelected ? 'var(--accent)' : undefined }}>
                            {m.name}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 1 }}>{m.description}</div>
                        </div>

                        {/* Speed dots */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <Dots count={m.speed} color="var(--cat-grammar)" />
                          <span style={{ fontSize: 12, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('speed')}</span>
                        </div>

                        {/* Quality dots */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <Dots count={m.quality} color="var(--cat-clarity)" />
                          <span style={{ fontSize: 12, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('quality')}</span>
                        </div>

                        {/* Price */}
                        <div style={{ fontSize: 12, color: m.inputPrice === 0 ? 'var(--accept)' : 'var(--text-muted)', fontWeight: 500, textAlign: 'right', minWidth: 36 }}>
                          {m.inputPrice === 0 && m.outputPrice === 0 ? t('free') : `$${m.inputPrice}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* Settings shortcut at bottom */}
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '6px 8px 2px' }}>
                <button
                  onClick={() => { closeDropdown(); setShowSettingsDialog(true); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    padding: '6px 8px', fontSize: 12, color: 'var(--text-muted)',
                    background: 'none', border: 'none', borderRadius: 'var(--radius)',
                    cursor: 'pointer', transition: 'color 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                >
                  <Key style={{ width: 12, height: 12 }} />
                  API Keys...
                </button>
              </div>
            </div>
          </Dropdown>

          {/* Undo / Redo */}
          <TBtn onClick={undo} title={`Undo (${formatShortcut(shortcuts.undo.parts)})`}>
            <Undo2 style={{ width: 16, height: 16, opacity: canUndo() ? 1 : 0.3 }} />
          </TBtn>
          <TBtn onClick={redo} title={`Redo (${formatShortcut(shortcuts.redo.parts)})`}>
            <Redo2 style={{ width: 16, height: 16, opacity: canRedo() ? 1 : 0.3 }} />
          </TBtn>

          {/* Reset editor settings */}
          <TBtn onClick={resetEditorSettings} title={t('resetSettings')}>
            <RotateCcw style={{ width: 16, height: 16 }} />
          </TBtn>

          {/* Settings button */}
          <TBtn onClick={() => setShowSettingsDialog(true)} title="API Keys">
            <Settings style={{ width: 17, height: 17 }} />
          </TBtn>

          {/* Dark mode */}
          <TBtn onClick={() => setDarkMode(!darkMode)} title={darkMode ? 'Light mode' : 'Dark mode'}>
            {darkMode ? <Sun style={{ width: 17, height: 17 }} /> : <Moon style={{ width: 17, height: 17 }} />}
          </TBtn>

          {/* 右（改善提案）トグル。閉じている間に新しい提案が届くとバッジで知らせる */}
          <div style={{ position: 'relative' }}>
            <TBtn onClick={() => setRightOpen((v) => !v)} title={rightOpen ? t('collapseSuggestions') : t('expandSuggestions')}>
              {rightOpen ? <PanelRightClose style={{ width: 17, height: 17 }} /> : <PanelRightOpen style={{ width: 17, height: 17 }} />}
            </TBtn>
            {!rightOpen && suggestions.length > 0 && (
              <span style={{
                position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: '50%',
                background: 'var(--cat-spelling)', border: '1.5px solid var(--bg-surface)',
              }} />
            )}
          </div>
        </div>
      </header>

      <div className="main-layout">

        {/* ─── Control Sidebar（左）: 文脈整形・追加指示・実行ボタン群 ─── */}
        <div className={`control-sidebar${leftOpen ? '' : ' collapsed'}`}>
          {/* Compose（文脈整形）: メインエリアを圧迫しない1行トリガー。クリックでモーダルを開く */}
          <div style={{ padding: '14px 24px 0' }}>
            <div className="compose-card">
              <button
                onClick={() => setComposeModalOpen(true)}
                aria-haspopup="dialog"
                title={t('composeModeDesc')}
                className="compose-toggle">
                <span className="compose-icon">
                  <Feather style={{ width: 19, height: 19 }} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{t('composeMode')}</span>
                    <span className="compose-badge">{t('composeBadge')}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('composeModeDesc')}</span>
                </span>
                <span className="compose-chevron" aria-hidden="true">
                  <ChevronDown style={{ width: 18, height: 18, transform: 'rotate(-90deg)' }} />
                </span>
              </button>
            </div>
          </div>

          {/* 出力先テンプレート：プロンプト制約・生成後の除去・辞書プリセットを一括で決める */}
          <div style={{ padding: '14px 24px 0', borderTop: '1px solid var(--border-primary)' }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
              {t('outputTarget')}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {targets.map((tg) => (
                <button key={tg.id}
                  onClick={() => setOutputTargetId(tg.id)}
                  title={tg.descText}
                  aria-pressed={outputTargetId === tg.id}
                  style={{
                    padding: '4px 11px', fontSize: 12, fontWeight: 500,
                    border: '1px solid var(--border-primary)', borderRadius: 20,
                    background: outputTargetId === tg.id ? 'var(--accent)' : 'var(--bg-secondary)',
                    color: outputTargetId === tg.id ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
                  }}>
                  {tg.labelText}
                </button>
              ))}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
              {targets.find((tg) => tg.id === outputTargetId)?.descText}
            </p>
          </div>

          {/* Custom Instruction */}
          <div style={{ padding: '14px 24px 0', borderTop: '1px solid var(--border-primary)' }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6 }}>
              {t('customInstruction')}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {(t('instructionTemplates') || []).map((tmpl) => (
                <button key={tmpl.label}
                  onClick={() => setCustomInstruction(customInstruction === tmpl.text ? '' : tmpl.text)}
                  style={{
                    padding: '3px 10px', fontSize: 12, fontWeight: 500,
                    border: '1px solid var(--border-primary)', borderRadius: 20,
                    background: customInstruction === tmpl.text ? 'var(--accent)' : 'var(--bg-secondary)',
                    color: customInstruction === tmpl.text ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
                  }}>
                  {tmpl.label}
                </button>
              ))}
            </div>
            <textarea
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder={t('customInstructionPlaceholder')}
              rows={3}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 13,
                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)',
                background: 'var(--bg-primary)', color: 'var(--text-primary)',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                lineHeight: 1.5, fontFamily: 'inherit', transition: 'border-color 0.15s',
              }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
              onBlur={(e) => (e.target.style.borderColor = 'var(--border-primary)')}
            />
          </div>

          {/* Action Buttons */}
          <div style={{ padding: '12px 24px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* 分析 & AI文体修正（トータル） */}
            <button onClick={handleRunAll} disabled={isAnalyzing || isRewriting}
              className={(isAnalyzing || isRewriting) ? 'animate-shimmer' : 'animate-pulse-accent'}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
                padding: '12px 14px', fontSize: 13, fontWeight: 600, letterSpacing: '0.01em',
                color: '#fff', background: (isAnalyzing || isRewriting) ? undefined : 'var(--accent)',
                border: 'none', borderRadius: 'var(--radius)', cursor: (isAnalyzing || isRewriting) ? 'wait' : 'pointer', transition: 'background 0.2s, transform 0.1s' }}
              onMouseEnter={(e) => { if (!isAnalyzing && !isRewriting) e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={(e) => { if (!isAnalyzing && !isRewriting) e.currentTarget.style.background = 'var(--accent)'; }}
              onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.99)'; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
              {(isAnalyzing || isRewriting)
                ? (<><Loader2 style={{ width: 15, height: 15, flexShrink: 0 }} className="animate-spin-slow" />
                    {isAnalyzing && isRewriting ? `${t('analyzing')} & ${t('rewriting')}` : isAnalyzing ? t('analyzing') : t('rewriting')}
                    <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginLeft: 2 }}>
                      {Math.min(99, Math.round((elapsedSecs / Math.max(1, estimatedSecs)) * 100))}%
                    </span></>)
                : (<><Sparkles style={{ width: 14, height: 14, flexShrink: 0 }} /><Wand2 style={{ width: 14, height: 14, flexShrink: 0 }} />{t('runAll')}
                    <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 2 }}>{formatShortcut(shortcuts.runAll.parts)}</span></>)}
            </button>
            {/* プログレスバー */}
            {(isAnalyzing || isRewriting) && estimatedSecs > 0 && (
              <div style={{ height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  background: 'var(--accent)',
                  width: `${Math.min(95, (elapsedSecs / estimatedSecs) * 100)}%`,
                  transition: 'width 1s linear',
                }} />
              </div>
            )}
            {/* 分析のみ / AI文体修正のみ */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleAnalyze} disabled={isAnalyzing}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '9px 12px', fontSize: 12, fontWeight: 600,
                  color: 'var(--accent)', background: 'transparent',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)',
                  cursor: isAnalyzing ? 'wait' : 'pointer', transition: 'all 0.15s' }}
                onMouseEnter={(e) => { if (!isAnalyzing) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-soft)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.background = 'transparent'; }}>
                {isAnalyzing
                  ? (<><Loader2 style={{ width: 14, height: 14 }} className="animate-spin-slow" />{t('analyzing')}
                      <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.min(99, Math.round((elapsedSecs / Math.max(1, estimatedSecs)) * 100))}%</span></>)
                  : (<><Sparkles style={{ width: 14, height: 14 }} />{t('analyzeText')}
                      <span style={{ fontSize: 12, opacity: 0.6 }}>{formatShortcut(shortcuts.analyze.parts)}</span></>)}
              </button>
              <button onClick={handleRewrite} disabled={isRewriting}
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '9px 12px', fontSize: 12, fontWeight: 600,
                  color: 'var(--cat-ai-writing)', background: 'transparent',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)',
                  cursor: isRewriting ? 'wait' : 'pointer', transition: 'all 0.15s' }}
                onMouseEnter={(e) => { if (!isRewriting) { e.currentTarget.style.borderColor = 'var(--cat-ai-writing)'; e.currentTarget.style.background = 'var(--cat-ai-writing-bg)'; } }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.background = 'transparent'; }}>
                {isRewriting
                  ? (<><Loader2 style={{ width: 14, height: 14 }} className="animate-spin-slow" />{t('rewriting')}
                      <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.min(99, Math.round((elapsedSecs / Math.max(1, estimatedSecs)) * 100))}%</span></>)
                  : (<><Wand2 style={{ width: 14, height: 14 }} />{t('rewriteAI')}
                      <span style={{ fontSize: 12, opacity: 0.6 }}>{formatShortcut(shortcuts.rewrite.parts)}</span></>)}
              </button>
            </div>
          </div>
        </div>

        {/* ─── Editor Panel ──────────────────────── */}
        <div className="editor-panel">

          {/* Toolbar */}
          <div style={{
            background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-primary)',
            padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
          }}>
            {/* Font Family */}
            <Dropdown open={openDropdown === 'font'} onClose={closeDropdown} trigger={
              <button onClick={() => setOpenDropdown(openDropdown === 'font' ? null : 'font')} title={t('fontFamily')}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 13,
                  fontFamily: getFontStack(fontFamily), color: 'var(--text-secondary)', background: 'none',
                  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', cursor: 'pointer',
                  minWidth: 130, justifyContent: 'space-between', transition: 'border-color 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fontFamily}</span>
                <ChevronDown style={{ width: 12, height: 12, opacity: 0.5 }} />
              </button>
            }>
              {FONTS.map((f) => (
                <button key={f.name} onClick={() => { setFontFamily(f.name); execCmd('fontName', f.name); closeDropdown(); }}
                  className={`dropdown-item ${fontFamily === f.name ? 'selected' : ''}`} style={{ fontFamily: f.stack }}>{f.label}</button>
              ))}
            </Dropdown>

            {/* Font Size */}
            <Dropdown open={openDropdown === 'size'} onClose={closeDropdown} trigger={
              <button onClick={() => setOpenDropdown(openDropdown === 'size' ? null : 'size')} title={t('fontSize')}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 13,
                  color: 'var(--text-secondary)', background: 'none', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius)', cursor: 'pointer', minWidth: 58, justifyContent: 'space-between', transition: 'border-color 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}>
                {fontSize} <ChevronDown style={{ width: 12, height: 12, opacity: 0.5 }} />
              </button>
            }>
              {FONT_SIZES.map((s) => (
                <button key={s} onClick={() => { setFontSize(s); execCmd('fontSize', FONT_SIZES.indexOf(s) + 1); closeDropdown(); }}
                  className={`dropdown-item ${fontSize === s ? 'selected' : ''}`}>{s}</button>
              ))}
            </Dropdown>

            <Sep />
            <TBtn onClick={() => execCmd('bold')} title={t('bold')}><Bold style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('italic')} title={t('italic')}><Italic style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('underline')} title={t('underline')}><Underline style={{ width: 16, height: 16 }} /></TBtn>
            <Sep />

            <ColorSwatches title={t('textColor')} icon={<Type style={{ width: 16, height: 16 }} />}
              colors={TEXT_COLORS} activeColor="#1f2430"
              saveSelection={saveSelection} restoreSelection={restoreSelection}
              onApplyColor={(c) => execCmd('foreColor', c)} />
            <ColorSwatches title={t('textHighlightColor')} icon={<Highlighter style={{ width: 16, height: 16 }} />}
              colors={HIGHLIGHT_COLORS} activeColor="transparent"
              saveSelection={saveSelection} restoreSelection={restoreSelection}
              onApplyColor={(c) => { if (c === 'transparent') { execCmd('removeFormat'); } else { execCmd('hiliteColor', c); } }} />
            <TBtn onClick={() => { saveSelection(); setShowLinkDialog(true); }} title={t('addLink')}>
              <Link style={{ width: 16, height: 16 }} />
            </TBtn>
            <Sep />
            <TBtn onClick={() => execCmd('justifyLeft')} title={t('alignLeft')}><AlignLeft style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('justifyCenter')} title={t('alignCenter')}><AlignCenter style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('justifyRight')} title={t('alignRight')}><AlignRight style={{ width: 16, height: 16 }} /></TBtn>
            <Sep />

            {/* Line Spacing */}
            <Dropdown open={openDropdown === 'spacing'} onClose={closeDropdown} trigger={
              <TBtn onClick={() => setOpenDropdown(openDropdown === 'spacing' ? null : 'spacing')} title={t('lineSpacing')}>
                <MoveVertical style={{ width: 16, height: 16 }} />
              </TBtn>
            }>
              {LINE_SPACINGS.map((s) => (
                <button key={s} onClick={() => { setLineSpacing(s); closeDropdown(); }}
                  className={`dropdown-item ${lineSpacing === s ? 'selected' : ''}`}>{s}</button>
              ))}
            </Dropdown>
            {/* Letter Spacing */}
            <Dropdown open={openDropdown === 'letterSpacing'} onClose={closeDropdown} trigger={
              <TBtn onClick={() => setOpenDropdown(openDropdown === 'letterSpacing' ? null : 'letterSpacing')} title={t('letterSpacing')}>
                <MoveHorizontal style={{ width: 16, height: 16 }} />
              </TBtn>
            }>
              {LETTER_SPACINGS.map((s) => (
                <button key={s} onClick={() => { setLetterSpacing(s); closeDropdown(); }}
                  className={`dropdown-item ${letterSpacing === s ? 'selected' : ''}`}>{s === '0' ? 'Normal' : s}</button>
              ))}
            </Dropdown>
            <TBtn onClick={() => execCmd('insertUnorderedList')} title={t('bulletList')}><List style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('insertOrderedList')} title={t('numberedList')}><ListOrdered style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('outdent')} title={t('decreaseIndent')}><Outdent style={{ width: 16, height: 16 }} /></TBtn>
            <TBtn onClick={() => execCmd('indent')} title={t('increaseIndent')}><Indent style={{ width: 16, height: 16 }} /></TBtn>
          </div>

          {/* Editor Area */}
          <div className="editor-split">
            <div className="editor-area">
              <div style={{
                background: 'var(--bg-surface)', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
                height: '100%', display: 'flex', flexDirection: 'column',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{t('yourText')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{charCount.toLocaleString()} {t('characters')}</span>
                    {/* Sample Text */}
                    <Dropdown open={openDropdown === 'sample'} onClose={closeDropdown} align="right" trigger={
                      <button onClick={() => setOpenDropdown(openDropdown === 'sample' ? null : 'sample')} title={t('sampleTexts')}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 12,
                          fontWeight: 500, color: 'var(--accent)', background: 'var(--accent-soft)',
                          border: '1px solid transparent', borderRadius: 'var(--radius)', cursor: 'pointer', transition: 'all 0.15s' }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'transparent')}>
                        <FileText style={{ width: 12, height: 12 }} />{t('sample')}<ChevronDown style={{ width: 10, height: 10, opacity: 0.6 }} />
                      </button>
                    }>
                      {SAMPLES.map((s, i) => (
                        <button key={i} onClick={() => loadSample(s.text)} className="dropdown-item" style={{ fontSize: 12 }}>{s.label}</button>
                      ))}
                    </Dropdown>
                    {/* 本文の読み上げ / 停止 */}
                    <button onClick={() => tts.toggle(editorRef.current?.innerText?.trim() || '', 'editor')}
                      className="toolbar-btn" title={tts.speakingId === 'editor' ? t('ttsStop') : t('ttsReadAloud')}
                      style={{ width: 28, height: 28, color: tts.speakingId === 'editor' ? 'var(--accent)' : undefined }}>
                      {tts.speakingId === 'editor'
                        ? (tts.loading ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin-slow" /> : <Square style={{ width: 12, height: 12, fill: 'currentColor' }} />)
                        : <Volume2 style={{ width: 15, height: 15 }} />}
                    </button>
                    <TtsSettings tts={tts} />
                    <button onClick={handleCopy} className="toolbar-btn" title={t('copy')} style={{ width: 28, height: 28 }}>
                      {copied ? <Check style={{ width: 14, height: 14, color: 'var(--accept)' }} /> : <Copy style={{ width: 14, height: 14 }} />}
                    </button>
                    <button onClick={resetEditorContent} className="toolbar-btn" title={t('resetText')} style={{ width: 28, height: 28 }}>
                      <Eraser style={{ width: 14, height: 14 }} />
                    </button>
                  </div>
                </div>
                <div ref={editorRef} contentEditable data-placeholder={t('pleaseEnterText')} suppressContentEditableWarning
                  style={{ flex: 1, padding: '24px 28px', fontFamily: getFontStack(fontFamily), fontSize, lineHeight: lineSpacing, letterSpacing, color: 'var(--text-primary)', minHeight: 200, outline: 'none', overflow: 'auto' }} />
              </div>
            </div>

          </div>

          {/* 左サイドバーが閉じている時のためのコンパクト実行ボタン（実行手段を常時確保） */}
          {!leftOpen && (
            <div style={{ padding: '0 24px 16px', flexShrink: 0 }}>
              <button onClick={handleRunAll} disabled={isAnalyzing || isRewriting}
                className={(isAnalyzing || isRewriting) ? 'animate-shimmer' : 'animate-pulse-accent'}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '10px 20px', fontSize: 13, fontWeight: 600, letterSpacing: '0.01em',
                  color: '#fff', background: (isAnalyzing || isRewriting) ? undefined : 'var(--accent)',
                  border: 'none', borderRadius: 'var(--radius)', cursor: (isAnalyzing || isRewriting) ? 'wait' : 'pointer', transition: 'background 0.2s' }}
                onMouseEnter={(e) => { if (!isAnalyzing && !isRewriting) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                onMouseLeave={(e) => { if (!isAnalyzing && !isRewriting) e.currentTarget.style.background = 'var(--accent)'; }}>
                {(isAnalyzing || isRewriting)
                  ? (<><Loader2 style={{ width: 15, height: 15 }} className="animate-spin-slow" />
                      {isAnalyzing && isRewriting ? `${t('analyzing')} & ${t('rewriting')}` : isAnalyzing ? t('analyzing') : t('rewriting')}
                      <span style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginLeft: 4 }}>
                        {Math.min(99, Math.round((elapsedSecs / Math.max(1, estimatedSecs)) * 100))}%
                      </span></>)
                  : (<><Sparkles style={{ width: 14, height: 14 }} /><Wand2 style={{ width: 14, height: 14 }} />{t('runAll')}
                      <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 4 }}>{formatShortcut(shortcuts.runAll.parts)}</span></>)}
              </button>
            </div>
          )}
        </div>

        {/* ─── Suggestions Panel ─────────────────── */}
        <div className={`suggestions-panel${rightOpen ? '' : ' collapsed'}`}>
          <JevMeter
            available={jevAvailable}
            status={jev.status}
            summary={jev.summary}
            stats={jev.stats}
            error={jev.error}
            units={jev.units}
            verdicts={jev.verdicts}
            onSelect={selectSentence}
          />
          <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
              <h2 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('suggestions')}
                {suggestions.length > 0 && (
                  <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)', fontFamily: getFontStack('Source Sans 3'), marginLeft: 8 }}>
                    {suggestions.filter((s) => s.status === 'pending').length}/{suggestions.length}
                  </span>
                )}
              </h2>
              {suggestions.length > 0 && (
                <button
                  onClick={rejectAllSuggestions}
                  style={{
                    padding: '4px 10px', fontSize: 12, fontWeight: 600,
                    borderRadius: 999, border: '1px solid var(--border-subtle)',
                    background: 'transparent', color: 'var(--text-muted)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--cat-spelling)'; e.currentTarget.style.color = 'var(--cat-spelling)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
                >
                  {t('rejectAllSuggestions')}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CATEGORIES.map((cat) => {
                const count = cat === 'all' ? suggestions.length : suggestions.filter((s) => s.type === cat).length;
                return (<button key={cat} onClick={() => setActiveCategory(cat)} className={`cat-pill ${activeCategory === cat ? 'active' : ''}`}>
                  {t(cat)}{cat !== 'all' && <span style={{ opacity: 0.7, marginLeft: 3 }}>({count})</span>}
                </button>);
              })}
            </div>
            {triageInfo && (
              // 送った範囲を隠さない。全文を見た結果として指摘が少ないのか、
              // 絞ったから少ないのかで、利用者の読み方が変わる。
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {fmt('jevTriageScope', { sent: triageInfo.sent, total: triageInfo.total })}
              </div>
            )}
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 16px' }}>
            {filteredSuggestions.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px 20px', textAlign: 'center' }}>
                <Feather style={{ width: 32, height: 32, color: 'var(--text-faint)', marginBottom: 16, opacity: 0.5 }} />
                <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 240 }}>
                  {suggestions.length === 0 ? t('clickAnalyzeText') : t('noSuggestionsCategory')}
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {filteredSuggestions.map((s) => {
                  const catStyle = CAT_STYLES[s.type] || {};
                  const isDone = s.status !== 'pending';
                  return (
                    <div key={s.id} className="suggestion-card animate-fade-in-up"
                      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)',
                        padding: '14px 16px', opacity: isDone ? 0.45 : 1, transition: 'opacity 0.3s, border-color 0.15s, box-shadow 0.15s',
                        borderColor: isDone ? 'var(--border-subtle)' : 'var(--border-primary)' }}
                      onMouseEnter={(e) => { if (!isDone) { e.currentTarget.style.borderColor = 'var(--border-accent)'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; } }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = isDone ? 'var(--border-subtle)' : 'var(--border-primary)'; e.currentTarget.style.boxShadow = 'none'; }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 100, background: catStyle.bg, color: catStyle.color }}>{t(s.type)}</span>
                        {isDone && <span style={{ fontSize: 12, fontWeight: 500, color: s.status === 'accepted' ? 'var(--accept)' : 'var(--text-muted)', fontStyle: 'italic' }}>{s.status === 'accepted' ? t('accept') : t('reject')}</span>}
                      </div>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>{s.explanation}</p>
                      <div style={{ fontSize: 13, lineHeight: 1.5, padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--bg-primary)', fontFamily: getFontStack(fontFamily) }}>
                        <span style={{ textDecoration: 'line-through', color: 'var(--cat-spelling)', opacity: 0.7 }}>{s.original}</span>
                        <span style={{ margin: '0 6px', color: 'var(--text-faint)' }}>{'\u2192'}</span>
                        <span style={{ color: 'var(--accept)', fontWeight: 500 }}>{s.suggestion}</span>
                      </div>
                      {!isDone && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button onClick={() => applySuggestion(s)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 'var(--radius)', border: 'none', background: 'var(--accept)', color: '#fff', cursor: 'pointer', transition: 'background 0.15s' }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accept-hover)')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--accept)')}>
                            <Check style={{ width: 12, height: 12 }} />{t('accept')}
                          </button>
                          <button onClick={() => dismissSuggestion(s)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, padding: '5px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', transition: 'all 0.15s' }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--cat-spelling)'; e.currentTarget.style.color = 'var(--cat-spelling)'; e.currentTarget.style.background = 'var(--reject-soft)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}>
                            <X style={{ width: 12, height: 12 }} />{t('reject')}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {pendingFiltered.length > 0 && (
            <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border-primary)' }}>
              <button onClick={applyAllSuggestions}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 16px', fontSize: 13, fontWeight: 600, color: 'var(--accept)', background: 'var(--accept-soft)', border: '1px solid var(--accept)', borderRadius: 'var(--radius)', cursor: 'pointer', transition: 'all 0.2s' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accept)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accept-soft)'; e.currentTarget.style.color = 'var(--accept)'; }}>
                <Check style={{ width: 14, height: 14 }} />{t('applyAllSuggestions')} ({pendingFiltered.length})
              </button>
            </div>
          )}
          {lastUsage && (() => {
            const m = getModel(lastUsage.model);
            const inTok = lastUsage.input_tokens || 0;
            const outTok = lastUsage.output_tokens || 0;
            const costUsd = m ? (inTok / 1e6) * m.inputPrice + (outTok / 1e6) * m.outputPrice : 0;
            const costJpy = costUsd * 150;
            return (
              <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 12, color: 'var(--text-faint)', display: 'flex', justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' }}>
                <span>{inTok.toLocaleString()} + {outTok.toLocaleString()} tokens</span>
                <span>≈ ¥{costJpy < 0.01 ? '0.01未満' : costJpy.toFixed(2)}</span>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ─── Link Dialog ─────────────────────────── */}
      {showLinkDialog && (
        <div className="modal-backdrop" onClick={() => { setShowLinkDialog(false); setLinkUrl(''); }}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600, marginBottom: 20, color: 'var(--text-primary)' }}>{t('addLinkTitle')}</h3>
            <input type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder={t('enterUrl')} autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleAddLink()}
              style={{ width: '100%', padding: '10px 14px', fontSize: 14, border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginBottom: 20, boxSizing: 'border-box', transition: 'border-color 0.15s' }}
              onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')} onBlur={(e) => (e.target.style.borderColor = 'var(--border-primary)')} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => { setShowLinkDialog(false); setLinkUrl(''); }}
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: 500, borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s' }}>{t('cancel')}</button>
              <button onClick={handleAddLink}
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius)', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--accent)')}>{t('add')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── API Key Settings Dialog ─────────────── */}
      {showSettingsDialog && (
        <div className="modal-backdrop" onClick={() => setShowSettingsDialog(false)}>
          <div className="modal-panel" style={{ width: 440, maxHeight: '85vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <h3 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Key style={{ width: 18, height: 18, color: 'var(--accent)' }} /> API Keys
              </h3>
              <button onClick={() => setShowSettingsDialog(false)} className="toolbar-btn" style={{ width: 28, height: 28 }}>
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.5 }}>
              {locale.startsWith('ja')
                ? 'APIキーをブラウザに保存します。サーバーの.envが設定済みの場合はそちらが優先されます。'
                : 'API keys are stored in your browser. Server .env keys take priority if configured.'}
            </p>

            {Object.entries(PROVIDERS).map(([key, provider]) => (
              <div key={key} style={{ marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: isProviderAvailable(key) ? 'var(--accept)' : 'var(--text-faint)' }} />
                  {provider.name}
                  {availableProviders[key] && (
                    <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--accept)', fontStyle: 'italic' }}>
                      ({locale.startsWith('ja') ? 'サーバー設定済み' : 'server configured'})
                    </span>
                  )}
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type={keyVisibility[key] ? 'text' : 'password'}
                      value={clientKeys[key] || ''}
                      onChange={(e) => { setClientKeys((prev) => ({ ...prev, [key]: e.target.value.trim() || undefined })); setTestResults((prev) => { const next = { ...prev }; delete next[key]; return next; }); }}
                      placeholder={provider.envKey}
                      style={{
                        width: '100%', padding: '8px 36px 8px 12px', fontSize: 13,
                        border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)',
                        background: 'var(--bg-primary)', color: 'var(--text-primary)',
                        outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.15s',
                        fontFamily: 'monospace',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')}
                      onBlur={(e) => (e.target.style.borderColor = 'var(--border-primary)')}
                    />
                    <button
                      onClick={() => setKeyVisibility((prev) => ({ ...prev, [key]: !prev[key] }))}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2 }}>
                      {keyVisibility[key] ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                    </button>
                  </div>
                  <button
                    onClick={() => handleTestConnection(key)}
                    disabled={testResults[key]?.loading}
                    style={{
                      padding: '8px 12px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
                      borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)',
                      background: testResults[key]?.ok ? 'var(--accept)' : 'var(--bg-secondary)',
                      color: testResults[key]?.ok ? '#fff' : 'var(--text-secondary)',
                      cursor: testResults[key]?.loading ? 'wait' : 'pointer',
                      transition: 'all 0.15s',
                    }}>
                    {testResults[key]?.loading ? t('testing')
                      : testResults[key]?.ok ? t('connectionOk')
                      : testResults[key]?.error ? t('connectionFailed')
                      : t('testConnection')}
                  </button>
                </div>
                {testResults[key] && !testResults[key].loading && !testResults[key].ok && testResults[key].error && (
                  <p style={{ fontSize: 12, color: 'var(--reject)', marginTop: 4, marginBottom: 0, wordBreak: 'break-all' }}>
                    {testResults[key].error}
                  </p>
                )}
              </div>
            ))}

            {/* ─── Voice Reader（音声読み上げ） ─────────────── */}
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Volume2 style={{ width: 14, height: 14, color: 'var(--accent)' }} />
                {t('ttsSection')}
              </h4>
              <TtsSettingsForm tts={tts} />
            </div>

            {/* ─── Keyboard Shortcuts ─────────────── */}
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {t('shortcuts')}
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { action: 'runAll', label: t('shortcutRunAll') },
                  { action: 'analyze', label: t('shortcutAnalyze') },
                  { action: 'rewrite', label: t('shortcutRewrite') },
                  { action: 'undo', label: t('shortcutUndo') },
                  { action: 'redo', label: t('shortcutRedo') },
                ].map(({ action, label }) => (
                  <div key={action} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius)', border: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
                    <button
                      onClick={() => setRecordingAction(recordingAction === action ? null : action)}
                      style={{
                        padding: '4px 12px', fontSize: 12, fontWeight: 600,
                        fontFamily: 'ui-monospace, monospace',
                        borderRadius: 'var(--radius)',
                        border: `1px solid ${recordingAction === action ? 'var(--accent)' : 'var(--border-primary)'}`,
                        background: recordingAction === action ? 'var(--accent-soft)' : 'var(--bg-secondary)',
                        color: recordingAction === action ? 'var(--accent)' : 'var(--text-primary)',
                        cursor: 'pointer', transition: 'all 0.15s', minWidth: 100, textAlign: 'center',
                      }}>
                      {recordingAction === action ? t('shortcutRecording') : formatShortcut(shortcuts[action].parts)}
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => { setShortcuts({ ...DEFAULT_SHORTCUTS }); saveShortcuts(DEFAULT_SHORTCUTS); }}
                style={{ marginTop: 8, padding: '4px 10px', fontSize: 12, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
                {t('shortcutReset')}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={() => { setClientKeys({}); }}
                style={{ padding: '8px 16px', fontSize: 12, fontWeight: 500, borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                {locale.startsWith('ja') ? 'クリア' : 'Clear All'}
              </button>
              <button onClick={() => setShowSettingsDialog(false)}
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius)', border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--accent)')}>
                {locale.startsWith('ja') ? '完了' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 文脈整形 入力ダイアログ（背景・目的） ─────────────── */}
      {composeModalOpen && (
        <div className="modal-backdrop" onClick={() => { if (!isComposing) setComposeModalOpen(false); }}>
          <div
            style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border-primary)',
              boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius-lg)',
              width: 'min(760px, calc(100vw - 48px))', maxHeight: '88vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              animation: 'fadeInUp 0.25s ease-out',
            }}
            onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '22px 28px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                <span className="compose-icon" style={{ width: 42, height: 42 }}><Feather style={{ width: 21, height: 21 }} /></span>
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 25, fontWeight: 600, color: 'var(--text-primary)', margin: 0, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('composeMode')}</h3>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('composeModeDesc')}</p>
                </div>
              </div>
              <button onClick={() => setComposeModalOpen(false)} className="toolbar-btn" style={{ width: 28, height: 28, flexShrink: 0 }}>
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            {/* Body (scroll) */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>
              {/* 背景・状況 */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>{t('composeBackground')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {(t('composeBackgroundTemplates') || []).map((tmpl) => (
                    <button key={tmpl.label}
                      onClick={() => setBackground(background === tmpl.text ? '' : tmpl.text)}
                      style={{
                        padding: '5px 13px', fontSize: 13, fontWeight: 500,
                        border: '1px solid var(--border-primary)', borderRadius: 20,
                        background: background === tmpl.text ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: background === tmpl.text ? '#fff' : 'var(--text-secondary)',
                        cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
                      }}>
                      {tmpl.label}
                    </button>
                  ))}
                </div>
                <textarea value={background} onChange={(e) => setBackground(e.target.value)} placeholder={t('composeBackgroundPlaceholder')} rows={4}
                  style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6, fontFamily: 'inherit', transition: 'border-color 0.15s' }}
                  onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')} onBlur={(e) => (e.target.style.borderColor = 'var(--border-primary)')} />
              </div>
              {/* 目的・ゴール */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>{t('composePurpose')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {(t('composePurposeTemplates') || []).map((tmpl) => (
                    <button key={tmpl.label}
                      onClick={() => setPurpose(purpose === tmpl.text ? '' : tmpl.text)}
                      style={{
                        padding: '5px 13px', fontSize: 13, fontWeight: 500,
                        border: '1px solid var(--border-primary)', borderRadius: 20,
                        background: purpose === tmpl.text ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: purpose === tmpl.text ? '#fff' : 'var(--text-secondary)',
                        cursor: 'pointer', transition: 'all 0.15s', whiteSpace: 'nowrap',
                      }}>
                      {tmpl.label}
                    </button>
                  ))}
                </div>
                <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={t('composePurposePlaceholder')} rows={4}
                  style={{ width: '100%', padding: '12px 14px', fontSize: 14, border: '1px solid var(--border-primary)', borderRadius: 'var(--radius)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6, fontFamily: 'inherit', transition: 'border-color 0.15s' }}
                  onFocus={(e) => (e.target.style.borderColor = 'var(--accent)')} onBlur={(e) => (e.target.style.borderColor = 'var(--border-primary)')} />
              </div>
              {isComposing && estimatedSecs > 0 && (
                <div style={{ height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 2, background: 'var(--accent)', width: `${Math.min(95, (elapsedSecs / estimatedSecs) * 100)}%`, transition: 'width 1s linear' }} />
                </div>
              )}
            </div>
            {/* Footer: 狭い画面では「文字数」と「ボタン群」の2ブロック単位で折り返す（ボタン同士はバラバラに折り返さない） */}
            <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '8px 10px', padding: '18px 28px', borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums', marginRight: 'auto' }}>{charCount.toLocaleString()} {t('characters')}</span>
              <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setComposeModalOpen(false)} disabled={isComposing}
                  style={{ padding: '10px 18px', fontSize: 14, fontWeight: 500, borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)', cursor: isComposing ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
                  {t('cancel')}
                </button>
                <button onClick={handleCompose} disabled={isComposing}
                  className={isComposing ? 'animate-shimmer' : ''}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 22px', fontSize: 14, fontWeight: 600, color: '#fff', background: isComposing ? undefined : 'var(--accent)', border: 'none', borderRadius: 'var(--radius)', cursor: isComposing ? 'wait' : 'pointer', transition: 'background 0.2s', whiteSpace: 'nowrap' }}
                  onMouseEnter={(e) => { if (!isComposing) e.currentTarget.style.background = 'var(--accent-hover)'; }}
                  onMouseLeave={(e) => { if (!isComposing) e.currentTarget.style.background = 'var(--accent)'; }}>
                  {isComposing
                    ? (<><Loader2 style={{ width: 16, height: 16 }} className="animate-spin-slow" />{t('composing')}
                        <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.min(99, Math.round((elapsedSecs / Math.max(1, estimatedSecs)) * 100))}%</span></>)
                    : (<><Feather style={{ width: 16, height: 16 }} />{t('composeButton')}</>)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Rewrite / Compose 結果ダイアログ（共用） ─────────────── */}
      {activeResult && (
        <div className="modal-backdrop">
          <div
            style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border-primary)',
              boxShadow: 'var(--shadow-lg)',
              animation: 'fadeInUp 0.25s ease-out',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              ...(isModalMaximized
                ? { position: 'fixed', inset: 0, borderRadius: 0, width: '100vw', height: '100vh', resize: 'none' }
                : { borderRadius: 'var(--radius-lg)', width: 820, maxWidth: 'calc(100vw - 24px)', height: 'min(88vh, 720px)', minWidth: 480, minHeight: 300, resize: 'both' }
              ),
            }}>
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
              <h3 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                {activeKind === 'compose'
                  ? <Feather style={{ width: 18, height: 18, color: 'var(--accent)' }} />
                  : <Wand2 style={{ width: 18, height: 18, color: 'var(--cat-ai-writing)' }} />}
                {activeKind === 'compose' ? t('composeDialogTitle') : t('rewriteDialogTitle')}
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <TtsSettings tts={tts} />
                <button onClick={() => setIsModalMaximized((v) => !v)}
                  className="toolbar-btn" title={isModalMaximized ? '元のサイズ' : '最大化'} style={{ width: 28, height: 28 }}>
                  {isModalMaximized ? <Minimize2 style={{ width: 15, height: 15 }} /> : <Maximize2 style={{ width: 15, height: 15 }} />}
                </button>
                <button onClick={closeResult} className="toolbar-btn" title="閉じる" style={{ width: 28, height: 28 }}>
                  <X style={{ width: 16, height: 16 }} />
                </button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', overflow: 'hidden' }}>
              {[
                { id: 'before', label: activeKind === 'compose' ? t('composeBefore') : t('rewriteBefore'), text: activeResult.original, accent: 'var(--cat-spelling)' },
                { id: 'after', label: activeKind === 'compose' ? t('composeAfter') : t('rewriteAfter'), text: activeResult.rewritten, accent: activeKind === 'compose' ? 'var(--accent)' : 'var(--cat-ai-writing)' },
              ].map(({ id, label, text, accent }, i) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', borderRight: i === 0 ? '1px solid var(--border-subtle)' : 'none', minHeight: 0 }}>
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 10px 5px 20px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: accent, borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-toolbar)' }}>
                    <span>{label}</span>
                    <button onClick={() => tts.toggle(text, id)} className="toolbar-btn"
                      title={tts.speakingId === id ? t('ttsStop') : t('ttsReadAloud')}
                      style={{ width: 26, height: 26, color: accent }}>
                      {tts.speakingId === id
                        ? (tts.loading ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin-slow" /> : <Square style={{ width: 13, height: 13, fill: 'currentColor' }} />)
                        : <Volume2 style={{ width: 15, height: 15 }} />}
                    </button>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px', fontSize: 13, lineHeight: 1.75, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', fontFamily: getFontStack(fontFamily) }}>
                    {text}
                  </div>
                </div>
              ))}
            </div>
            {activeResult.report && <ResultReport report={activeResult.report} />}
            <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 24px', borderTop: '1px solid var(--border-subtle)' }}>
              {/* 検出が残っているときだけ出す。辞書のaskに沿って直させ、結果を再検査に通す */}
              {activeResult.report?.cliche?.violations?.length > 0 && (
                <button onClick={handleRefine} disabled={isRefining}
                  title={t('refineHint')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginRight: 'auto',
                    padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius)',
                    border: `1px solid ${SEV_COLOR.error}`, background: 'transparent', color: SEV_COLOR.error,
                    cursor: isRefining ? 'default' : 'pointer', opacity: isRefining ? 0.6 : 1,
                  }}>
                  {isRefining && <Loader2 style={{ width: 14, height: 14 }} className="animate-spin-slow" />}
                  {isRefining ? t('refining') : t('refineButton')}
                </button>
              )}
              <button onClick={closeResult}
                style={{ padding: '8px 18px', fontSize: 13, fontWeight: 500, borderRadius: 'var(--radius)', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                {t('cancel')}
              </button>
              <button onClick={applyResult}
                style={{ padding: '8px 20px', fontSize: 13, fontWeight: 600, borderRadius: 'var(--radius)', border: 'none', background: activeKind === 'compose' ? 'var(--accent)' : 'var(--cat-ai-writing)', color: '#fff', cursor: 'pointer', transition: 'opacity 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}>
                {activeKind === 'compose' ? t('applyCompose') : t('applyRewrite')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

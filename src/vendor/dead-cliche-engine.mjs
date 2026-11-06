// 上流(https://boxpistols.github.io/ux-writing-dead-cliche)の複製。直接編集しない。
// 更新はnpm run sync:cliche。辞書の変更要望はux-writing-dead-cliche側のissueへ。
// 検出エンジン。辞書 (rules/*.yml) を単一の情報源とし、
// CLI・textlint・Claudeプラグインのすべてがここを通る。

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRule(rule) {
  if (rule.manual) return [];
  const flags = 'g' + (rule.flags ?? 'mu');
  const regexps = [];
  if (rule.pattern) regexps.push(new RegExp(rule.pattern, flags));
  if (rule.surface) for (const s of rule.surface) regexps.push(new RegExp(escapeRegExp(s), flags));
  if (regexps.length === 0) throw new Error(`rule ${rule.id}: patternもsurfaceもない`);
  return regexps;
}

function lineCol(text, index) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: index - last };
}

// Markdownのコードフェンスとインラインコードを、オフセットを保ったまま空白化する。
// コード例に含まれる語を誤検出しないための前処理。
export function maskMarkdownCode(text) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, (m) => '\u220E'.repeat(m.length)); // 非空白: 空白依存ルール(崩れ太字等)と干渉させない
}

// 書き換えられない箇所 (引用・辞書の除外仕様の説明など) で検出を止めるコメント指示。
// 書式は textlint に寄せる。利用者が既に知っている形にするため。
//   <!-- dead-cliche-disable -->            以降すべてのルールを止める
//   <!-- dead-cliche-disable rule/id, ... --> 指定したルールだけ止める
//   <!-- dead-cliche-enable -->             止めていたものを再開する (id 指定も可)
//   <!-- dead-cliche-disable-next-line ... --> 次の1行だけ止める
const DIRECTIVE_RE = /<!--\s*dead-cliche-(disable-next-line|disable|enable)\b([^]*?)-->/g;

function parseRuleIds(rest) {
  const ids = String(rest).split(/[\s,]+/).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null; // null は「すべてのルール」
}

function lineRangeAfter(text, index) {
  const eol = text.indexOf('\n', index);
  if (eol === -1) return null; // 指示のあとに行が無い
  const nextEol = text.indexOf('\n', eol + 1);
  return { start: eol + 1, end: nextEol === -1 ? text.length : nextEol + 1 };
}

// コメント指示から、検出を無効にする範囲を組み立てる。
export function disabledRanges(text) {
  const ranges = [];
  const open = []; // { ruleIds, start }
  DIRECTIVE_RE.lastIndex = 0;
  let m;
  while ((m = DIRECTIVE_RE.exec(text)) !== null) {
    const [full, kind, rest] = m;
    const ruleIds = parseRuleIds(rest);
    if (kind === 'disable-next-line') {
      const line = lineRangeAfter(text, m.index + full.length);
      if (line) ranges.push({ ...line, ruleIds });
      continue;
    }
    if (kind === 'disable') {
      open.push({ ruleIds, start: m.index });
      continue;
    }
    // enable: 指定が無ければ開いているものをすべて閉じる。
    // id 指定は、その id で止めた範囲だけを閉じる。id を書かずに止めた範囲 (すべての
    // ルールが対象) は、id 付きの enable では閉じない。書き手が守った範囲を、
    // 別のルールを再開しただけで丸ごと外さないため。
    const end = m.index + full.length;
    for (let i = open.length - 1; i >= 0; i--) {
      const o = open[i];
      if (!ruleIds) {
        ranges.push({ start: o.start, end, ruleIds: o.ruleIds });
        open.splice(i, 1);
        continue;
      }
      if (o.ruleIds === null) continue;
      const closing = [...o.ruleIds].filter((id) => ruleIds.has(id));
      if (closing.length === 0) continue;
      ranges.push({ start: o.start, end, ruleIds: new Set(closing) });
      for (const id of closing) o.ruleIds.delete(id);
      if (o.ruleIds.size === 0) open.splice(i, 1);
    }
  }
  for (const o of open) ranges.push({ start: o.start, end: text.length, ruleIds: o.ruleIds });
  return ranges;
}

function isDisabled(ranges, index, ruleId) {
  return ranges.some(
    (r) => index >= r.start && index < r.end && (r.ruleIds === null || r.ruleIds.has(ruleId))
  );
}

const SEVERITY_ORDER = { info: 0, warn: 1, error: 2 };

// fixテンプレート ($1等) を、検出時のマッチ結果から展開する。
// 部分文字列への再マッチは先読みの文脈を失うため、必ず検出時のmatchを使う。
function expandFix(template, m) {
  return template.replace(/\$(\d+)/g, (_, d) => m[Number(d)] ?? '');
}

export function check(text, rules, { minSeverity = 'info' } = {}) {
  const min = SEVERITY_ORDER[minSeverity] ?? 0;
  const ranges = disabledRanges(text);
  const found = [];
  for (const rule of rules) {
    if ((SEVERITY_ORDER[rule.severity] ?? 0) < min) continue;
    for (const re of compileRule(rule)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        if (isDisabled(ranges, m.index, rule.id)) continue;
        const violation = {
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          matched: m[0],
          index: m.index,
          length: m[0].length,
          ...lineCol(text, m.index),
          why: rule.why,
          ask: rule.ask,
        };
        if (rule.fix !== undefined) violation.fix = expandFix(rule.fix, m);
        found.push(violation);
      }
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// fixフィールドを持つルールの決定論的置換を適用する。
// maskedText (コード除外済み) で位置を決め、置換は原文に対して行う。
export function applyFixes(text, rules, { maskedText = text } = {}) {
  const edits = [];
  const ranges = disabledRanges(maskedText);
  for (const rule of rules) {
    if (rule.manual || rule.fix === undefined) continue;
    for (const re of compileRule(rule)) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(maskedText)) !== null) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        if (isDisabled(ranges, m.index, rule.id)) continue;
        const original = text.slice(m.index, m.index + m[0].length);
        const replacement = expandFix(rule.fix, m);
        edits.push({ ruleId: rule.id, index: m.index, length: m[0].length, before: original, after: replacement });
      }
    }
  }
  edits.sort((a, b) => b.index - a.index);
  let out = text;
  const applied = [];
  let lastStart = Infinity;
  for (const e of edits) {
    if (e.index + e.length > lastStart) continue; // 重複範囲は先勝ち
    out = out.slice(0, e.index) + e.after + out.slice(e.index + e.length);
    lastStart = e.index;
    applied.push(e);
  }
  return { text: out, applied: applied.reverse() };
}

export function hasErrors(violations) {
  return violations.some((v) => v.severity === 'error');
}

// 生成物 (docs/app-data.json) からプリセットのルール列を組み立てる。
// プリセットは severity を上書きすることがあり、その適用をここに閉じ込める。
// 利用側が ID を引くだけの素朴な実装を書くと、上書きが落ちて paper と business の
// 判定が同一になる (実際に起きた)。JSONを読む経路は必ずこの関数を通す。
export function rulesForPresetData(data, presetName, { includeManual = false } = {}) {
  const ids = new Set(data?.presets?.[presetName] ?? []);
  const overrides = data?.presetInfo?.[presetName]?.severity ?? {};
  return (data?.rules ?? [])
    .filter((r) => ids.has(r.id) && (includeManual || !r.manual))
    .map((r) => (overrides[r.id] ? { ...r, severity: overrides[r.id] } : r));
}

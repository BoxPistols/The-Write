// 入力中の違和感を1つの数字と、見直す文の一覧で出す。
//
// 数字を出す以上、その数字がどこまでの範囲を見たものかを必ず添える。
// 「自然さ92」だけを見せると、判定の済んでいない文まで良いと読まれる。
// 辞書の検査で検査範囲を必ず添えているのと同じ理由。

import React from 'react';
import { Loader2, AlertCircle, Zap } from 'lucide-react';
import { t } from '../locales';

const fmt = (key, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), t(key));

const SEV_COLOR = { error: 'var(--cat-grammar)', warn: 'var(--cat-style)', info: 'var(--text-muted)' };
const KIND_COLOR = {
  grammar: 'var(--cat-grammar)',
  spelling: 'var(--cat-spelling)',
  punctuation: 'var(--cat-punctuation)',
  style: 'var(--cat-style)',
  clarity: 'var(--cat-clarity)',
  'ai-writing': 'var(--cat-ai-writing)',
  none: 'var(--text-muted)',
};

// 自然さの帯。緑=自然、黄=気になる、赤=読み直しが要る。
const scoreColor = (n) => (n >= 85 ? 'var(--accept)' : n >= 65 ? 'var(--cat-grammar)' : 'var(--cat-spelling)');

const Chip = ({ color, children }) => (
  <span style={{
    fontSize: 11, lineHeight: 1.6, padding: '1px 6px', borderRadius: 4,
    color, border: `1px solid ${color}`, whiteSpace: 'nowrap',
  }}>{children}</span>
);

function StatusLine({ status, summary, stats, error }) {
  if (status === 'error') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--cat-spelling)' }}>
        <AlertCircle style={{ width: 12, height: 12 }} />
        {fmt('jevError', { error })}
      </span>
    );
  }
  if (status === 'judging') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
        {t('jevJudging')}
      </span>
    );
  }
  if (status === 'idle') return <span>{t('jevIdle')}</span>;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>{fmt('jevReady', { judged: summary.judged, total: summary.total })}</span>
      {stats.ttffMs != null && (
        // 速さは体感の根拠なので画面に出す。ベンチと同じ値を見ていることになる。
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-faint)' }}>
          <Zap style={{ width: 11, height: 11 }} />
          {t('jevFirstFlag')} {stats.ttffMs}ms
          {stats.cacheHits > 0 && ` / ${t('jevReused')} ${stats.cacheHits}`}
        </span>
      )}
    </span>
  );
}

/**
 * @param {{
 *  available: boolean,
 *  status: 'idle'|'judging'|'ready'|'error',
 *  summary: object, stats: object, error: string|null,
 *  units: Array, verdicts: Map,
 *  onSelect?: (unit: object) => void,
 * }} props
 */
export default function JevMeter({ available, status, summary, stats, error, units, verdicts, onSelect }) {
  if (!available) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
        {t('jevOff')}
      </div>
    );
  }

  const score = summary.naturalness;
  const flagged = units
    .map((u) => ({ unit: u, verdict: verdicts.get(u.key) }))
    .filter((x) => x.verdict?.flagged)
    .slice(0, 6);

  return (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('jevTitle')}</span>
        <span style={{
          fontSize: 22, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1,
          color: score == null ? 'var(--text-faint)' : scoreColor(score),
        }}>{score == null ? '—' : score}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>/ 100</span>

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {summary.counts.error > 0 && <Chip color={SEV_COLOR.error}>{summary.counts.error}</Chip>}
          {summary.counts.warn > 0 && <Chip color={SEV_COLOR.warn}>{summary.counts.warn}</Chip>}
        </span>
      </div>

      {/* 帯は自然さの値、下の細い線は判定の済んだ割合。数字の根拠を同じ場所に置く。 */}
      <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden' }}>
        <div style={{
          width: `${score == null ? 0 : score}%`, height: '100%',
          background: score == null ? 'transparent' : scoreColor(score),
          transition: 'width 180ms ease-out',
        }} />
      </div>
      <div style={{ marginTop: 2, height: 2, borderRadius: 1, background: 'var(--bg-hover)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.round(summary.coverage * 100)}%`, height: '100%',
          background: 'var(--border-accent)', transition: 'width 180ms ease-out',
        }} title={`${t('jevCoverage')} ${Math.round(summary.coverage * 100)}%`} />
      </div>

      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
        <StatusLine status={status} summary={summary} stats={stats} error={error} />
      </div>

      {status === 'ready' && summary.judged > 0 && flagged.length === 0 && (
        // 0件を「問題なし」と読ませない。尋ねたことしか見ていない。
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {t('jevNoFlags')}
        </div>
      )}

      {flagged.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('jevFlagged')} ({summary.flagged})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {flagged.map(({ unit, verdict }) => (
              <button
                key={unit.key + unit.index}
                onClick={() => onSelect?.(unit)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%',
                  textAlign: 'left', background: 'transparent', border: 'none', padding: '3px 0',
                  cursor: onSelect ? 'pointer' : 'default', color: 'var(--text-secondary)', fontSize: 12,
                }}
              >
                <span style={{
                  flexShrink: 0, width: 3, alignSelf: 'stretch', borderRadius: 2,
                  background: SEV_COLOR[verdict.severity],
                }} />
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  borderBottom: `1px dashed ${SEV_COLOR[verdict.severity]}`,
                }}>{unit.text}</span>
                <Chip color={KIND_COLOR[verdict.kind] || 'var(--text-muted)'}>{verdict.kind}</Chip>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

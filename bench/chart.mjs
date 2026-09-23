// 1枚だけ図にする。図にするのは「1文直したあと、スコアが更新されるまでの時間」で、
// これがJevを挟む理由そのものだから。残りは表で足りる。
//
// 色はdataviz既定のカテゴリ1と2(青/橙)。明暗どちらの面でも、
// 色覚多様性の分離・通常視の分離・面とのコントラストを満たすことを検証済み。
// 系列が2つなので凡例を必ず出し、値も棒の端に直接書く。色だけで識別させない。

const LIGHT = { s1: '#2a78d6', s2: '#eb6834' };
const DARK = { s1: '#3987e5', s2: '#d95926' };

/** 棒の先だけを丸める。根元は基線に付けたままにする。 */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.max(0, Math.min(r, w));
  if (w <= 0) return '';
  return `M${x},${y} H${x + w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} V${y + h - rr} a${rr},${rr} 0 0 1 ${-rr},${rr} H${x} Z`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{title: string, subtitle: string, series: [string, string],
 *          rows: Array<{label: string, a: number, b: number}>}} spec
 */
export function updateLatencyChart({ title, subtitle, series, rows }) {
  const W = 760;
  const PAD_L = 144;
  const PAD_R = 78;
  const TOP = 92;
  const BAR = 18;
  const GAP = 2;      // 隣り合う棒のあいだは面の色で2px空ける
  const GROUP = 30;
  const plotW = W - PAD_L - PAD_R;
  const H = TOP + rows.length * (BAR * 2 + GAP + GROUP) + 34;

  const max = Math.max(...rows.flatMap((r) => [r.a, r.b]), 1);
  // 目盛りは切りのよい値まで伸ばす
  const step = 10 ** Math.floor(Math.log10(max));
  const niceMax = Math.ceil(max / step) * step;
  const x = (v) => (v / niceMax) * plotW;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

  let body = '';

  // 目盛り。線は控えめに、数字は本文色で。
  ticks.forEach((tv) => {
    const px = PAD_L + x(tv);
    body += `<line x1="${px}" y1="${TOP - 10}" x2="${px}" y2="${H - 30}" class="grid" />`;
    body += `<text x="${px}" y="${H - 14}" class="tick" text-anchor="middle">${tv.toLocaleString()}</text>`;
  });

  rows.forEach((r, i) => {
    const top = TOP + i * (BAR * 2 + GAP + GROUP);
    body += `<text x="${PAD_L - 12}" y="${top + BAR + 1}" class="rowlabel" text-anchor="end">${esc(r.label)}</text>`;

    [['a', r.a, 's1'], ['b', r.b, 's2']].forEach(([, v, slot], k) => {
      const y = top + k * (BAR + GAP);
      const w = x(v);
      body += `<path d="${barPath(PAD_L, y, w, BAR)}" fill="var(--${slot})" />`;
      body += `<text x="${PAD_L + w + 8}" y="${y + BAR - 4}" class="value">${Math.round(v).toLocaleString()}</text>`;
    });
  });

  // 凡例。系列が2つあるので必ず出す。
  const legend = series.map((name, i) => {
    const cx = PAD_L + i * 210;
    return `<rect x="${cx}" y="60" width="10" height="10" rx="2" fill="var(--s${i + 1})" />`
      + `<text x="${cx + 16}" y="69" class="legend">${esc(name)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<style>
  svg { --s1: ${LIGHT.s1}; --s2: ${LIGHT.s2}; --ink: #0b0b0b; --ink2: #52514e; --ink3: #8a8a84; --line: #e6e6e1; --surface: #fcfcfb; }
  @media (prefers-color-scheme: dark) {
    svg { --s1: ${DARK.s1}; --s2: ${DARK.s2}; --ink: #ffffff; --ink2: #c3c2b7; --ink3: #8a8a84; --line: #2e2e2c; --surface: #1a1a19; }
  }
  .bg { fill: var(--surface); }
  .title { fill: var(--ink); font: 600 15px system-ui, sans-serif; }
  .subtitle { fill: var(--ink2); font: 400 12px system-ui, sans-serif; }
  .rowlabel { fill: var(--ink2); font: 400 12px system-ui, sans-serif; }
  .value { fill: var(--ink2); font: 500 11px ui-monospace, monospace; }
  .tick { fill: var(--ink3); font: 400 10px ui-monospace, monospace; }
  .legend { fill: var(--ink2); font: 400 12px system-ui, sans-serif; }
  .grid { stroke: var(--line); stroke-width: 1; }
</style>
<rect class="bg" x="0" y="0" width="${W}" height="${H}" />
<text class="title" x="24" y="30">${esc(title)}</text>
<text class="subtitle" x="24" y="48">${esc(subtitle)}</text>
${legend}
${body}
</svg>
`;
}

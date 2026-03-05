// OS判定とショートカットキー表示のユーティリティ

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isMac = /Mac|iPhone|iPad|iPod/.test(ua);

// モディファイアキー名（表示用）
export const modKey = isMac ? '⌘' : 'Ctrl';
export const shiftKey = isMac ? '⇧' : 'Shift';
export const altKey = isMac ? '⌥' : 'Alt';

// イベントでモディファイアが押されているか判定
export const isModKey = (e) => isMac ? e.metaKey : e.ctrlKey;

/**
 * ショートカットキーの表示文字列を生成
 * @param {string[]} parts - 例: ['mod', 'shift', 'z'] or ['mod', 'enter']
 * @returns {string} 例: "⌘⇧Z" (Mac) / "Ctrl+Shift+Z" (Win)
 */
export function formatShortcut(parts) {
  const mapped = parts.map((p) => {
    switch (p.toLowerCase()) {
      case 'mod': return modKey;
      case 'shift': return shiftKey;
      case 'alt': return altKey;
      default: return p.toUpperCase();
    }
  });
  return isMac ? mapped.join('') : mapped.join('+');
}

// ─── カスタマイズ可能なショートカット ─────────────────────

const SHORTCUTS_STORAGE_KEY = 'wa-shortcuts';

// デフォルトのショートカット定義
// parts: formatShortcut用の表示キー配列
// match: KeyboardEvent判定用 { key, shift }
export const DEFAULT_SHORTCUTS = {
  runAll:     { parts: ['mod', 'enter'],     match: { key: 'Enter', shift: false } },
  analyze:    { parts: ['mod', 'shift', 'e'], match: { key: 'e', shift: true } },
  rewrite:    { parts: ['mod', 'shift', 'j'], match: { key: 'j', shift: true } },
  undo:       { parts: ['mod', 'z'],          match: { key: 'z', shift: false } },
  redo:       { parts: ['mod', 'shift', 'z'], match: { key: 'z', shift: true } },
};

// localStorageから保存済みショートカットを読み込み
export function loadShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHORTCUTS_STORAGE_KEY) || '{}');
    // デフォルトとマージ（保存済みがあればそちらを優先）
    const merged = {};
    for (const [action, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      merged[action] = saved[action] || def;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

// ショートカットをlocalStorageに保存
export function saveShortcuts(shortcuts) {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {}
}

/**
 * KeyboardEventからショートカット定義を生成
 * @param {KeyboardEvent} e
 * @returns {{ parts: string[], match: { key: string, shift: boolean } } | null}
 */
export function shortcutFromEvent(e) {
  // モディファイアキー単体は無視
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null;
  // Modキー（Cmd/Ctrl）が押されていなければ無視
  if (!isModKey(e)) return null;

  const parts = ['mod'];
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  // キー名を正規化
  const keyName = e.key === ' ' ? 'space' : e.key.toLowerCase();
  parts.push(keyName === 'enter' ? 'enter' : keyName);

  return {
    parts,
    match: { key: e.key.length === 1 ? e.key.toLowerCase() : e.key, shift: e.shiftKey },
  };
}

/**
 * KeyboardEventがショートカット定義にマッチするか判定
 */
export function matchShortcut(e, shortcutDef) {
  if (!isModKey(e)) return false;
  const m = shortcutDef.match;
  const eventKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return eventKey === m.key && e.shiftKey === m.shift;
}

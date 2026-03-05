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

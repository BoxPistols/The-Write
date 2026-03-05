import { useRef, useCallback } from 'react';

const MAX_HISTORY = 30;

/**
 * エディタ内容のUndo/Redo管理
 * contentEditable の innerHTML スナップショットを保持
 */
export function useUndoRedo(editorRef, onRestore) {
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  // 現在の状態をスナップショットとして保存
  const snapshot = useCallback(() => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    const last = undoStack.current[undoStack.current.length - 1];
    if (last === html) return; // 変化なしなら保存しない
    undoStack.current.push(html);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = []; // 新しい操作が入ったらRedoスタッククリア
  }, [editorRef]);

  const undo = useCallback(() => {
    if (!editorRef.current || undoStack.current.length === 0) return false;
    // 現在の状態をRedoスタックに退避
    redoStack.current.push(editorRef.current.innerHTML);
    const prev = undoStack.current.pop();
    editorRef.current.innerHTML = prev;
    onRestore?.();
    return true;
  }, [editorRef, onRestore]);

  const redo = useCallback(() => {
    if (!editorRef.current || redoStack.current.length === 0) return false;
    // 現在の状態をUndoスタックに退避
    undoStack.current.push(editorRef.current.innerHTML);
    const next = redoStack.current.pop();
    editorRef.current.innerHTML = next;
    onRestore?.();
    return true;
  }, [editorRef, onRestore]);

  const canUndo = () => undoStack.current.length > 0;
  const canRedo = () => redoStack.current.length > 0;

  return { snapshot, undo, redo, canUndo, canRedo };
}

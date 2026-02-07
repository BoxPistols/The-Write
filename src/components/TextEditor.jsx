import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Sparkles, Check, X, Loader2, Sun, Moon, Copy, FileText,
  Bold, Italic, Underline, Link, AlignLeft, AlignCenter,
  AlignRight, List, ListOrdered, Outdent, Indent,
  Type, Highlighter, MoveVertical, MoveHorizontal, RotateCcw, Feather, ChevronDown, Settings, Key, Eye, EyeOff,
} from 'lucide-react';
import { t, locale } from '../locales';
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, PROVIDERS, getModel } from '../config/models';
import { SAMPLES } from '../config/samples';

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
const CATEGORIES = ['all', 'grammar', 'spelling', 'punctuation', 'style', 'clarity'];

const CAT_STYLES = {
  grammar: { color: 'var(--cat-grammar)', bg: 'var(--cat-grammar-bg)' },
  spelling: { color: 'var(--cat-spelling)', bg: 'var(--cat-spelling-bg)' },
  punctuation: { color: 'var(--cat-punctuation)', bg: 'var(--cat-punctuation-bg)' },
  style: { color: 'var(--cat-style)', bg: 'var(--cat-style-bg)' },
  clarity: { color: 'var(--cat-clarity)', bg: 'var(--cat-clarity-bg)' },
};

const analyzeViaProxy = async (model, text, clientKeys) => {
  const userPrompt = `You are a professional writing assistant. Analyze the following text and provide suggestions for improvement.

For each suggestion, provide a JSON array where each item has:
- "type": one of "grammar", "spelling", "punctuation", "style", "clarity"
- "original": the exact text that should be changed
- "suggestion": the improved text
- "explanation": brief explanation of the change (in ${locale.startsWith('ja') ? 'Japanese' : 'English'})

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
    }),
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
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

  const [suggestions, setSuggestions] = useState([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [charCount, setCharCount] = useState(0);
  const [openDropdown, setOpenDropdown] = useState(null);
  const [copied, setCopied] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return localStorage.getItem('wa-model') || DEFAULT_MODEL_ID; } catch { return DEFAULT_MODEL_ID; }
  });
  const [availableProviders, setAvailableProviders] = useState({});
  // Client-side API keys (stored in localStorage, sent with requests as fallback)
  const [clientKeys, setClientKeys] = useState(() => {
    try { return JSON.parse(localStorage.getItem('wa-keys') || '{}'); } catch { return {}; }
  });
  const [keyVisibility, setKeyVisibility] = useState({});
  const [lastUsage, setLastUsage] = useState(null);
  const editorRef = useRef(null);
  const savedSelectionRef = useRef(null);

  const refreshProviders = useCallback(() => {
    fetch('/api/providers').then((r) => r.json()).then(setAvailableProviders).catch(() => {});
  }, []);

  useEffect(() => { refreshProviders(); }, [refreshProviders]);

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
    const handleInput = () => {
      if (editorRef.current) setCharCount(editorRef.current.innerText.trim().length);
    };
    const editor = editorRef.current;
    if (editor) {
      editor.addEventListener('input', handleInput);
      return () => editor.removeEventListener('input', handleInput);
    }
  }, []);

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

  // Check if provider is available (server env OR client key)
  const isProviderAvailable = (provider) => {
    return !!availableProviders[provider] || !!clientKeys[provider];
  };

  const handleAnalyze = async () => {
    const text = editorRef.current?.innerText?.trim();
    if (!text) { alert(t('pleaseEnterText')); return; }

    setIsAnalyzing(true);
    setSuggestions([]);
    setLastUsage(null);

    try {
      const data = await analyzeViaProxy(selectedModel, text, clientKeys);
      if (data.usage) setLastUsage({ ...data.usage, model: selectedModel });
      const content = data.content?.[0]?.text || '';
      try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          setSuggestions(parsed.map((s, i) => ({ ...s, id: i, status: 'pending' })));
        } else { alert(t('failedToParse')); }
      } catch { alert(t('failedToParse')); }
    } catch { alert(t('failedToAnalyze')); }
    finally { setIsAnalyzing(false); }
  };

  const applySuggestion = useCallback((suggestion) => {
    if (!editorRef.current) return;
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
    setSuggestions((prev) => prev.map((s) => (s.id === suggestion.id ? { ...s, status: 'accepted' } : s)));
  }, []);

  const dismissSuggestion = useCallback((suggestion) => {
    setSuggestions((prev) => prev.map((s) => (s.id === suggestion.id ? { ...s, status: 'rejected' } : s)));
  }, []);

  const filteredSuggestions = activeCategory === 'all' ? suggestions : suggestions.filter((s) => s.type === activeCategory);
  const pendingFiltered = filteredSuggestions.filter((s) => s.status === 'pending');
  const applyAllSuggestions = () => { pendingFiltered.forEach((s) => applySuggestion(s)); };

  const loadSample = (text) => {
    if (editorRef.current) {
      editorRef.current.innerText = text;
      setCharCount(text.trim().length);
      setSuggestions([]);
      setOpenDropdown(null);
    }
  };

  const currentModel = getModel(selectedModel) || AVAILABLE_MODELS[0];
  const groupedModels = Object.keys(PROVIDERS).map((pKey) => ({
    provider: pKey,
    label: PROVIDERS[pKey].name,
    available: isProviderAvailable(pKey),
    models: AVAILABLE_MODELS.filter((m) => m.provider === pKey),
  }));

  const closeDropdown = useCallback(() => setOpenDropdown(null), []);

  return (
    <div className="grain" style={{ minHeight: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)', transition: 'background 0.3s, color 0.3s' }}>

      {/* ─── Header ─────────────────────────────── */}
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Feather style={{ width: 20, height: 20, color: 'var(--accent)', flexShrink: 0 }} />
          <h1 className="app-title">
            <span className="title-full">{t('appTitle')}</span>
            <span className="title-short">{t('appTitleShort')}</span>
          </h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: isProviderAvailable(currentModel.provider) ? 'var(--accept)' : 'var(--cat-spelling)', flexShrink: 0 }} />
                <span style={{ fontWeight: 600 }}>{currentModel.name}</span>
                <ChevronDown style={{ width: 12, height: 12, opacity: 0.4 }} />
              </button>
            }
          >
            <div style={{ width: 360, maxHeight: 420, overflow: 'auto', padding: '6px 0' }}>
              {groupedModels.map((group) => (
                <div key={group.provider} style={{ marginBottom: 4 }}>
                  {/* Provider header */}
                  <div style={{
                    padding: '8px 14px 4px',
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
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
                          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>{m.description}</div>
                        </div>

                        {/* Speed dots */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <Dots count={m.speed} color="var(--cat-grammar)" />
                          <span style={{ fontSize: 8, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('speed')}</span>
                        </div>

                        {/* Quality dots */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                          <Dots count={m.quality} color="var(--cat-clarity)" />
                          <span style={{ fontSize: 8, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('quality')}</span>
                        </div>

                        {/* Price */}
                        <div style={{ fontSize: 10, color: m.inputPrice === 0 ? 'var(--accept)' : 'var(--text-muted)', fontWeight: 500, textAlign: 'right', minWidth: 36 }}>
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
                    padding: '6px 8px', fontSize: 11, color: 'var(--text-muted)',
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
        </div>
      </header>

      <div className="main-layout">

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
          <div className="editor-area" style={{ flex: 1, overflow: 'auto', padding: 24 }}>
            <div style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
              height: '100%', display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{t('yourText')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{charCount.toLocaleString()} {t('characters')}</span>
                  {/* Sample Text */}
                  <Dropdown open={openDropdown === 'sample'} onClose={closeDropdown} align="right" trigger={
                    <button onClick={() => setOpenDropdown(openDropdown === 'sample' ? null : 'sample')} title={t('sampleTexts')}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 11,
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
                  <button onClick={handleCopy} className="toolbar-btn" title={t('copy')} style={{ width: 28, height: 28 }}>
                    {copied ? <Check style={{ width: 14, height: 14, color: 'var(--accept)' }} /> : <Copy style={{ width: 14, height: 14 }} />}
                  </button>
                </div>
              </div>
              <div ref={editorRef} contentEditable data-placeholder={t('pleaseEnterText')} suppressContentEditableWarning
                style={{ flex: 1, padding: '24px 28px', fontFamily: getFontStack(fontFamily), fontSize, lineHeight: lineSpacing, letterSpacing, color: 'var(--text-primary)', minHeight: 200, outline: 'none', overflow: 'auto' }} />
            </div>
          </div>

          {/* Analyze Button */}
          <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-primary)' }}>
            <button onClick={handleAnalyze} disabled={isAnalyzing}
              className={isAnalyzing ? 'animate-shimmer' : 'animate-pulse-accent'}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '12px 20px', fontSize: 14, fontWeight: 600, letterSpacing: '0.01em',
                color: '#fff', background: isAnalyzing ? undefined : 'var(--accent)',
                border: 'none', borderRadius: 'var(--radius)', cursor: isAnalyzing ? 'wait' : 'pointer', transition: 'background 0.2s, transform 0.1s' }}
              onMouseEnter={(e) => { if (!isAnalyzing) e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={(e) => { if (!isAnalyzing) e.currentTarget.style.background = 'var(--accent)'; }}
              onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.99)'; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}>
              {isAnalyzing ? (<><Loader2 style={{ width: 16, height: 16 }} className="animate-spin-slow" />{t('analyzing')}</>)
                : (<><Sparkles style={{ width: 16, height: 16 }} />{t('analyzeText')}</>)}
            </button>
          </div>
        </div>

        {/* ─── Suggestions Panel ─────────────────── */}
        <div className="suggestions-panel">
          <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border-primary)' }}>
            <h2 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>
              {t('suggestions')}
              {suggestions.length > 0 && (
                <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-muted)', fontFamily: getFontStack('Source Sans 3'), marginLeft: 8 }}>
                  {suggestions.filter((s) => s.status === 'pending').length}/{suggestions.length}
                </span>
              )}
            </h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CATEGORIES.map((cat) => {
                const count = cat === 'all' ? suggestions.length : suggestions.filter((s) => s.type === cat).length;
                return (<button key={cat} onClick={() => setActiveCategory(cat)} className={`cat-pill ${activeCategory === cat ? 'active' : ''}`}>
                  {t(cat)}{cat !== 'all' && <span style={{ opacity: 0.7, marginLeft: 3 }}>({count})</span>}
                </button>);
              })}
            </div>
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
                        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 8px', borderRadius: 100, background: catStyle.bg, color: catStyle.color }}>{t(s.type)}</span>
                        {isDone && <span style={{ fontSize: 11, fontWeight: 500, color: s.status === 'accepted' ? 'var(--accept)' : 'var(--text-muted)', fontStyle: 'italic' }}>{s.status === 'accepted' ? t('accept') : t('reject')}</span>}
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
              <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 10, color: 'var(--text-faint)', display: 'flex', justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' }}>
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
          <div className="modal-panel" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
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
                    <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--accept)', fontStyle: 'italic' }}>
                      ({locale.startsWith('ja') ? 'サーバー設定済み' : 'server configured'})
                    </span>
                  )}
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type={keyVisibility[key] ? 'text' : 'password'}
                      value={clientKeys[key] || ''}
                      onChange={(e) => setClientKeys((prev) => ({ ...prev, [key]: e.target.value || undefined }))}
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
                </div>
              </div>
            ))}

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
    </div>
  );
}

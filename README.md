# Draftline ✍️

AI搭載のリッチテキストエディタ。文法・スペル・句読点・文体・明瞭さを自動分析し、改善提案をリアルタイムで表示します。

## 機能

- 📝 リッチテキストエディタ（フォント、サイズ、色、配置、リスト等）
- 🤖 OpenAI / Google Gemini APIによるテキスト分析
- ⚡ Jev (TypeSafe AI) による文単位の違和感判定（[docs/jev.md](docs/jev.md)）
- 🎯 カテゴリ別の改善提案（文法/スペル/句読点/文体/明瞭さ）
- 🌙 ダーク/ライトモード
- 🌐 日本語・英語対応（ブラウザ言語自動検出）
- 📋 ハイライト除去済みコピー

## セットアップ

```bash
npm install
cp .env.example .env
# OPENAI_API_KEY または GEMINI_API_KEY を設定
# 文単位の判定を使うなら TYPESAFE_API_KEY も設定する（任意）
npm run dev
```

## 技術スタック

- React 18 + Vite
- Tailwind CSS
- Express (API proxy)
- OpenAI API / Google Gemini API
- TypeSafe AI (Jev) — 型付き判定
- Lucide React Icons

## テスト

```bash
npm test
```

## ベンチマーク

Jevを挟む前と後を、同じ文書・同じプロンプトで実測する。詳しくは [bench/README.md](bench/README.md)。

```bash
TYPESAFE_API_KEY=... OPENAI_API_KEY=... npm run bench
npm run bench:report   # → docs/jev-benchmark.md
```

## License

MIT

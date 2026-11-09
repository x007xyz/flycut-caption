#!/usr/bin/env bash
# 字幕字体：页面和 Host 读同一份完整字体文件（OFL）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DEST="$ROOT/public/fonts/subtitle"
TAURI_DEST="$ROOT/src-tauri/shared_assets/subtitle-fonts"

mkdir -p "$WEB_DEST" "$TAURI_DEST"

echo "→ 下载 Noto Sans SC Regular / Bold (OTF)..."
curl -fsSL -o "$WEB_DEST/NotoSansSC-Regular.otf" \
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
curl -fsSL -o "$WEB_DEST/NotoSansSC-Bold.otf" \
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf"

echo "→ 下载 Inter Regular / Bold (TTF)..."
curl -fsSL -o "$WEB_DEST/Inter-Regular.ttf" \
  "https://cdn.jsdelivr.net/fontsource/fonts/inter@5.2.8/latin-400-normal.ttf"
curl -fsSL -o "$WEB_DEST/Inter-Bold.ttf" \
  "https://cdn.jsdelivr.net/fontsource/fonts/inter@5.2.8/latin-700-normal.ttf"

echo "→ 复制同一份文件给 Host..."
cp "$WEB_DEST/NotoSansSC-Regular.otf" "$WEB_DEST/NotoSansSC-Bold.otf" \
   "$WEB_DEST/Inter-Regular.ttf" "$WEB_DEST/Inter-Bold.ttf" "$TAURI_DEST/"

echo "✓ Web 字体: public/fonts/subtitle/"
echo "✓ Host 字体: src-tauri/shared_assets/subtitle-fonts/"

#!/bin/bash
set -e

echo "=== Building BUFF Monitor macOS DMG ==="

cd "$(dirname "$0")"

# 1. 确保生产依赖已安装
echo "[1/4] Installing production dependencies..."
if [ ! -d "node_modules_prod/node_modules/body-parser" ]; then
  cd node_modules_prod
  npm install --omit=dev
  cd ..
fi

# 2. 用 electron-builder 打包（不含 node_modules）
echo "[2/4] Running electron-builder..."
npx electron-builder --mac dmg

# 3. 替换 node_modules 为完整依赖
APP_PATH="dist/mac-arm64/BUFF Monitor.app/Contents/Resources/app"
echo "[3/4] Injecting full node_modules into app..."
rm -rf "$APP_PATH/node_modules"
cp -R node_modules_prod/node_modules "$APP_PATH/node_modules"

# 4. 复制 Electron 重编译的 better-sqlite3 native 模块
echo "[4/4] Copying rebuilt native modules..."
SQLITE_SRC=$(find ../../node_modules/.pnpm -name "better_sqlite3.node" -path "*/Release/*" | head -1)
if [ -n "$SQLITE_SRC" ]; then
  mkdir -p "$APP_PATH/node_modules/better-sqlite3/build/Release"
  cp "$SQLITE_SRC" "$APP_PATH/node_modules/better-sqlite3/build/Release/"
  echo "  Copied better-sqlite3 native binary"
fi

# 5. 重新生成 DMG
echo "=== Regenerating DMG... ==="
VERSION=$(node -p "require('./package.json').version")
DMG_PATH="dist/BUFF Monitor-${VERSION}-arm64.dmg"
rm -f "$DMG_PATH"
hdiutil create -volname "BUFF Monitor" -srcfolder "dist/mac-arm64/BUFF Monitor.app" -ov -format UDZO "$DMG_PATH"

echo ""
echo "=== Done! ==="
echo "DMG: $DMG_PATH"
ls -lh "$DMG_PATH"

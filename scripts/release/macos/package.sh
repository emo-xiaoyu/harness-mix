#!/usr/bin/env bash
# Builds the macOS drag-to-Install dmg for one architecture:
#   scripts/release/macos/package.sh [arm64|x64]
# The staged payload (see scripts/release/prepare-payload.cjs) is wrapped in a
# minimal LSUIElement .app whose executable execs the bundled Node runtime
# against the package launcher, then sealed with an ad-hoc codesign.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

ARCH_ARG="${1:-}"
MODE="${2:-}"
if [ "$MODE" != "" ] && [ "$MODE" != "--online" ]; then
  echo "不支持的选项：$MODE" >&2; exit 1
fi
SUFFIX=""
if [ "$MODE" = "--online" ]; then SUFFIX="-online-download-deps"; fi
case "$ARCH_ARG" in
  arm64|x64) ARCH="$ARCH_ARG" ;;
  "") ARCH="$(uname -m | sed 's/^x86_64$/x64/')" ;;
  *) echo "不支持的架构：$ARCH_ARG（可用 arm64 / x64）" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) HOST_ARCH="$(uname -m)" ;;
esac
if [ "$ARCH" != "$HOST_ARCH" ]; then
  echo "警告：目标架构 $ARCH 与宿主 $HOST_ARCH 不同，Rust 产物将不匹配；请在原生架构的机器上打包。" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
PAYLOAD="$ROOT/output/installer-payload/darwin-$ARCH${MODE:+-online}/payload"
STAGING="$ROOT/output/installer-staging/darwin-$ARCH${MODE:+-online}"
APP_NAME="Harness Mix.app"
if [ "$MODE" = "--online" ]; then APP_NAME="Harness Mix（联网下载依赖）.app"; fi
APP="$STAGING/$APP_NAME"
mkdir -p "$ROOT/output/installers"
rm -f "$ROOT/output/installers/harness-mix-$VERSION-macos-$ARCH$SUFFIX.dmg"

node scripts/release/prepare-payload.cjs --platform darwin --arch "$ARCH" ${MODE:+--online}

rm -rf "$STAGING"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "[Harness Mix] 组装 $APP_NAME"
ditto "$PAYLOAD" "$APP/Contents/Resources/app"

if [ "$MODE" = "--online" ]; then
cat > "$APP/Contents/MacOS/harness-mix" <<'LAUNCHER'
#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/../Resources/app"
exec "$APP/runtime/node" "$APP/scripts/release/online-bootstrap.cjs" --launch-macos "$APP" "$@"
LAUNCHER
else
cat > "$APP/Contents/MacOS/harness-mix" <<'LAUNCHER'
#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/../Resources/app/runtime/node" "$DIR/../Resources/app/scripts/launch-codex.cjs" "$@"
LAUNCHER
fi
chmod +x "$APP/Contents/MacOS/harness-mix"

ICONSET="$STAGING/harness-mix.iconset"
mkdir -p "$ICONSET"
for pair in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" "512:icon_256x256@2x" \
            "512:icon_512x512" "1024:icon_512x512@2x"; do
  size="${pair%%:*}"
  name="${pair#*:}"
  sips -z "$size" "$size" src/assets/brand-harness-mix.png --out "$ICONSET/$name.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/harness-mix.icns"
rm -rf "$ICONSET"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Harness Mix</string>
    <key>CFBundleDisplayName</key><string>Harness Mix${MODE:+（联网下载依赖）}</string>
    <key>CFBundleIdentifier</key><string>io.github.emo-xiaoyu.harness-mix${MODE:+.online}</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleExecutable</key><string>harness-mix</string>
    <key>CFBundleIconFile</key><string>harness-mix</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>LSMinimumSystemVersion</key><string>11.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist"

echo "[Harness Mix] ad-hoc codesign"
codesign --force --sign - "$APP/Contents/Resources/app/runtime/node"
codesign --force --sign - "$APP/Contents/Resources/app/output/native-build/harness-mix-shim"
codesign --force --sign - "$APP"
if ! codesign --verify --strict "$APP" 2>/dev/null; then
  echo "[Harness Mix] 提示：bundle 校验未通过（脚本入口 + ad-hoc 签名），不影响本机使用。"
fi

DMG="$ROOT/output/installers/harness-mix-$VERSION-macos-$ARCH$SUFFIX.dmg"
if command -v create-dmg >/dev/null 2>&1; then
  if ! create-dmg --volname "Harness Mix" --window-size 660 400 --icon-size 128 \
      --icon "$APP_NAME" 165 200 --app-drop-link 495 200 "$DMG" "$STAGING"; then
    echo "[Harness Mix] create-dmg 失败，回退 hdiutil"
    rm -f "$DMG"
    rm -f "$ROOT/output/installers"/rw.*."${DMG##*/}"
    hdiutil create -volname "Harness Mix" -srcfolder "$STAGING" -ov -format UDZO "$DMG"
  fi
else
  hdiutil create -volname "Harness Mix" -srcfolder "$STAGING" -ov -format UDZO "$DMG"
fi
hdiutil verify "$DMG" >/dev/null

SIZE="$(du -m "$DMG" | cut -f1)"
echo "[Harness Mix] macOS 安装器完成：$DMG (${SIZE} MB)"

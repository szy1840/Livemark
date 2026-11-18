#!/bin/bash
# Builds dist/Livemark.app from scratch: compile, Info.plist, web app, icon, ad-hoc signature.
#   native/build.sh            build
#   native/build.sh --test     build, then run the bundle's --selftest
set -euo pipefail

NATIVE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$NATIVE")"
APP="$ROOT/dist/Livemark.app"
CONTENTS="$APP/Contents"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/livemark-build.XXXXXX")"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# The build shares its bundle id with the installed app; unregister it so it can never become the default handler for Markdown files.
trap 'rm -rf "$WORK"; "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true' EXIT

ARCH="$(uname -m)"                       # arm64 or x86_64
TARGET="$ARCH-apple-macosx12.0"

echo "==> Cleaning $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/web"

echo "==> Compiling ($TARGET)"
swiftc -O -swift-version 5 -target "$TARGET" \
  -framework Cocoa -framework WebKit \
  "$NATIVE"/Sources/*.swift \
  -o "$CONTENTS/MacOS/Livemark"

echo "==> Info.plist"
cp "$NATIVE/Info.plist" "$CONTENTS/Info.plist"
printf 'APPL????' > "$CONTENTS/PkgInfo"
# Keep the bundle version in step with package.json when it has one.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" 2>/dev/null | head -n 1 || true)"
if [ -n "$VERSION" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS/Info.plist"
fi

echo "==> Copying the web app"
# Everything in the project root except build/dev artefacts; new top-level directories are picked up automatically.
/usr/bin/rsync -a --copy-unsafe-links \
  --exclude '/node_modules' --exclude '/native' --exclude '/dist' --exclude '/test' --exclude '/.git' --exclude '/demo-compare' --exclude '/scripts' --exclude '/package-lock.json' \
  --exclude '*.log' --exclude '.DS_Store' \
  "$ROOT/" "$CONTENTS/Resources/web/"
[ -f "$CONTENTS/Resources/web/index.html" ] || { echo "error: index.html not found in $ROOT" >&2; exit 1; }

echo "==> Icon"
swiftc -O -swift-version 5 "$NATIVE/Tools/make-icon.swift" -o "$WORK/make-icon"
"$WORK/make-icon" "$WORK/AppIcon.iconset"
/usr/bin/iconutil -c icns "$WORK/AppIcon.iconset" -o "$CONTENTS/Resources/AppIcon.icns"

echo "==> Signing (ad hoc)"
/usr/bin/xattr -cr "$APP"
/usr/bin/codesign --force --deep -s - "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"

echo "==> Built $APP"
if [ "${1:-}" = "--test" ]; then
  "$CONTENTS/MacOS/Livemark" --selftest
fi

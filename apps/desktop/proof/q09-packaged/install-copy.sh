#!/bin/bash
# 把 dmg 里的 g-group.app 装到一个新目录(不碰用户 /Applications 下的旧版),给 accept-t8.mjs 当 GG_ACCEPT_BIN 用。
# 用法: apps/desktop/proof/q09-packaged/install-copy.sh <g-group-*.dmg> <新的安装目录>
# 步骤: hdiutil 只读挂载(不弹 Finder、不进侧栏)→ ditto 拷出 g-group.app → 卸载;打印二进制路径与 app.asar sha256。
set -euo pipefail

die() { echo "install-copy: $*" >&2; exit 2; }
[[ $# -eq 2 ]] || die "用法: $0 <dmg> <新的安装目录>"
dmg=$1
dest=$2
[[ $dmg == /* && $dest == /* ]] || die "dmg 与安装目录都要绝对路径"
[[ -f $dmg ]] || die "没有这个 dmg: $dmg"
case "$dest" in
  /Applications|/Applications/*) die "不装进 /Applications(那里是用户自己的旧版)";;
esac
[[ ! -e $dest ]] || die "安装目录已存在,不覆盖: $dest"

mnt=$(mktemp -d /private/tmp/gg-dmg-mnt.XXXXXX)
attached=0
cleanup() {
  if [[ $attached -eq 1 ]]; then
    hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet || echo "install-copy: 卸载 $mnt 失败,请手动 hdiutil detach" >&2
  fi
  rmdir "$mnt" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
attached=1
src="$mnt/g-group.app"
[[ -d $src ]] || die "dmg 里没有 g-group.app(挂载点 $mnt)"

mkdir -p "$dest"
ditto "$src" "$dest/g-group.app"
hdiutil detach "$mnt" -quiet
attached=0

app="$dest/g-group.app"
bin="$app/Contents/MacOS/g-group"
asar="$app/Contents/Resources/app.asar"
[[ -x $bin ]] || die "装出的副本里没有可执行文件: $bin"
[[ -f $asar ]] || die "装出的副本里没有 app.asar: $asar"
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo unknown)
sign=$(codesign --verify --deep --strict "$app" 2>&1 && echo ok || true)

echo "DMG=$dmg"
echo "DMG_SHA256=$(shasum -a 256 "$dmg" | cut -d' ' -f1)"
echo "APP=$app"
echo "VERSION=$version"
echo "BIN=$bin"
echo "APP_ASAR_SHA256=$(shasum -a 256 "$asar" | cut -d' ' -f1)"
echo "CODESIGN_VERIFY=${sign:-failed}"

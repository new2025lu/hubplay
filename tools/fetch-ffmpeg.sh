#!/usr/bin/env bash
#
# 下载打包用的 Windows 版 ffmpeg。
#
# 用 BtbN 的 shared GPL 构建：必须 GPL 版才有 libx264（转码要用），
# shared 版比 static 版小一半多。ffplay.exe 用不到，装完删掉。
#
# 直连 GitHub releases 在国内常常拉不动，默认走 gh-proxy 中转，
# 失败再退回直连。
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="vendor-win"
BUILD="${FFMPEG_BUILD:-ffmpeg-master-latest-win64-gpl-shared}"

if [ -x "$DEST/$BUILD/bin/ffmpeg.exe" ] && [ -x "$DEST/$BUILD/bin/ffprobe.exe" ]; then
  echo "ffmpeg 已就绪: $DEST/$BUILD/bin"
  exit 0
fi

mkdir -p "$DEST"
URLS=(
  "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$BUILD.zip"
  "https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$BUILD.zip"
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$BUILD.zip"
)

ok=0
for u in "${URLS[@]}"; do
  echo "尝试: ${u:0:70}…"
  if curl -L --retry 2 --retry-delay 2 -C - -m 1800 -o "$DEST/ffmpeg-win.zip" "$u"; then
    if python3 -c "import zipfile,sys; sys.exit(0 if zipfile.ZipFile('$DEST/ffmpeg-win.zip').testzip() is None else 1)" 2>/dev/null; then
      ok=1; break
    fi
    echo "  包损坏，换下一个源"
  fi
done

[ "$ok" = 1 ] || { echo "下载失败：三个源都没成功"; exit 1; }

unzip -o -q "$DEST/ffmpeg-win.zip" -d "$DEST"
rm -f "$DEST/$BUILD/bin/ffplay.exe"   # 用不到，省 19MB
echo "完成:"
ls -la "$DEST/$BUILD/bin/"

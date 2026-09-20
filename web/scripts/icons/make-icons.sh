#!/usr/bin/env bash
# 图标生成器：从 web/public/icons/icon.svg 生成所有 PNG / ICO（产物写回那里）。
#
# 为什么要脚本：图标有很多档尺寸（标签页 16/32、iOS 主屏 180、PWA 192/512、Android maskable），
# 手搓每一档必然出现「改了 SVG 忘了重导某一档」，而标签页里的那档坏了最容易被忽略
# （谁天天盯着 favicon 看）。跑一次全出，尺寸与文件名见下面清单。
#
# 依赖（macOS + Homebrew，本机已装）：
#   rsvg-convert（librsvg）—— 渲染 SVG（ImageMagick 内置的 MSVG 渲染器对 <line stroke-linecap> 不靠谱）
#   magick（ImageMagick 7）—— 缩尺寸、拼 ICO、生 maskable 底色
#
# 用法：pnpm --filter @dinnerorder/web run icons   （或直接 bash web/scripts/icons/make-icons.sh）
set -euo pipefail

# 图标产物目录（脚本现在住在 web/scripts/icons/，与产物分开了：
# `public/` 下的东西会被 Vite 原样复制进构建产物，而这份脚本与说明是**给人看的**，
# 不该被当静态资源服务出去）
ICONS="$(cd "$(dirname "$0")/../../public/icons" && pwd)"
cd "$ICONS"
SVG=icon.svg

for bin in rsvg-convert magick; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "缺少 $bin。安装：brew install librsvg imagemagick" >&2
    exit 1
  }
done

# 先在 1024 渲染一次再降采样：直接从 512 缩到 16 会丢细节（筷子糊成一根）
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
rsvg-convert -w 1024 -h 1024 "$SVG" -o "$TMP/master.png"

# ---- 标签页 / PWA / iOS 的各档 PNG ----
# apple-touch-icon 要 180（iOS 主屏），用不透明底：iOS 不认透明，透明处会变黑
for size in 16 32 48 180 192 512; do
  magick "$TMP/master.png" -resize "${size}x${size}" -strip "icon-${size}.png"
done
# iOS 与 Android 主屏用的那两档强制铺白底（图标本体已有圆角底色，这里只是兜底不透明）
magick "$TMP/master.png" -resize 180x180 -background "#ffffff" -alpha remove -alpha off -strip "apple-touch-icon.png"

# ---- favicon.ico：多尺寸打包（16/32/48），浏览器按需取 ----
# 放在 **public 根**（不是 icons/）：浏览器在页面未声明 rel="icon" 时，只会去问 origin 的
# `/favicon.ico` 这一个固定路径。挂在根目录就让那条隐式请求也能拿到自己的图标
# （之前那条隐式请求落到宿主 nginx 根，显示的是**别的 app 的图标**）。
magick "$TMP/master.png" -define icon:auto-resize=48,32,16 -strip ../favicon.ico

# ---- maskable（Android 自适应图标）----
# maskable 图形必须落在中心 80% 的安全区内，否则被系统裁成圆形/方形时边缘会被切掉。
# 做法：把原图缩到 80% 再居中贴到满幅的强调色底上（底色就是图标自己的橙，接缝看不出来）。
for pair in "192 icon-maskable-192.png" "512 icon-maskable-512.png"; do
  set -- $pair
  magick "$TMP/master.png" -resize "$(($1 * 80 / 100))x$(($1 * 80 / 100))" \
    -background "#d9480f" -gravity center -extent "${1}x${1}" -strip "$2"
done

echo "已生成："
ls -1 icon-*.png apple-touch-icon.png 2>/dev/null | sed 's/^/  icons\//'
ls -1 ../favicon.ico | sed 's/^/  /'

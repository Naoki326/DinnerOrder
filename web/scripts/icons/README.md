# 图标（家餐桌）

> 这个脚本与说明住在 `web/scripts/icons/`（**不在** `web/public/` 下）：`public/` 里的东西会被
> Vite 原样复制进构建产物、当静态资源服务出去，而这两份文件是给人看的工具与文档，不是给浏览器要的。

## 真源只有一个

**`icon.svg` 是唯一真源**，所有 PNG / ICO 都由它生成。改设计只改 SVG，然后：

```bash
pnpm --filter @dinnerorder/web run icons      # 或 bash web/scripts/icons/make-icons.sh
```

依赖（macOS + Homebrew）：`rsvg-convert`（librsvg）+ `magick`（ImageMagick 7）。
**别用 ImageMagick 内置的 MSVG 渲染器**——它对 `<line stroke-linecap>` 这些渲染不准，
本仓库实测过：同一个 SVG 用 `rsvg-convert` 是圆头筷子，用 magick 直接读 SVG 会变形。

## 产出的每一档，各给谁用

| 文件 | 尺寸 | 谁要看它 |
| --- | --- | --- |
| `favicon.ico`（在 `web/public/` **根**，不是 icons/） | 48 / 32 / 16 打包 | 旧浏览器的页签；也是页面未声明时浏览器**隐式**会要的那个路径 |
| `icons/icon.svg` | 矢量 | 现代浏览器的页签（任意缩放都清晰） |
| `icons/icon-16.png` / `icon-32.png` | 16 / 32 | 页签的显式档（高分屏与普通屏各一份） |
| `icons/icon-48.png` | 48 | ico 的组成部分，也备用 |
| `icons/apple-touch-icon.png` | 180 | iOS 加到主屏（iOS 不认别的尺寸，也不认透明） |
| `icons/icon-180.png` | 180 | 备用（与上面同一尺寸的不同用途） |
| `icons/icon-192.png` / `icon-512.png` | 192 / 512 | PWA manifest 的 `purpose: any` |
| `icons/icon-maskable-192.png` / `-512.png` | 192 / 512 | Android 自适应图标（`purpose: maskable`） |

## 两个容易搞错的地方

**1. `favicon.ico` 必须在 `web/public/` 根目录，不能放 `icons/`。**
页面若没声明 `<link rel="icon">`，浏览器只会去问 origin 根的 `/favicon.ico` 这**一个**固定路径。
本 app 经宿主 nginx 挂在 8080 的子路径下时，那个地址属于 **pi-web**——标签页里会显示别人的图标。
放根目录 + `index.html` 里显式声明（两条都做了），这个坑才彻底堵死。

**2. maskable 要留安全区。**
Android 会把 maskable 图标裁成圆形/水滴/方形，图形超出中心 80% 的部分会被切掉。
生成脚本用 `-resize 80% + -gravity center -extent` 保证图形落在安全区内，底色就是图标自己的橙。

## 设计约束（改图标前先读）

图标要能在**浏览器标签页**里一眼认出来——16×16 是最苛刻的一档，设计因此受两条硬约束：

- 512 ÷ 16 = 32，所以 **1 个屏幕像素 = 32 个 SVG 单位**。笔画要 48 单位以上才在 16px 下站得住（约 1.5px），细节一概不要。
- **两根筷子要分得开**：实测过三个变体，管中心距小于 100 单位时它们在 16px 下会糊成一根。
  现在取中心距 116、笔宽 46（净空隙 70 单位 ≈ 2.2px）。
- **配色用 `--accent`（`#d9480f`）**：与邻居 pi-web 的深青 π 在色相上直接拉开（实测 32px 下差异 95% 的像素）。

改完务必自己看一眼 16px 的效果，别只看 512：

```bash
magick web/public/icons/icon-512.png -resize 16x16 -scale 160x160 /tmp/check.png
```

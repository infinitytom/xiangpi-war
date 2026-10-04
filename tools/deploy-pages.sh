#!/usr/bin/env bash
# 部署到 GitHub Pages，静态资源走 jsDelivr。
# 用法：tools/deploy-pages.sh <gh-pages 分支的工作目录>
# 先把资源单独提交拿到提交号，入口页再用「@提交号」引用，保证 CDN 不会给出旧文件。
set -euo pipefail
WT="$1"
REPO="infinitytom/xiangpi-war"
npm run build
rm -rf "$WT/assets"
cp -r dist/assets "$WT/assets"
cp dist/manifest.webmanifest "$WT/"
touch "$WT/.nojekyll"
git -C "$WT" add -A
git -C "$WT" commit -q -m "更新静态资源" ${TRAILER:+-m "$TRAILER"} || true
SHA=$(git -C "$WT" rev-parse HEAD)
git -C "$WT" push -q origin gh-pages
node tools/make-index.mjs "https://fastly.jsdelivr.net/gh/$REPO@$SHA/" dist/index.html "$WT/index.html"
git -C "$WT" add -A
git -C "$WT" commit -q -m "更新入口页（资源 @$SHA）" ${TRAILER:+-m "$TRAILER"}
git -C "$WT" push -q origin gh-pages
echo "已部署：https://infinitytom.github.io/xiangpi-war/"

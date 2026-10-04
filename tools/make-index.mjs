// 生成部署用的入口页：脚本和样式走 jsDelivr CDN（国内更快），30 秒没加载成功就回退到同站地址。
// 用法：node tools/make-index.mjs <CDN 前缀> <dist/index.html> <输出路径>
import fs from 'node:fs';
const [cdn, src, out] = process.argv.slice(2);
let html = fs.readFileSync(src, 'utf8');
const js = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
const css = html.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1];
if (!js) throw new Error('index.html 里没找到入口脚本');
html = html.replaceAll('"./assets/', `"${cdn}assets/`);
const fallback = `<script>setTimeout(function(){if(window.__xpBooted)return;var s=document.createElement('script');s.type='module';s.src='./${js}';document.head.appendChild(s);${css ? `var l=document.createElement('link');l.rel='stylesheet';l.href='./${css}';document.head.appendChild(l);` : ''}},30000);</script>`;
html = html.replace('</body>', fallback + '\n</body>');
fs.writeFileSync(out, html);
console.log('入口页已生成：', js, '→', cdn);

// 构建脚本：node build.js
// 产物：dist/bili-scanner.user.js（油猴） 与 dist/extension/*（Chrome MV3 扩展）
// 核心逻辑单一来源 src/core.js，两个发行渠道只是不同的环境包装。
const fs = require('fs');
const path = require('path');

const root = __dirname;
const core = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'extension'), { recursive: true });

// ---------- 油猴版 ----------
const gmShim = `
  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, anonymous: true, timeout: 10000,
        onload: r => {
          try {
            const j = JSON.parse(r.responseText);
            j.code === 0 ? resolve(j.data) : reject(new Error(j.message || ('code ' + j.code)));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('network')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
`;
const userHeader = `// ==UserScript==
// @name         B站扫榜助手 · 低粉爆文探测器
// @namespace    bili-scanner
// @version      0.3.0
// @description  在B站搜索/热门/排行榜页为视频标注 播放/粉丝 爆文率，高亮低粉爆文，支持关键词过滤与当日累积CSV导出。纯匿名：不登录、不带Cookie、不收集不回传任何数据。
// @match        https://search.bilibili.com/*
// @match        https://www.bilibili.com/v/popular/*
// @match        https://www.bilibili.com/v/recommend*
// @match        https://www.bilibili.com/ranking*
// @connect      api.bilibili.com
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==
`;
const userBody = `
(function () {
  'use strict';
${gmShim}
  initBiliScanner({
    requestJson,
    style: css => GM_addStyle(css),
    onReady: scan => { GM_registerMenuCommand('重新扫描', scan); scan(); },
  });
})();
`;
fs.writeFileSync(path.join(dist, 'bili-scanner.user.js'),
  userHeader + '\n' + core + '\n' + userBody);

// ---------- Chrome MV3 扩展 ----------
// content script 里用 fetch + credentials:'omit' 保持匿名（扩展有 host_permissions，不受页面 CSP 影响）
const extShim = `
  function requestJson(url) {
    return fetch(url, { credentials: 'omit' }).then(r => r.json()).then(j => {
      if (j.code === 0) return j.data;
      throw new Error(j.message || ('code ' + j.code));
    });
  }
`;
const extBody = `
(function () {
  'use strict';
${extShim}
  function style(css) {
    const s = document.createElement('style');
    s.textContent = css;
    document.documentElement.appendChild(s);
  }
  initBiliScanner({ requestJson, style });
})();
`;
const manifest = {
  manifest_version: 3,
  name: 'B站扫榜助手 · 低粉爆文探测器',
  version: '0.2.0',
  description: '在B站搜索/热门/排行榜页标注 播放/粉丝 爆文率，高亮低粉爆文。纯匿名：不登录、不带Cookie、无后端。',
  content_scripts: [{
    matches: [
      'https://search.bilibili.com/*',
      'https://www.bilibili.com/v/popular/*',
      'https://www.bilibili.com/v/recommend*',
      'https://www.bilibili.com/ranking*',
    ],
    js: ['content.js'],
    run_at: 'document_idle',
  }],
  host_permissions: ['https://api.bilibili.com/*'],
};
fs.writeFileSync(path.join(dist, 'extension', 'content.js'), core + '\n' + extBody);
fs.writeFileSync(path.join(dist, 'extension', 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('build OK -> dist/bili-scanner.user.js, dist/extension/');

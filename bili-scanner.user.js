// ==UserScript==
// @name         B站扫榜助手 · 低粉爆文探测器
// @namespace    bili-scanner
// @version      0.2.0
// @description  在B站搜索/热门/排行榜页为视频标注 播放/粉丝 爆文率，高亮低粉爆文，支持关键词过滤与当日累积CSV导出。纯匿名：不登录、不带Cookie、不收集不回传任何数据。
// @author       anonymous
// @match        https://search.bilibili.com/*
// @match        https://www.bilibili.com/v/popular/*
// @match        https://www.bilibili.com/v/recommend*
// @match        https://www.bilibili.com/v/technology*
// @match        https://www.bilibili.com/ranking*
// @connect      api.bilibili.com
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  // GM_xmlhttpRequest anonymous:true 不携带 cookie，保持纯匿名语义
  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: true,
        timeout: 10000,
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
  // 核心逻辑由构建脚本内联 src/core.js（发布版）；此处直接 require 同目录文件便于开发
  // 实际发布时用 build 脚本拼合，见 build.js
})();

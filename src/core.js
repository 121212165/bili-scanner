// B站扫榜助手 · 共享核心逻辑 v0.2.0
// 由包装层（油猴 / Chrome 扩展）注入 requestJson 与样式，核心保持环境无关。
// 纯匿名原则：所有请求由包装层保证不携带凭据；数据只存 localStorage。
(function (global) {
  'use strict';

  const CFG_KEY = 'biliScanner.cfg';
  const CACHE_KEY = 'biliScanner.cache';   // bv -> stats（含 mid/title）
  const FANS_KEY = 'biliScanner.fans';     // mid -> {follower, t}（按UP主缓存，跨页复用）
  const RES_KEY = 'biliScanner.results';   // 当日累计结果（翻页累积）
  const DEFAULT_CFG = {
    keywords: ['小说', '推文', '短剧', '广播剧', '有声', '原著'],
    minRatio: 10,
    minViews: 50000,
    requestGap: 300,
    cacheHours: 6,
  };

  function initBiliScanner(env) {
    // env: { requestJson(url) -> Promise<data>, style(css), onReady(scan) }
    const cfg = Object.assign({}, DEFAULT_CFG, load(CFG_KEY));
    const statsCache = load(CACHE_KEY) || {};
    const fansCache = load(FANS_KEY) || {};
    const dayResults = loadToday() || {}; // bv -> record，当日翻页累积

    function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
    function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
    function loadToday() {
      const all = load(RES_KEY);
      if (all && all._day === new Date().toISOString().slice(0, 10)) return all.data;
      return null;
    }
    function saveToday() {
      save(RES_KEY, { _day: new Date().toISOString().slice(0, 10), data: dayResults });
    }

    // ---------- 匿名限速请求队列（串行 + 固定间隔） ----------
    let chain = Promise.resolve();
    function anonGet(url) {
      const task = chain.then(() => env.requestJson(url))
        .then(v => new Promise(r => setTimeout(r, cfg.requestGap)).then(() => v));
      chain = task.catch(() => {});
      return task;
    }

    // ---------- 数据获取 ----------
    const inflight = new Set(); // BV 级去重，防 MutationObserver 重复 scan 堆积队列
    async function getStats(bv) {
      if (inflight.has(bv)) return null;
      const hit = statsCache[bv];
      if (hit && Date.now() - hit.t < cfg.cacheHours * 3600e3) return hit;
      inflight.add(bv);
      try {
        const v = await anonGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
        const s = { view: v.stat.view, like: v.stat.like, mid: v.owner.mid, title: v.title, t: Date.now() };
        s.fans = await getFans(s.mid);
        statsCache[bv] = s;
        trim(statsCache, CACHE_KEY, 800);
        return s;
      } finally {
        inflight.delete(bv);
      }
    }
    async function getFans(mid) {
      const hit = fansCache[mid];
      if (hit && Date.now() - hit.t < 24 * 3600e3) return hit.follower; // 粉丝数按UP主缓存24h，翻页/复访零请求
      try {
        // relation/stat 对匿名请求返回 -400，card 接口实测匿名可用且含 follower
        const f = await anonGet(`https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`);
        fansCache[mid] = { follower: f.follower, t: Date.now() };
        trim(fansCache, FANS_KEY, 1200);
        return f.follower;
      } catch (e) { return 0; }
    }
    function trim(obj, key, cap) {
      const keys = Object.keys(obj);
      if (keys.length > cap) {
        keys.sort((a, b) => (obj[a].t || 0) - (obj[b].t || 0))
          .slice(0, keys.length - cap).forEach(k => delete obj[k]);
      }
      save(key, obj);
    }

    // ---------- 页面扫描 ----------
    function pickCards() {
      const anchors = document.querySelectorAll('a[href*="/video/BV"]');
      const cards = new Map();
      for (const a of anchors) {
        const m = a.href.match(/\/video\/(BV[0-9A-Za-z]+)/);
        if (!m) continue;
        const card = a.closest('.bili-video-card, .video-card, .card-box, .hot-card, .rank-item, li') || a;
        if (!cards.has(m[1])) cards.set(m[1], card);
      }
      return cards;
    }
    function hitKeywords(title) {
      return cfg.keywords.some(k => title && title.includes(k));
    }

    const results = new Map(); // 本页会话内存
    for (const bv in dayResults) results.set(bv, dayResults[bv]); // 恢复当日累积

    function renderBadge(bv, card, s) {
      if (card.querySelector('.bsc-badge')) return;
      const ratio = s.fans > 0 ? (s.view / s.fans) : 0;
      const hot = ratio >= cfg.minRatio && s.view >= cfg.minViews;
      const kw = hitKeywords(s.title);
      const badge = document.createElement('div');
      badge.className = 'bsc-badge' + (hot ? ' bsc-hot' : '');
      badge.textContent = `▶${fmt(s.view)} ✿${fmt(s.fans)} 🎯${ratio ? ratio.toFixed(1) : '?'}x${kw ? ' ⭐词' : ''}`;
      badge.title = `标题：${s.title}\n播放 ${s.view} / 粉丝 ${s.fans} = 爆文率 ${ratio.toFixed(1)}x\n（阈值 ${cfg.minRatio}x）`;
      badge.dataset.bv = bv;
      card.style.position = card.style.position || 'relative';
      card.appendChild(badge);
      if (hot) card.classList.add('bsc-hot-card');

      const rec = { bv, title: s.title, view: s.view, like: s.like, fans: s.fans, ratio: +ratio.toFixed(1), kw, hot };
      results.set(bv, rec);
      dayResults[bv] = rec;
      updatePanelCount();
    }

    function fmt(n) {
      n = +n || 0;
      return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    }

    let scanning = false;
    async function scan() {
      if (scanning) return;
      scanning = true;
      try {
        const cards = pickCards();
        if (!cards.size) return;
        // 搜索页走批量接口：1次请求拿整页播放量+mid，只有未缓存的粉丝数需要逐个查
        const sp = location.hostname === 'search.bilibili.com'
          ? new URLSearchParams(location.search) : null;
        const keyword = sp && sp.get('keyword');
        if (keyword) await batchScan(cards, keyword, Math.max(1, +(sp.get('page') || 1)));
        else await domScan(cards);
        saveToday();
        updatePanelCount();
      } finally {
        scanning = false;
      }
    }

    // 搜索页批量：search/type 匿名可用，一次返回整页（pagesize=20，含 play/title/mid/bvid）
    async function batchScan(cards, keyword, page) {
      const stripTags = t => String(t || '').replace(/<[^>]+>/g, '');
      setStatus(`批量拉取「${keyword}」第${page}页…`);
      let map = new Map(); // bvid -> {play, title, mid}
      try {
        const data = await anonGet(
          `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}`);
        for (const item of (data.result || [])) {
          if (item.type !== 'video' || !item.bvid) continue;
          map.set(item.bvid, { play: item.play, title: stripTags(item.title), mid: item.mid, like: item.like || -1 });
        }
      } catch (e) {
        setStatus('批量接口失败，回退逐个查询');
        return domScan(cards);
      }
      let done = 0;
      for (const [bv, card] of cards) {
        if (card.querySelector('.bsc-badge')) { done++; continue; }
        const info = map.get(bv);
        if (!info) { done++; continue; } // 广告/非视频卡片
        try {
          const fans = await getFans(info.mid); // 串行限速；已缓存的 mid 立即返回
          renderBadge(bv, card, { view: info.play, like: info.like, mid: info.mid, title: info.title, fans, t: Date.now() });
        } catch (e) { /* 单个失败跳过 */ }
        done++;
        if (done % 5 === 0) setStatus(`扫描中 ${done}/${cards.size}`);
      }
    }

    async function domScan(cards) {
      let done = 0;
      setStatus(`扫描中 0/${cards.size}`);
      for (const [bv, card] of cards) {
        if (card.querySelector('.bsc-badge')) { done++; continue; }
        try {
          const s = await getStats(bv); // 串行等待，天然限速
          if (s) renderBadge(bv, card, s);
        } catch (e) { /* 单个失败跳过 */ }
        done++;
        if (done % 5 === 0) setStatus(`扫描中 ${done}/${cards.size}`);
      }
    }

    // ---------- 悬浮控制面板 ----------
    const CSS = `
      #bsc-panel{position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff;border:1px solid #fb729955;
        border-radius:10px;padding:12px 14px;font:13px/1.6 sans-serif;box-shadow:0 4px 16px #0002;width:230px}
      #bsc-panel h3{margin:0 0 6px;font-size:14px;color:#fb7299}
      #bsc-panel label{display:block;margin:4px 0 2px;color:#666}
      #bsc-panel input{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #ddd;border-radius:4px}
      #bsc-panel .row{display:flex;gap:8px;margin-top:8px}
      #bsc-panel button{flex:1;padding:5px 0;border:0;border-radius:5px;background:#fb7299;color:#fff;cursor:pointer}
      #bsc-panel button.ghost{background:#eee;color:#555}
      #bsc-status{margin-top:6px;color:#999;font-size:12px}
      .bsc-badge{position:absolute;left:6px;bottom:6px;z-index:9;background:#000a;color:#fff;border-radius:4px;
        padding:1px 6px;font-size:12px;pointer-events:none;white-space:nowrap}
      .bsc-badge.bsc-hot{background:#fb7299}
      .bsc-hot-card{outline:2px solid #fb7299}
    `;

    let panel;
    function buildPanel() {
      panel = document.createElement('div');
      panel.id = 'bsc-panel';
      panel.innerHTML = `
        <h3>扫榜助手（匿名）</h3>
        <label>爆文阈值 播放/粉丝 ≥</label><input id="bsc-ratio" type="number" value="${cfg.minRatio}">
        <label>最低播放量</label><input id="bsc-views" type="number" value="${cfg.minViews}">
        <label>关键词（逗号分隔）</label><input id="bsc-kw" value="${cfg.keywords.join(',')}">
        <div class="row"><button id="bsc-apply">应用</button><button id="bsc-export" class="ghost">导出当日CSV</button></div>
        <div class="row"><button id="bsc-cards" class="ghost">导出素材卡MD</button></div>
        <div class="row"><button id="bsc-clear" class="ghost">清空累计</button></div>
        <div id="bsc-status">待扫描</div>`;
      document.body.appendChild(panel);

      document.getElementById('bsc-apply').onclick = () => {
        cfg.minRatio = +document.getElementById('bsc-ratio').value || cfg.minRatio;
        cfg.minViews = +document.getElementById('bsc-views').value || cfg.minViews;
        cfg.keywords = document.getElementById('bsc-kw').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        save(CFG_KEY, cfg);
        document.querySelectorAll('.bsc-badge').forEach(b => b.remove());
        document.querySelectorAll('.bsc-hot-card').forEach(c => c.classList.remove('bsc-hot-card'));
        results.clear();
        scan();
      };
      document.getElementById('bsc-export').onclick = exportCsv;
      document.getElementById('bsc-cards').onclick = exportCards;
      document.getElementById('bsc-clear').onclick = () => {
        Object.keys(dayResults).forEach(k => delete dayResults[k]);
        results.clear();
        saveToday();
        updatePanelCount();
      };
    }
    function setStatus(t) { const el = document.getElementById('bsc-status'); if (el) el.textContent = t; }
    function updatePanelCount() {
      const hot = [...results.values()].filter(r => r.hot).length;
      setStatus(`本会话 ${results.size} · 爆文 ${hot}（当日累计 ${Object.keys(dayResults).length}）`);
    }
    function exportCsv() {
      const head = 'bv,title,views,likes,fans,ratio,keywordHit,hot';
      const rows = [...results.values()].map(r =>
        [r.bv, `"${r.title.replace(/"/g, '""')}"`, r.view, r.like, r.fans, r.ratio, r.kw ? 1 : 0, r.hot ? 1 : 0].join(','));
      const blob = new Blob(['\ufeff' + [head, ...rows].join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bili-scan-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    }

    function escMd(s) { return String(s || '').replace(/[\\[\]]/g, ' ').replace(/\s+/g, ' ').trim(); }
    // 素材卡导出：与 fanqie-rank-scanner / Obsidian scan-card-box 同格式
    function exportCards() {
      if (!results.size) return setStatus('先扫描出数据');
      const today = new Date().toISOString().slice(0, 10);
      const md = [...results.values()].map(r => [
        '---',
        'tags: [素材卡, 扫榜, B站]',
        'genre: B站低粉爆文',
        `hook: ${escMd(r.title).slice(0, 60)}`,
        'ending: ""',
        `source: B站#${r.bv} 播放${fmt(r.view)} 赞${fmt(r.like)} 粉丝${fmt(r.fans)} 播放/粉丝=${r.ratio}${r.hot ? ' 🔥爆文' : ''}`,
        `created: ${today}`,
        '---',
        '',
        `## ${escMd(r.title)}`,
        `- 爆文率：播放/粉丝=${r.ratio}${r.kw ? ' ｜ 命中关键词' : ''}`,
        `- 链接：https://www.bilibili.com/video/${r.bv}`,
        '',
      ].join('\n')).join('\n\n');
      const blob = new Blob(['\ufeff' + md], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bili-cards-${today}.md`;
      a.click();
      setStatus(`已导出 ${results.size} 张素材卡 md`);
    }

    env.style(CSS);
    if (document.body) buildPanel();
    else document.addEventListener('DOMContentLoaded', buildPanel);

    // SPA 路由/翻页监听（自身徽标插入也会触发，scan 内部有去重兜底）
    let debTimer;
    function debounce(fn, ms) { clearTimeout(debTimer); debTimer = setTimeout(fn, ms); }
    const mo = new MutationObserver(() => debounce(scan, 1000));
    mo.observe(document.body, { childList: true, subtree: true });

    if (env.onReady) env.onReady(scan); else scan();
    return { scan, cfg };
  }

  global.initBiliScanner = initBiliScanner;
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

/* ============================================================
   小光账号 · 前端逻辑
   视图：总览(分析) / 账号管理与账号标签 / 作品 / 采集中心
   ============================================================ */
const state = {
  view: 'dashboard',
  accounts: [],
  works: [],
  search: '',
  range: 7,
  rank: 'comments',
  analytics: null,
  detailAccountId: null,
  detail: null,
  wsTabs: [],          // 已打开的账号标签（id 数组，按打开顺序）
  wsActive: 'accounts', // 'accounts' = 账号管理，数字 = 激活的账号标签
  wsTarget: 'publish',
  accountCards: {},    // 卡片指标：account_id -> { interactions_7d, works_7d }
  homepageFetched: new Set(), // 本次会话已后台补拉过主页资料的账号
  homepageResolving: new Set(), // 正在用账号登录态自动识别主页链接
  homepageResolveQueued: new Set(),
  homepageResolveAttempts: new Map(),
  homepageResolveQueue: Promise.resolve(),
  wsLoadFailed: new Set(),    // 加载失败的标签：再次点击时强制重载而不是只聚焦
  profileTimers: new Map(),   // account_id -> 自动同步重试计时器
  profileSync: new Map(),     // account_id -> { status, message }
  profileSyncedThisSession: new Set(),
  loginSessions: new Map(), // 临时账号 id -> 登录会话（成功前不进入正式账号列表）
  loginTimers: new Map(),
  loginInspecting: new Set(),
  collecting: false,
  collectTargetIds: new Set(),
  platformPickerMode: 'account',
  collectConfig: {
    auto_enabled: false, frequency: 'daily', weekday: 1,
    hour: 6, minute: 0, scan_limit: 20, platforms: ['抖音'],
  },
  // 平台与账号字段配置（来自设置页，后端持久化）
  platforms: ['抖音', '快手', '小红书', 'B站', '咸鱼'],
  collectSupported: ['抖音'],
  fieldConfig: [],
  fieldsDraft: null,
  protectedFields: ['account_name', 'homepage_url'],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const LOCAL_API_ORIGIN = 'http://127.0.0.1:8826';

/* ---------- 基础 ---------- */
function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') return path;
  return `${LOCAL_API_ORIGIN}${path}`;
}
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch (error) {
    if (apiUrl(path) !== `${LOCAL_API_ORIGIN}${path}`) {
      res = await fetch(`${LOCAL_API_ORIGIN}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
    } else { throw error; }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  const opts = arguments[1] || {};
  if (opts.action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => { el.classList.remove('show'); opts.action.onClick(); });
    el.appendChild(btn);
  }
  el.classList.add('show');
  // 错误类消息停留更久，方便阅读和复制
  const duration = opts.duration || (/失败|错误|超时|异常/.test(message) ? 6500 : 3200);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), duration);
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function fmt(n) {
  if (n === null || n === undefined || n === '') return '-';
  n = Number(n);
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toLocaleString('zh-CN');
}
function short(t, max = 40) { t = t || ''; return t.length > max ? `${t.slice(0, max)}…` : t; }
function timeText(v) { return v ? String(v).replace('T', ' ').replace(/\+.*$/, '').slice(0, 16) : '-'; }
function relTime(v) {
  if (!v) return '-';
  const t = new Date(String(v)).getTime();
  if (!Number.isFinite(t)) return timeText(v);
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}
function loginStatus(a) { return AccountVisuals.resolveLoginStatus(a); }
function accountVisualState(a) { return AccountVisuals.getAccountVisualState(a); }
function statusBadge(s) {
  if (!s) return '<span class="badge">未填</span>';
  const ok = s === '正常' || s === '可用' || s === '已登录';
  const bad = /封号|处罚|不可用/.test(s);
  return `<span class="badge ${ok ? 'ok' : bad ? 'bad' : 'warn'}">${esc(s)}</span>`;
}
const PF_CLASS = { 抖音: 'douyin', 快手: 'kuaishou', 小红书: 'redbook', B站: 'bilibili', 咸鱼: 'xianyu' };
const PF_SHORT = { 抖音: '抖', 快手: '快', 小红书: '红', B站: 'B', 咸鱼: '闲' };
function avatar(a) {
  // 字母占位永远在底层，图片加载失败自动移除自己露出占位（CDN 链接可能过期）
  const letter = esc(String(a.profile_nickname || a.account_name || '?').trim().slice(0, 1).toUpperCase());
  const img = a.avatar_url ? `<img src="${esc(a.avatar_url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const platform = AccountVisuals.getPlatformVisual(a.platform);
  const pf = a.platform ? `<span class="pf ${esc(platform.key)}" title="${esc(platform.label)}"><img src="${esc(platform.iconPath)}" alt="" draggable="false"></span>` : '';
  return `<span class="avatar">${letter}${img}${pf}</span>`;
}
function platformMark(platformName) {
  const platform = AccountVisuals.getPlatformVisual(platformName);
  return `<span class="platform-mark ${esc(platform.key)}" aria-hidden="true"><img src="${esc(platform.iconPath)}" alt="" draggable="false"></span>`;
}

/* ---------- 视图切换 ---------- */
const VIEW_META = {
  dashboard: ['总览', '账号运营数据分析，来自本地采集与留存。'],
  accounts: ['账号', '登录平台、管理账号资料和打开创作页面。'],
  works: ['作品', '本地留存的作品互动数据。'],
  collect: ['采集中心', '采集小号登录、定时采集与采集历史。'],
  settings: ['设置', '常规偏好、数据管理、账号字段与平台管理。'],
  accountDetail: ['账号详情', '单账号数据下钻。'],
};
function setView(view) {
  if (view === 'workspace') view = 'accounts'; // 兼容旧链接与旧导航设置
  if (!VIEW_META[view]) view = 'dashboard';
  state.view = view;
  document.body.dataset.view = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(el => el.classList.remove('active'));
  $(`#${view}View`).classList.add('active');
  $('#pageTitle').textContent = VIEW_META[view][0];
  $('#pageSubtitle').textContent = VIEW_META[view][1];
  $('#rangeSelect').style.display = (view === 'dashboard' || view === 'accountDetail') ? '' : 'none';
  if (view === 'dashboard' && state.analytics) requestAnimationFrame(renderCharts);
  if (view === 'accounts') {
    renderWorkspaceViews();
    requestAnimationFrame(syncEmbeddedBounds);
  } else { clearProfileTimers(); window.accountConsole?.hideEmbedded?.(); renderSideAccounts(); }
  if (view === 'collect') loadCollectCenter();
  if (view === 'settings') renderSettingsPage();
}
function initialView() {
  const p = new URLSearchParams(window.location.search).get('view');
  const h = window.location.hash.replace(/^#/, '');
  if (p === 'workspace' || h === 'workspace') return 'accounts';
  if (VIEW_META[p]) return p;
  if (VIEW_META[h]) return h;
  return 'dashboard';
}

/* ---------- 总览：分析仪表盘 ---------- */
const RANK_LABEL = { comments: '评论', likes: '点赞', interactions: '互动' };
async function loadDashboard() {
  const d = await api(`/api/analytics?days=${state.range}&rank=${state.rank}`);
  state.analytics = d;
  const k = d.kpi;
  const n = d.days;
  $('#kpiCards').innerHTML = [
    ['账号总数', fmt(k.account_total), `可采集 ${fmt(k.collectable)}`],
    [`近${n}天作品数`, fmt(k.works_in_range), `累计作品 ${fmt(k.works_total)}`],
    [`近${n}天点赞`, fmt(k.likes_in_range), k.plays_in_range ? `播放 ${fmt(k.plays_in_range)}` : `累计互动 ${fmt(k.interactions_all)}`],
    [`近${n}天评论`, fmt(k.comments_in_range), ''],
    [`近${n}天收藏`, fmt(k.favorites_in_range), ''],
    [`近${n}天分享`, fmt(k.shares_in_range), ''],
  ].map(([label, value, note]) => `
    <div class="stat"><span>${label}</span><strong>${value}</strong><em>${note}</em></div>
  `).join('');

  $('#trendNote').textContent = `近 ${n} 天发布`;
  $('#accountChartNote').textContent = `近 ${n} 天发布作品`;
  renderRankAndWorks(d);
  renderCollectSidebar(d.last_collect);
  if (state.view === 'dashboard') requestAnimationFrame(renderCharts);
}

function renderRankAndWorks(d) {
  $('#rankList').innerHTML = (d.top_accounts || []).map((a, i) => `
    <div class="row-item clickable" onclick="openAccountDetail(${a.id})">
      <div class="r-main">
        <strong>${i + 1}. ${esc(a.account_name || '-')}</strong>
        <span>${esc(a.platform || '-')} · 作品 ${fmt(a.works)} · 粉丝 ${fmt(a.followers)}</span>
      </div>
      <div class="r-side">${fmt(a.interactions)}</div>
    </div>
  `).join('') || '<div class="row-empty">暂无数据</div>';

  const rankKey = { comments: 'comments', likes: 'likes', interactions: 'interactions' }[d.rank] || 'comments';
  $('#topWorks').innerHTML = (d.top_works || []).map((w, i) => `
    <div class="row-item">
      <div class="r-main">
        <strong>${i + 1}. ${w.work_url ? `<a href="${esc(w.work_url)}" target="_blank">${esc(short(w.title, 28))}</a>` : esc(short(w.title, 28))}</strong>
        <span>${esc(w.account_name || '-')} · ${timeText(w.published_at)}</span>
      </div>
      <div class="r-side">${RANK_LABEL[d.rank] || '评论'} ${fmt(w[rankKey])}</div>
    </div>
  `).join('') || '<div class="row-empty">暂无作品</div>';
}

function renderCharts() {
  const d = state.analytics;
  if (!d || !window.Charts) return;

  const trend = d.publish_trend || [];
  Charts.line($('#trendChart'), {
    labels: trend.map(t => t.date),
    series: [
      { name: '互动', data: trend.map(t => t.interactions), color: '#0f766e' },
      { name: '发布数', data: trend.map(t => t.works), color: '#2563eb', fill: false },
    ],
  });

  const mix = d.interaction_mix || {};
  Charts.doughnut($('#mixChart'), {
    items: [
      { label: '点赞', value: mix.likes || 0, color: '#0f766e' },
      { label: '评论', value: mix.comments || 0, color: '#2563eb' },
      { label: '收藏', value: mix.favorites || 0, color: '#f59e0b' },
      { label: '分享', value: mix.shares || 0, color: '#db2777' },
    ],
  });

  // 账号维度堆叠对比（近 N 天发布作品的互动拆分）
  const ba = d.by_account || [];
  Charts.stackedBar($('#accountChart'), {
    labels: ba.map(a => `${a.account_name} · ${a.platform}`),
    series: [
      { name: '点赞', data: ba.map(a => a.likes), color: '#0f766e' },
      { name: '评论', data: ba.map(a => a.comments), color: '#2563eb' },
      { name: '收藏', data: ba.map(a => a.favorites), color: '#f59e0b' },
      { name: '分享', data: ba.map(a => a.shares), color: '#db2777' },
      { name: '播放', data: ba.map(a => a.plays), color: '#7c3aed' },
    ],
  });

  const bp = d.by_platform || [];
  Charts.bar($('#platformChart'), {
    labels: bp.map(p => p.platform),
    data: bp.map(p => (p.interactions || 0) + (p.plays || 0)),
    colors: bp.map(p => Charts.PALETTE[0]),
  });
}

/* ---------- 账号详情（下钻） ---------- */
async function openAccountDetail(id) {
  state.detailAccountId = id;
  setView('accountDetail');
  await loadAccountDetail();
}
async function loadAccountDetail() {
  if (!state.detailAccountId) return;
  let d;
  try {
    d = await api(`/api/analytics/account/${state.detailAccountId}?days=${state.range}`);
  } catch (err) { toast(`加载失败：${err.message}`); return; }
  state.detail = d;
  const a = d.account;
  const t = d.totals;
  $('#pageTitle').textContent = a.account_name || '账号详情';
  $('#pageSubtitle').textContent = `${a.platform || '-'} · ${a.status || '-'}${a.traffic_level ? ` · ${a.traffic_level}` : ''}`;
  $('#adHeader').innerHTML = `${avatar(a)} <strong style="margin-left:8px">${esc(a.account_name || '-')}</strong>
    <span class="muted" style="margin-left:8px">${esc(a.platform || '-')} · 粉丝 ${fmt(a.followers)}</span>`;
  const interactions = (t.likes || 0) + (t.comments || 0) + (t.favorites || 0) + (t.shares || 0);
  const inRange = (d.publish_trend || []).reduce((s, r) => s + r.works, 0);
  $('#adKpis').innerHTML = [
    ['作品总数', fmt(t.works), `近 ${d.days} 天发布 ${fmt(inRange)}`],
    ['累计互动', fmt(interactions), ''],
    ['点赞', fmt(t.likes), ''],
    ['评论', fmt(t.comments), ''],
    ['收藏', fmt(t.favorites), ''],
    ['播放', fmt(t.plays), ''],
  ].map(([label, value, note]) => `
    <div class="stat"><span>${label}</span><strong>${value}</strong><em>${note}</em></div>`).join('');
  $('#adTrendNote').textContent = `近 ${d.days} 天`;

  $('#adRuns').innerHTML = (d.runs || []).map(r => `
    <div class="row-item">
      <div class="r-main">
        <strong>${r.status === 'success' ? '<span class="badge ok">成功</span>' : '<span class="badge bad">失败</span>'} ${timeText(r.finished_at || r.started_at)}</strong>
        <span>${r.status === 'success' ? `更新 ${fmt(r.works_updated)} 条` : esc(short(r.error_message, 44))}</span>
      </div>
      <div class="r-side">${r.trigger_source === 'scheduled' ? '定时' : '手动'}</div>
    </div>
  `).join('') || '<div class="row-empty">还没有采集过，点右上「采集该账号」</div>';

  const custom = a.custom_fields || {};
  $('#adProfile').innerHTML = state.fieldConfig.map(f => {
    let value = f.builtin ? a[f.key] : custom[f.key];
    if (f.key === 'followers') value = fmt(value);
    const display = (value === null || value === undefined || value === '') ? '-'
      : f.type === 'url' ? `<a href="${esc(value)}" target="_blank">${esc(short(String(value), 40))}</a>`
      : esc(String(value));
    return `<div class="profile-item"><span>${esc(f.label)}</span><strong>${display}</strong></div>`;
  }).join('');

  $('#adWorksTable').innerHTML = (d.works || []).map(w => `
    <tr>
      <td><strong title="${esc(w.title)}">${w.work_url ? `<a href="${esc(w.work_url)}" target="_blank">${esc(short(w.title, 42) || '-')}</a>` : esc(short(w.title, 42) || '-')}</strong></td>
      <td>${timeText(w.published_at)}</td>
      <td class="num">${fmt(w.likes)}</td>
      <td class="num">${fmt(w.comments)}</td>
      <td class="num">${fmt(w.favorites)}</td>
      <td class="num">${fmt(w.shares)}</td>
      <td class="num">${fmt(w.plays)}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty-cell">暂无作品数据</td></tr>';

  requestAnimationFrame(() => {
    const trend = d.publish_trend || [];
    Charts.line($('#adTrendChart'), {
      labels: trend.map(r => r.date),
      series: [
        { name: '互动', data: trend.map(r => r.interactions), color: '#0f766e' },
        { name: '发布数', data: trend.map(r => r.works), color: '#2563eb', fill: false },
      ],
    });
  });
}

function renderCollectSidebar(lastCollect) {
  const dot = $('#collectDot');
  if (!lastCollect) {
    dot.className = 'dot';
    $('#collectState').textContent = '未采集';
    $('#collectTime').textContent = '本地数据主库';
    return;
  }
  const at = lastCollect.finished_at || lastCollect.started_at;
  const ageMs = Date.now() - new Date(String(at)).getTime();
  const stale = Number.isFinite(ageMs) && ageMs > 48 * 3600e3;
  const okRun = lastCollect.status === 'success';
  dot.className = `dot ${okRun ? (stale ? 'warn' : 'ok') : 'bad'}`;
  $('#collectState').textContent = okRun ? (stale ? '数据可能过期' : '采集正常') : '采集异常';
  $('#collectTime').textContent = `上次采集 ${relTime(at)}`;
}

/* ---------- 账号 ---------- */
function accountsFiltered() {
  return Boolean(state.search || $('#platformFilter').value || $('#statusFilter').value);
}
async function loadAccounts() {
  const params = new URLSearchParams();
  if (state.search) params.set('search', state.search);
  if ($('#platformFilter').value) params.set('platform', $('#platformFilter').value);
  if ($('#statusFilter').value) params.set('status', $('#statusFilter').value);
  params.set('limit', '500');
  const filtered = await api(`/api/accounts?${params.toString()}`);
  const all = accountsFiltered() ? await api('/api/accounts?limit=500') : filtered;
  state.accounts = all.data;
  const tableAccounts = filtered.data;
  const normal = tableAccounts.filter(a => a.status === '正常').length;
  const ready = tableAccounts.filter(a => loginStatus(a) === '已登录').length;
  const draggable = !accountsFiltered();
  $('#accountStats').textContent = `共 ${tableAccounts.length} · 正常 ${normal} · 已登录 ${ready}${draggable ? ' · 可拖拽排序' : ''}`;
  $('#accountsTable').innerHTML = tableAccounts.map(a => {
    const openLabel = loginStatus(a) === '已登录' ? '打开' : '重新登录';
    return `
    <tr data-id="${a.id}" ${draggable ? 'draggable="true"' : ''}>
      <td><div class="cell-main">${draggable ? '<span class="drag-handle" title="拖拽排序">⋮⋮</span>' : ''}${avatar(a)}<div class="titles">
        <strong>${esc(a.account_name || '-')}</strong>
        <span>${esc(a.platform || '-')}${a.profile_nickname ? ` · ${esc(a.profile_nickname)}` : ''}</span>
      </div></div></td>
      <td>${statusBadge(a.status)} ${a.account_type && a.account_type !== '可用' ? statusBadge(a.account_type) : ''}</td>
      <td>${statusBadge(loginStatus(a))}</td>
      <td class="num">${fmt(a.followers)}</td>
      <td class="num">${fmt(a.works_count)}</td>
      <td class="actions">
        <button class="btn mini primary" onclick="openAccountWorkspace(${a.id}, 'publish')">${openLabel}</button>
        <button class="btn mini subtle" onclick="openAccountDetail(${a.id})">详情</button>
        <button class="btn mini subtle" onclick="editAccount(${a.id})">编辑</button>
      </td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="6" class="empty-cell">暂无账号，点击「添加账号」选择平台并登录</td></tr>';
  if (draggable) enableDragSort($('#accountsTable'), 'tr', saveAccountOrder);
  renderWorkspaceViews();
  queueMissingHomepageBackfill();
}

/* ---------- 拖拽排序（账号列表 / 导航共用） ---------- */
function enableDragSort(container, itemSelector, onDrop, options = {}) {
  let dragged = null;
  let moved = false;
  Array.from(container.querySelectorAll(itemSelector)).forEach((item) => {
    const dragSource = options.handleSelector ? item.querySelector(options.handleSelector) : item;
    if (!dragSource) return;
    dragSource.setAttribute('draggable', 'true');
    dragSource.addEventListener('dragstart', (e) => {
      dragged = item;
      moved = false;
      item.classList.add('dragging');
      container.classList.add('sorting');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', item.dataset.id || item.dataset.view || ''); } catch { /* ignore */ }
    });
    item.addEventListener('dragover', (e) => {
      if (!dragged || dragged === item) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      const target = after ? item.nextSibling : item;
      if (target !== dragged) { container.insertBefore(dragged, target); moved = true; }
    });
    item.addEventListener('drop', (e) => e.preventDefault());
    dragSource.addEventListener('dragend', () => {
      if (dragged) dragged.classList.remove('dragging');
      container.classList.remove('sorting');
      const didMove = moved;
      if (didMove) item.__suppressClickUntil = Date.now() + 250;
      dragged = null;
      if (didMove && onDrop) onDrop();
      moved = false;
    });
    item.addEventListener('click', (e) => {
      if (Number(item.__suppressClickUntil || 0) > Date.now()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  });
  // 容器级 dragover 只挂一次，保证空白区域也允许放下
  if (!container.__dragWired) {
    container.__dragWired = true;
    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => e.preventDefault());
  }
}
async function applyAccountOrder(ids, message) {
  await api('/api/accounts/reorder', { method: 'POST', body: JSON.stringify({ ids }) });
  const byId = Object.fromEntries(state.accounts.map(a => [a.id, a]));
  state.accounts = ids.map(id => byId[id]).filter(Boolean)
    .concat(state.accounts.filter(a => !ids.includes(a.id)));
  await loadAccounts();
  if (message) toast(message);
}
async function saveOrderWithUndo(ids) {
  const prevIds = state.accounts.map(a => a.id);
  try {
    await applyAccountOrder(ids);
    toast('账号顺序已保存', {
      action: {
        label: '撤销',
        onClick: () => applyAccountOrder(prevIds, '已恢复原顺序').catch(err => toast(`撤销失败：${err.message}`)),
      },
    });
  } catch (err) {
    let restored = true;
    await loadAccounts().catch(() => { restored = false; });
    toast(restored
      ? `排序保存失败，已恢复原顺序：${err.message}`
      : `排序保存失败，重新加载也失败：${err.message}`);
  }
}
async function saveAccountOrder() {
  const ids = Array.from($('#accountsTable').querySelectorAll('tr[data-id]')).map(tr => Number(tr.dataset.id));
  if (ids.length) await saveOrderWithUndo(ids);
}
async function saveSidebarOrder() {
  const ids = Array.from($('#sideAccounts').querySelectorAll('.side-acc[data-id]')).map(el => Number(el.dataset.id));
  if (ids.length) await saveOrderWithUndo(ids);
}
async function moveSidebarAccount(accountId, direction) {
  const ids = state.accounts.map(a => a.id);
  const from = ids.indexOf(Number(accountId));
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await saveOrderWithUndo(ids);
  requestAnimationFrame(() => {
    document.querySelector(`.side-acc[data-id="${accountId}"] .side-drag-handle`)?.focus();
  });
}
async function saveNavOrder() {
  const order = $$('.nav .nav-item').map(b => b.dataset.view);
  try {
    await api('/api/ui-settings', { method: 'POST', body: JSON.stringify({ nav_order: order }) });
  } catch { /* 静默 */ }
}
async function applyNavOrder() {
  try {
    const settings = await api('/api/ui-settings');
    const order = settings.nav_order;
    if (!Array.isArray(order) || !order.length) return;
    const nav = $('.nav');
    order.forEach(view => {
      const btn = nav.querySelector(`.nav-item[data-view="${view}"]`);
      if (btn) nav.appendChild(btn);
    });
  } catch { /* 后端旧版无此接口时跳过 */ }
}

/* ---------- 平台与字段配置 ---------- */
async function loadMeta() {
  try {
    const [pf, fc] = await Promise.all([api('/api/platforms'), api('/api/account-fields')]);
    state.platforms = pf.platforms || state.platforms;
    state.collectSupported = pf.collect_supported || state.collectSupported;
    AccountVisuals.configurePlatformVisuals?.(pf.capabilities || []);
    state.fieldConfig = fc.fields || [];
    state.protectedFields = fc.protected || state.protectedFields;
  } catch { /* 接口不可用时用默认 */ }
  renderPlatformSelects();
}
function renderPlatformSelects() {
  [['#platformFilter', '全部平台'], ['#workPlatformFilter', '全部平台'], ['#wsPlatform', '全部平台']].forEach(([sel, allLabel]) => {
    const el = $(sel);
    if (!el) return;
    const current = el.value;
    el.innerHTML = `<option value="">${allLabel}</option>` +
      state.platforms.map(p => `<option${p === current ? ' selected' : ''}>${esc(p)}</option>`).join('');
  });
}
function fieldByKey(key) { return state.fieldConfig.find(f => f.key === key); }

/* ---------- 设置页 ---------- */
const FIELD_TYPE_LABELS = { text: '文本', number: '数字', select: '下拉单选', url: '链接', textarea: '多行文本' };
function renderSettingsPage() {
  state.fieldsDraft = state.fieldsDraft || state.fieldConfig.map(f => ({ ...f, options: f.options ? [...f.options] : undefined }));
  renderFieldList();
  renderPlatformManager();
  loadGeneralSettings();
}

/* ---------- 常规设置 ---------- */
async function loadGeneralSettings() {
  try {
    const general = await api('/api/general-settings');
    $('#setCloseBehavior').value = general.close_to_tray === false ? 'quit' : 'tray';
    $('#setNotify').checked = general.notify_on_collect !== false;
    $('#setAutostartHidden').checked = general.autostart_hidden !== false;
  } catch { /* 用默认显示 */ }
  const desktop = Boolean(window.accountConsole?.getGeneralState);
  $('#setAutostart').disabled = !desktop;
  if (desktop) {
    try {
      const stateNow = await window.accountConsole.getGeneralState();
      $('#setAutostart').checked = Boolean(stateNow.autostart);
    } catch { /* 忽略 */ }
  }
  $('#autostartHiddenRow').style.display = $('#setAutostart').checked ? '' : 'none';
  try {
    const about = await api('/api/about');
    $('#aboutDataDir').textContent = about.data_dir || '-';
    $('#aboutVersion').textContent = `v${about.version || '-'}`;
    $('#aboutLastBackup').textContent = about.last_backup_at ? `上次备份 ${about.last_backup_at}（保留最近 14 份）` : '还没有备份';
  } catch { /* 忽略 */ }
}
async function saveGeneralSettings(patch) {
  try {
    const general = window.accountConsole?.updateGeneral
      ? await window.accountConsole.updateGeneral(patch)
      : await api('/api/general-settings', { method: 'POST', body: JSON.stringify(patch) });
    toast('设置已保存');
    return general;
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
}
async function applyAutostartSetting() {
  const enabled = $('#setAutostart').checked;
  const hidden = $('#setAutostartHidden').checked;
  $('#autostartHiddenRow').style.display = enabled ? '' : 'none';
  try {
    await window.accountConsole?.setAutostart?.({ enabled, autostart_hidden: hidden });
    toast('设置已保存');
  } catch (err) { toast(`设置失败：${err.message}`); }
}
function renderFieldList() {
  const rows = state.fieldsDraft.map((f, i) => {
    const isProtected = state.protectedFields.includes(f.key);
    return `
    <div class="field-row" data-index="${i}">
      <input class="input f-label" value="${esc(f.label)}" placeholder="字段名称">
      <select class="input f-type" ${f.builtin ? 'disabled' : ''}>
        ${Object.entries(FIELD_TYPE_LABELS).map(([v, l]) =>
          `<option value="${v}" ${((f.type === 'platform' ? 'select' : f.type) === v) ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input class="input f-options" value="${esc((f.options || []).join('，'))}"
        placeholder="${f.type === 'select' ? '选项，用逗号分隔' : f.type === 'platform' ? '选项在「平台管理」维护' : '—'}"
        ${(f.type === 'select') ? '' : 'disabled'}>
      ${isProtected
        ? '<span class="badge ok">固定</span>'
        : `<span class="field-tail">${f.builtin ? '<span class="badge">内置</span>' : ''}<button type="button" class="btn mini danger-ghost f-del">删除</button></span>`}
    </div>`;
  }).join('');
  $('#fieldList').innerHTML = rows || '<div class="row-empty">暂无字段</div>';
  $$('#fieldList .f-del').forEach(btn => {
    btn.onclick = () => {
      const index = Number(btn.closest('.field-row').dataset.index);
      state.fieldsDraft.splice(index, 1);
      renderFieldList();
    };
  });
  $$('#fieldList .f-type').forEach(sel => {
    sel.onchange = () => {
      const row = sel.closest('.field-row');
      const optionsInput = row.querySelector('.f-options');
      optionsInput.disabled = sel.value !== 'select';
      optionsInput.placeholder = sel.value === 'select' ? '选项，用逗号分隔' : '—';
    };
  });
}
function addCustomField() {
  const key = `f_${Date.now().toString(36)}`;
  state.fieldsDraft.push({ key, label: '', type: 'text', builtin: false });
  renderFieldList();
  const rows = $$('#fieldList .field-row');
  rows[rows.length - 1]?.querySelector('.f-label')?.focus();
}
async function restoreDefaultFields() {
  try {
    const result = await api('/api/account-fields/restore-defaults', { method: 'POST' });
    state.fieldConfig = result.fields;
    state.fieldsDraft = null;
    renderSettingsPage();
    toast('内置字段已恢复');
  } catch (err) { toast(`恢复失败：${err.message}`); }
}
async function saveFieldConfig() {
  const fields = $$('#fieldList .field-row').map(row => {
    const draft = state.fieldsDraft[Number(row.dataset.index)];
    const label = row.querySelector('.f-label').value.trim();
    const type = draft.builtin ? draft.type : row.querySelector('.f-type').value;
    const options = row.querySelector('.f-options').value
      .split(/[,，]/).map(s => s.trim()).filter(Boolean);
    return {
      key: draft.key, label: label || draft.label || draft.key,
      type, builtin: !!draft.builtin, required: !!draft.required,
      options: type === 'select' ? options : undefined,
    };
  }).filter(f => f.builtin || f.label);
  try {
    const result = await api('/api/account-fields', { method: 'POST', body: JSON.stringify({ fields }) });
    state.fieldConfig = result.fields;
    state.fieldsDraft = null;
    renderSettingsPage();
    toast('字段设置已保存');
  } catch (err) { toast(`保存失败：${err.message}`); }
}
function renderPlatformManager() {
  $('#platformList').innerHTML = state.platforms.map(p => {
    const locked = state.collectSupported.includes(p);
    return `<span class="pf-toggle on">${esc(p)}${locked ? '' : ` <b class="pf-remove" data-pf="${esc(p)}">✕</b>`}</span>`;
  }).join('');
  $$('#platformList .pf-remove').forEach(btn => {
    btn.onclick = () => {
      state.platforms = state.platforms.filter(p => p !== btn.dataset.pf);
      renderPlatformManager();
    };
  });
}
function addPlatform() {
  const name = $('#newPlatformInput').value.trim();
  if (!name) return;
  if (state.platforms.includes(name)) { toast('平台已存在'); return; }
  state.platforms.push(name);
  $('#newPlatformInput').value = '';
  renderPlatformManager();
}
async function savePlatforms() {
  try {
    const result = await api('/api/platforms', { method: 'POST', body: JSON.stringify({ platforms: state.platforms }) });
    state.platforms = result.platforms;
    renderPlatformSelects();
    renderPlatformManager();
    toast('平台设置已保存');
  } catch (err) { toast(`保存失败：${err.message}`); }
}

/* ---------- 作品 ---------- */
async function loadWorks() {
  const params = new URLSearchParams();
  if (state.search) params.set('search', state.search);
  if ($('#workPlatformFilter').value) params.set('platform', $('#workPlatformFilter').value);
  params.set('sort', $('#workSort').value);
  const data = await api(`/api/works?${params.toString()}`);
  state.works = data.data;
  $('#workStats').textContent = `共 ${data.data.length} 条`;
  $('#worksTable').innerHTML = data.data.map(w => `
    <tr>
      <td><div class="cell-main"><div class="titles">
        <strong title="${esc(w.title)}">${esc(short(w.title, 46) || '-')}</strong>
        <span>${esc(w.platform || '-')}${w.work_no ? ` · ${esc(w.work_no)}` : ''}</span>
      </div></div></td>
      <td>${esc(w.account_name || '-')}</td>
      <td>${timeText(w.published_at || w.publish_date)}</td>
      <td>${timeText(w.collected_at)}</td>
      <td class="num">${fmt(w.likes)}</td>
      <td class="num">${fmt(w.comments)}</td>
      <td class="num">${fmt(w.favorites)}</td>
      <td class="num">${fmt(w.shares)}</td>
      <td class="num">${fmt(w.plays)}</td>
      <td class="actions">${w.work_url ? `<a href="${esc(w.work_url)}" target="_blank">打开</a>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="10" class="empty-cell">暂无作品，去采集中心采集</td></tr>';
}

/* ---------- 账号管理与账号标签 ---------- */
const LOGIN_PLATFORMS = [
  ['抖音', '创作者中心'],
  ['快手', '创作者服务平台'],
  ['小红书', '创作服务平台'],
  ['B站', '哔哩哔哩创作中心'],
  ['咸鱼', '闲置发布与管理'],
];

// state.wsTabs: 已打开账号 id 数组；state.wsActive: 'accounts' 或账号 id
function wsAccount(id) { return state.accounts.find(a => a.id === Number(id)); }
function tabAccount(id) { return state.loginSessions.get(Number(id)) || wsAccount(id); }
function statusRing(a) {
  const s = loginStatus(a);
  return s === '已登录' ? 'ring-ok' : (s === '登录失效' || s === '待登录') ? 'ring-warn' : 'ring-off';
}
function renderWorkspaceViews() {
  renderSideAccounts();
  renderWorkspaceTabs();
  renderWorkspaceHead();
  const manager = state.wsActive === 'accounts';
  $('#accountManagerPanel').hidden = !manager;
  $('#wsStage').hidden = manager;
}
function renderSideAccounts() {
  const el = $('#sideAccounts');
  if (!el) return;
  el.innerHTML = state.accounts.map(a => {
    const visual = accountVisualState(a);
    const isActive = state.view === 'accounts' && state.wsActive === a.id;
    const syncText = profileSyncText(a);
    const syncDetail = AccountVisuals.stripRepeatedStatus(syncText, visual.status);
    const accessibleText = `${a.platform || '未知平台'} · ${a.account_name || '未命名账号'} · ${visual.status}${syncDetail ? ` · ${syncDetail}` : ''}`;
    return `
    <div class="side-acc ${visual.className} ${isActive ? 'active' : ''}"
      data-id="${a.id}">
      <button type="button" class="side-acc-open"
        ${isActive ? 'aria-current="page"' : ''} aria-label="${esc(accessibleText)}" title="${esc(accessibleText)}">
        <span class="ring ${statusRing(a)}">${avatar(a)}</span>
        <span class="side-acc-name">${esc(a.account_name || '-')}</span>
      </button>
      <button type="button" class="side-drag-handle" aria-label="调整${esc(a.account_name || '账号')}顺序" title="拖拽排序；方向键上下移动">⋮⋮</button>
    </div>
  `;
  }).join('');
  el.querySelectorAll('.side-acc').forEach(row => {
    const id = Number(row.dataset.id);
    row.querySelector('.side-acc-open').addEventListener('click', () => openWorkspaceTab(id));
    row.querySelector('.side-drag-handle').addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      moveSidebarAccount(id, event.key === 'ArrowUp' ? -1 : 1);
    });
  });
  enableDragSort(el, '.side-acc', saveSidebarOrder, { handleSelector: '.side-drag-handle' });
}
function renderWorkspaceTabs() {
  const managerTab = $('#accountManagerTab');
  managerTab?.classList.toggle('active', state.wsActive === 'accounts');
  if (managerTab) {
    if (state.wsActive === 'accounts') managerTab.setAttribute('aria-current', 'page');
    else managerTab.removeAttribute('aria-current');
  }
  const strip = $('#wsTabStrip');
  strip.innerHTML = state.wsTabs.map(id => {
    const pending = state.loginSessions.get(Number(id));
    const a = pending || wsAccount(id);
    if (!a) return '';
    const visual = pending ? { className: 'login-pending', status: '等待登录' } : accountVisualState(a);
    const isActive = state.wsActive === id;
    const tabName = pending ? `${a.platform} · 登录中` : (a.account_name || '-');
    const accessibleText = `${a.platform || '未知平台'} · ${tabName} · ${visual.status}`;
    return `
    <span class="ws-acc-tab ${visual.className} ${isActive ? 'active' : ''}" data-id="${id}">
      <button type="button" class="ws-acc-tab-main" aria-label="${esc(accessibleText)}" title="${esc(accessibleText)}"
        ${isActive ? 'aria-current="page"' : ''} onclick="activateWorkspaceTab(${id})">
        ${platformMark(a.platform)}<span class="ws-acc-tab-name">${esc(tabName)}</span>
      </button>
      <button type="button" class="ws-acc-tab-close" aria-label="关闭${esc(tabName)}" title="关闭"
        onclick="closeWorkspaceTabUi(${id})">×</button>
    </span>`;
  }).join('');
}
function renderWorkspaceHead() {
  const pending = typeof state.wsActive === 'number' ? state.loginSessions.get(state.wsActive) : null;
  const active = typeof state.wsActive === 'number' ? (pending || wsAccount(state.wsActive)) : null;
  $('#wsAccountName').textContent = active ? (active.account_name || '-') : '未选择账号';
  $('#wsAccountMeta').textContent = active
    ? `${active.platform || '-'} · ${pending ? '等待登录' : loginStatus(active)}`
    : '从账号管理或左侧列表打开账号';
  const sync = active ? state.profileSync.get(active.id) : null;
  const syncStatus = $('#wsProfileStatus');
  if (syncStatus) {
    syncStatus.textContent = pending
      ? (pending.status === 'syncing' ? '正在同步账号资料…' : (pending.message || '登录成功后将自动添加账号'))
      : (active ? profileSyncLabel(active) : '');
    syncStatus.title = pending?.message || sync?.message || '';
    syncStatus.dataset.status = pending?.status || sync?.status || '';
  }
  const syncButton = $('#wsSyncProfile');
  if (syncButton) {
    syncButton.style.display = pending ? 'none' : '';
    syncButton.disabled = !active || sync?.status === 'syncing';
    syncButton.textContent = sync?.status === 'syncing' ? '同步中…' : '重新同步资料';
  }
  const targetTabs = $('.ws-tabs');
  if (targetTabs) targetTabs.style.display = pending ? 'none' : '';
  $$('.ws-tab').forEach(t => t.classList.toggle('active', t.dataset.target === state.wsTarget));
}
function openAccountManager() {
  state.wsActive = 'accounts';
  setView('accounts');
  activateWorkspaceTab('accounts');
}

// 切换顶部标签：'accounts' 显示账号管理，账号 id 显示对应平台页面
function activateWorkspaceTab(tab) {
  // 上次加载失败的标签：点击时走重载而不是只聚焦
  if (typeof tab === 'number' && state.wsLoadFailed.has(tab)) { openWorkspaceTab(tab); return; }
  state.wsActive = tab;
  const isManager = tab === 'accounts';
  $('#accountManagerPanel').hidden = !isManager;
  $('#wsStage').hidden = isManager;
  if (isManager) {
    window.accountConsole?.hideEmbedded?.();
  } else {
    window.accountConsole?.switchWorkspaceTab?.(tab);
    requestAnimationFrame(syncEmbeddedBounds);
    if (state.loginSessions.has(Number(tab))) scheduleLoginInspection(tab);
    else scheduleProfileSync(tab);
  }
  renderWorkspaceTabs();
  renderWorkspaceHead();
  renderSideAccounts();
}
// 打开/聚焦账号标签：已打开只聚焦不刷新；带 target 则加载对应页面
async function openWorkspaceTab(id, target = null) {
  const account = wsAccount(id);
  if (!account) { toast('账号不存在'); return; }
  if (state.view !== 'accounts') setView('accounts');
  if (!window.accountConsole?.openEmbedded) {
    try {
      const r = await api(`/api/accounts/${id}/open`, { method: 'POST', body: JSON.stringify({ target: target || state.wsTarget }) });
      toast(`已在外部浏览器打开：${r.platform}`);
    } catch (err) { toast(`打开失败：${err.message}`); }
    return;
  }
  const exists = state.wsTabs.includes(id);
  const retryLoad = exists && state.wsLoadFailed.has(id);
  if (!exists) {
    state.wsTabs.push(id);
    if (state.wsTabs.length === 7) toast('已打开 7 个账号标签，标签多了会占内存，不用的可以点 × 关掉');
  }
  state.wsActive = id;
  $('#accountManagerPanel').hidden = true;
  $('#wsStage').hidden = false;
  renderWorkspaceTabs(); renderWorkspaceHead(); renderSideAccounts();
  try {
    if (!exists || target || retryLoad) {
      // 新标签一律直开发布页（对齐创作罐头：点账号=开工发布）；已开标签带 target 才换页
      const useTarget = target || (exists ? state.wsTarget : 'publish');
      state.wsTarget = useTarget;
      const info = await api(`/api/accounts/${id}/workspace-info`, {
        method: 'POST', body: JSON.stringify({ target: useTarget }),
      });
      requestAnimationFrame(syncEmbeddedBounds);
      const result = await window.accountConsole.openEmbedded({ ...info, navigate: exists });
      if (result && result.ok === false) {
        state.wsLoadFailed.add(id);
        toast(result.message || '页面加载失败，点击账号标签可重试');
      } else {
        state.wsLoadFailed.delete(id);
      }
      renderWorkspaceHead();
    } else {
      await window.accountConsole.switchWorkspaceTab(id);
      requestAnimationFrame(syncEmbeddedBounds);
    }
    scheduleProfileSync(id);
  } catch (err) { toast(`打开失败：${err.message}`); }
}
async function closeWorkspaceTabUi(id) {
  if (state.loginSessions.has(Number(id))) {
    await cancelLoginSession(Number(id));
    return;
  }
  await window.accountConsole?.closeWorkspaceTab?.(id);
  clearProfileTimers(id);
  const index = state.wsTabs.indexOf(id);
  state.wsTabs = state.wsTabs.filter(t => t !== id);
  if (state.wsActive === id) {
    const next = state.wsTabs[index] ?? state.wsTabs[index - 1];
    activateWorkspaceTab(next ?? 'accounts');
  } else {
    renderWorkspaceTabs();
  }
}
function openAccountWorkspace(id, target = 'publish') {
  openWorkspaceTab(id, target);
}
// 切换 发布/作品/主页：作用于当前激活标签
function setWorkspaceTarget(target) {
  if (typeof state.wsActive !== 'number') { toast('请先打开一个账号'); return; }
  openWorkspaceTab(state.wsActive, target);
}
async function navigateWorkspace(action) {
  if (!window.accountConsole?.navigateEmbedded) { toast('请在桌面端使用'); return; }
  try {
    const r = await window.accountConsole.navigateEmbedded(action);
    if (!r.ok) throw new Error(r.message || '账号页面未打开');
  } catch (err) { toast(err.message); }
}
function syncEmbeddedBounds() {
  if (!window.accountConsole?.setEmbeddedBounds) return;
  // 不在账号标签页或停在账号管理时主动隐藏，避免内嵌浏览器覆盖其它页面。
  if (state.view !== 'accounts' || typeof state.wsActive !== 'number') {
    window.accountConsole.hideEmbedded?.();
    return;
  }
  const host = $('#embedHost');
  if (!host) return;
  const r = host.getBoundingClientRect();
  window.accountConsole.setEmbeddedBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}

function renderPlatformPicker() {
  const forCollectTarget = state.platformPickerMode === 'collect';
  $('#platformPickerTitle').textContent = forCollectTarget ? '登录新账号' : '添加账号';
  $('#platformPickerTitle').nextElementSibling.textContent = forCollectTarget
    ? '已有账号不需要重新登录。仅在列表中没有目标账号时，选择平台登录新账号。'
    : '选择要登录的平台，登录成功后账号会自动加入列表。';
  $('.platform-picker-note').style.display = forCollectTarget ? 'none' : '';
  const grid = $('#platformPickerGrid');
  const platforms = forCollectTarget
    ? LOGIN_PLATFORMS.filter(([platform]) => state.collectSupported.includes(platform))
    : LOGIN_PLATFORMS;
  grid.innerHTML = platforms.map(([platform, note]) => `
    <button type="button" class="platform-option" data-platform="${esc(platform)}"
      aria-label="${esc(`${platform} · ${note}`)}">
      ${platformMark(platform)}
      <strong>${esc(platform)}</strong>
      <em>${esc(note)}</em>
    </button>
  `).join('');
  grid.querySelectorAll('.platform-option').forEach(button => {
    button.addEventListener('click', () => startAccountLogin(button.dataset.platform, state.platformPickerMode));
  });
}

function openPlatformPicker(options = {}) {
  closeDrawers();
  state.platformPickerMode = options?.mode === 'collect' ? 'collect' : 'account';
  renderPlatformPicker();
  $('#platformPicker').hidden = false;
  $('#overlay').hidden = false;
  requestAnimationFrame(() => $('#platformPicker .platform-option')?.focus());
}

function closePlatformPicker() {
  $('#platformPicker').hidden = true;
  if ($('#collectTargetPicker').hidden && !$('#accountEditor').classList.contains('open')) $('#overlay').hidden = true;
}

async function startAccountLogin(platform, mode = state.platformPickerMode) {
  const addToCollectTargets = mode === 'collect';
  if (!window.accountConsole?.beginAccountLogin) {
    toast('自动登录接入仅支持桌面版，可使用手动录入');
    return;
  }
  closePlatformPicker();
  try {
    const session = await window.accountConsole.beginAccountLogin({ platform, addToCollectTargets });
    if (!session?.ok) throw new Error(session?.message || '登录页面加载失败');
    const id = Number(session.account_id);
    state.loginSessions.set(id, {
      ...session,
      id,
      account_name: `${platform} · 登录中`,
      login_status: '待登录',
      status: 'waiting',
      message: '请在平台页面完成登录',
      addToCollectTargets: session.add_to_collect_targets === true,
    });
    if (!state.wsTabs.includes(id)) state.wsTabs.push(id);
    state.wsActive = id;
    state.wsTarget = 'home';
    setView('accounts');
    renderWorkspaceViews();
    requestAnimationFrame(syncEmbeddedBounds);
    requestAnimationFrame(syncEmbeddedBounds);
    scheduleLoginInspection(id);
  } catch (err) {
    toast(`添加账号失败：${err.message}`);
  }
}

function clearLoginTimers(accountId) {
  (state.loginTimers.get(Number(accountId)) || []).forEach(timer => window.clearTimeout(timer));
  state.loginTimers.delete(Number(accountId));
}

function scheduleLoginInspection(accountId, delay = 1200) {
  const id = Number(accountId);
  if (!state.loginSessions.has(id) || !window.accountConsole?.extractProfile) return;
  clearLoginTimers(id);
  const timer = window.setTimeout(async () => {
    const done = await inspectLoginSession(id);
    // 扫码或验证码登录可能耗时数分钟；只要登录标签仍开着就继续低频确认。
    if (!done && state.loginSessions.has(id)) scheduleLoginInspection(id, 3000);
  }, delay);
  state.loginTimers.set(id, [timer]);
}

async function inspectLoginSession(accountId) {
  const id = Number(accountId);
  const pending = state.loginSessions.get(id);
  if (!pending || state.loginInspecting.has(id)) return false;
  state.loginInspecting.add(id);
  try {
    const lifecycle = await window.accountConsole.inspectAccountLogin({
      account_id: id,
      platform: pending.platform,
      partition: pending.partition,
      url: pending.url,
      add_to_collect_targets: pending.addToCollectTargets === true,
    });
    if (!lifecycle?.ok || lifecycle.status === 'error') {
      pending.status = 'error';
      pending.message = lifecycle?.message || '登录资料同步失败';
      renderWorkspaceHead();
      return false;
    }
    if (lifecycle.status !== 'completed') {
      pending.status = lifecycle.status || 'checking';
      pending.message = lifecycle.message || '正在确认登录状态…';
      renderWorkspaceHead();
      return false;
    }
    const addToCollectTargets = pending.addToCollectTargets === true;
    const completed = lifecycle;
    const finalId = Number(completed.account_id);
    const adopted = completed.adopted !== false;
    if (!adopted) {
      try { await window.accountConsole.closeWorkspaceTab?.(id); } catch { /* 随后用正式账号 id 重开 */ }
      state.wsLoadFailed.add(finalId);
    }
    clearLoginTimers(id);
    state.loginSessions.delete(id);
    state.wsTabs = [...new Set(state.wsTabs.map(tabId => (tabId === id ? finalId : tabId)))];
    state.wsActive = finalId;
    await loadAccounts();
    setProfileSyncState(finalId, completed.account?.avatar_url ? 'synced' : 'error',
      completed.account?.avatar_url ? '' : '账号已添加，头像待同步');
    renderWorkspaceViews();
    requestAnimationFrame(syncEmbeddedBounds);
    if (!adopted) await openWorkspaceTab(finalId, 'home');
    toast(addToCollectTargets
      ? (completed.merged ? '账号已存在，资料已更新并加入采集目标' : '登录成功，账号已加入采集目标')
      : (completed.merged ? '账号已存在，登录状态和资料已更新' : '登录成功，账号已自动添加'));
    if (!completed.account?.avatar_url || !completed.account?.profile_nickname) scheduleProfileSync(finalId);
    return true;
  } catch (err) {
    if (pending) { pending.status = 'error'; pending.message = `同步失败：${err.message}`; }
    renderWorkspaceHead();
    return false;
  } finally {
    state.loginInspecting.delete(id);
  }
}

async function cancelLoginSession(accountId) {
  const id = Number(accountId);
  const pending = state.loginSessions.get(id);
  if (!pending) return;
  clearLoginTimers(id);
  try {
    await window.accountConsole?.cancelAccountLogin?.({ account_id: id, partition: pending.partition });
  } catch { /* 已失效时直接清理本地状态 */ }
  const index = state.wsTabs.indexOf(id);
  state.loginSessions.delete(id);
  state.wsTabs = state.wsTabs.filter(tabId => tabId !== id);
  if (state.wsActive === id) {
    const next = state.wsTabs[index] ?? state.wsTabs[index - 1] ?? 'accounts';
    activateWorkspaceTab(next);
  } else renderWorkspaceTabs();
}
function profileSyncText(account) {
  if (!account) return '';
  const live = state.profileSync.get(account.id);
  if (live?.status === 'syncing') return '资料同步中…';
  if (live?.status === 'waiting') return '等待登录';
  if (live?.status === 'error') {
    const prefix = loginStatus(account) === '已登录' ? '已登录 · ' : '';
    return `${prefix}资料待同步${live.message ? `（${live.message}）` : ''}`;
  }
  if (live?.status === 'synced') return '已登录 · 资料已同步';
  if (loginStatus(account) === '已登录' && !account.avatar_url) return '已登录 · 资料待同步';
  return loginStatus(account);
}
function profileSyncLabel(account) {
  if (!account) return '';
  const live = state.profileSync.get(account.id);
  if (live?.status === 'syncing') return '资料同步中…';
  if (live?.status === 'waiting') return '等待登录';
  if (live?.status === 'error') return '资料待同步';
  if (live?.status === 'synced') return '资料已同步';
  return loginStatus(account) === '已登录' && !account.avatar_url ? '资料待同步' : '';
}
function setProfileSyncState(accountId, status, message = '') {
  state.profileSync.set(Number(accountId), { status, message });
  renderWorkspaceHead();
  renderSideAccounts();
}
function clearProfileTimers(accountId = null) {
  const ids = accountId == null ? Array.from(state.profileTimers.keys()) : [Number(accountId)];
  ids.forEach(id => {
    (state.profileTimers.get(id) || []).forEach(timer => window.clearTimeout(timer));
    state.profileTimers.delete(id);
  });
}
function scheduleProfileSync(accountId) {
  if (!window.accountConsole?.extractProfile || !accountId) return;
  const id = Number(accountId);
  clearProfileTimers(id);
  const timers = [1200, 4500, 10000].map(delay => window.setTimeout(() => {
      if (state.wsActive === id && state.view === 'accounts' && !state.loginSessions.has(id)) {
        syncWorkspaceProfile({ silent: true, accountId: id });
      }
    }, delay));
  state.profileTimers.set(id, timers);
}
function cleanProfileTitle(t) {
  return String(t || '').replace(/\s*[-_|].*$/, '').replace(/创作者中心|登录|扫码|首页|工作台/g, '').trim().slice(0, 80);
}
// 账号平台页是登录页时，把真实登录状态写回账号（曾登录过的标记为「登录失效」）
async function markLoginState(accountId, before) {
  const wasIn = before?.login_status === '已登录' || before?.login_status === '登录失效';
  const next = wasIn ? '登录失效' : '未登录';
  if (!before || before.login_status === next) {
    setProfileSyncState(accountId, 'waiting');
    return;
  }
  try {
    const r = await api(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify({ login_status: next }) });
    state.accounts = state.accounts.map(a => (a.id === accountId ? { ...a, ...r.account } : a));
    renderWorkspaceViews();
    setProfileSyncState(accountId, 'waiting');
  } catch { /* 静默 */ }
}
async function markLoggedIn(accountId, before) {
  if (!before || before.login_status === '已登录') return before;
  try {
    const r = await api(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify({ login_status: '已登录' }) });
    state.accounts = state.accounts.map(a => (a.id === accountId ? { ...a, ...r.account } : a));
    return r.account;
  } catch {
    return before;
  }
}
// 创作者中心拿不到可信头像时，后台用登录态打开公开主页补拉（每账号每次会话最多一次）
async function fetchProfileFromHomepage(account, { force = false } = {}) {
  if (!window.accountConsole?.fetchHomepageProfile || !account?.homepage_url) return null;
  if (!force && state.homepageFetched.has(account.id)) return null;
  state.homepageFetched.add(account.id);
  try {
    const profile = await window.accountConsole.fetchHomepageProfile({
      account_id: account.id,
      url: account.homepage_url,
      partition: account.browser_partition,
    });
    if (!profile?.ok) return null;
    const avatarGood = profile.avatar_url && Number(profile.avatar_score || 0) >= 8;
    const nickname = cleanProfileTitle(profile.nickname);
    if (avatarGood || nickname) return { ...profile, avatar_url: avatarGood ? profile.avatar_url : '', nickname };
  } catch { /* 后台补拉失败不打扰 */ }
  return null;
}

async function resolveAccountHomepage(account) {
  const id = Number(account?.id);
  const invalidKuaishouIdentity = account?.platform === '快手'
    && /^\d+$/.test(String(account?.platform_account_id || ''))
    && /\/profile\/\d+/.test(String(account?.homepage_url || ''));
  if (!Number.isFinite(id) || (account?.homepage_url && !invalidKuaishouIdentity)
    || state.homepageResolving.has(id)) return false;
  state.homepageResolving.add(id);
  if (state.view === 'collect') renderCollectTargetRows();
  try {
    const source = await api(`/api/accounts/${id}/profile-source`);
    const profile = await window.accountConsole.discoverProfile({
      account_id: id,
      url: source.url,
      partition: source.partition,
      require_identity: true,
    });
    if (!profile?.ok || !profile.homepage_url || !profile.platform_account_id) return false;
    if (profile.platform && account.platform && profile.platform !== account.platform) return false;
    const result = await api(`/api/accounts/${id}/discovered-identity`, {
      method: 'POST',
      body: JSON.stringify({
        homepage_url: profile.homepage_url,
        platform_account_id: profile.platform_account_id,
      }),
    });
    state.accounts = state.accounts.map(item => (item.id === id ? { ...item, ...result.account } : item));
    renderWorkspaceViews();
    if (state.view === 'collect') renderCollectTargetRows();
    return true;
  } catch { /* 后台自动识别失败时保留现状，稍后低频重试 */
    return false;
  } finally {
    state.homepageResolving.delete(id);
    if (state.view === 'collect') renderCollectTargetRows();
  }
}

function queueMissingHomepageBackfill() {
  if (!window.accountConsole?.discoverProfile) return;
  const candidates = state.accounts.filter(account => {
    const invalidKuaishouIdentity = account?.platform === '快手'
      && /^\d+$/.test(String(account?.platform_account_id || ''))
      && /\/profile\/\d+/.test(String(account?.homepage_url || ''));
    return (!String(account.homepage_url || '').trim() || invalidKuaishouIdentity)
      && loginStatus(account) === '已登录';
  });
  candidates.forEach(account => {
    const id = Number(account.id);
    const attempts = Number(state.homepageResolveAttempts.get(id) || 0);
    if (attempts >= 2 || state.homepageResolving.has(id) || state.homepageResolveQueued.has(id)) return;
    state.homepageResolveAttempts.set(id, attempts + 1);
    state.homepageResolveQueued.add(id);
    state.homepageResolveQueue = state.homepageResolveQueue.then(async () => {
      try {
        const latest = state.accounts.find(item => item.id === id);
        const invalidKuaishouIdentity = latest?.platform === '快手'
          && /^\d+$/.test(String(latest?.platform_account_id || ''))
          && /\/profile\/\d+/.test(String(latest?.homepage_url || ''));
        if (!latest || (latest.homepage_url && !invalidKuaishouIdentity)) return;
        const resolved = await resolveAccountHomepage(latest);
        if (!resolved && attempts === 0) {
          window.setTimeout(queueMissingHomepageBackfill, 15000);
        }
      } finally {
        state.homepageResolveQueued.delete(id);
      }
    });
  });
}
async function syncWorkspaceProfile(options = {}) {
  const { silent = false, accountId = (typeof state.wsActive === 'number' ? state.wsActive : null) } = options;
  if (!accountId) { if (!silent) toast('请先打开一个账号'); return false; }
  if (!window.accountConsole?.extractProfile) { if (!silent) toast('请在桌面端使用'); return false; }
  if (silent && state.profileSync.get(accountId)?.status === 'syncing') return false;
  let before = state.accounts.find(a => a.id === accountId);
  setProfileSyncState(accountId, 'syncing');
  try {
    const profile = await window.accountConsole.extractProfile(accountId);
    if (!profile?.ok) {
      if (profile?.reason === 'login-page') await markLoginState(accountId, before);
      else setProfileSyncState(accountId, 'error', profile?.message || '未读取到资料');
      if (silent) return false;
      throw new Error(profile?.message || (profile?.reason === 'login-page' ? '当前仍是登录页' : '未读取到页面资料'));
    }
    if (profile.login_status === '已登录') before = await markLoggedIn(accountId, before);
    const payload = {};
    let avatarVerified = false;
    // 创作者中心只接收平台规则命中的可信头像；首次自动同步可修复旧头像。
    const goodAvatar = profile.avatar_url && Number(profile.avatar_score || 0) >= 12;
    if (goodAvatar && (!silent || !state.profileSyncedThisSession.has(accountId) || !before?.avatar_url)) {
      payload.avatar_url = profile.avatar_url;
      avatarVerified = true;
    }
    const nickname = cleanProfileTitle(profile.nickname);
    if (nickname && nickname.length >= 2) payload.profile_nickname = nickname;
    if (profile.homepage_url) payload.homepage_url = profile.homepage_url;
    if (profile.platform_account_id) payload.platform_account_id = profile.platform_account_id;
    // 当前页（多为创作者中心）拿不到可信头像：后台打开公开主页补拉一次
    if ((!payload.avatar_url || !payload.profile_nickname) && (!silent || !state.homepageFetched.has(accountId))) {
      const fromHome = await fetchProfileFromHomepage(before, { force: !silent });
      if (fromHome) {
        if (!payload.avatar_url && fromHome.avatar_url) {
          payload.avatar_url = fromHome.avatar_url;
          avatarVerified = true;
        }
        if (!payload.profile_nickname) {
          const homeNick = fromHome.nickname;
          if (homeNick && homeNick.length >= 2) payload.profile_nickname = homeNick;
        }
        if (!payload.homepage_url && fromHome.homepage_url) payload.homepage_url = fromHome.homepage_url;
        if (!payload.platform_account_id && fromHome.platform_account_id) {
          payload.platform_account_id = fromHome.platform_account_id;
        }
      }
    }
    if (!payload.avatar_url && !payload.profile_nickname && !payload.homepage_url && !payload.platform_account_id) {
      setProfileSyncState(accountId, 'error', '未识别到头像或昵称');
      if (silent) return false;
      throw new Error('没有识别到头像或昵称，请检查账号主页链接');
    }
    const result = await api(`/api/accounts/${accountId}/profile`, { method: 'POST', body: JSON.stringify(payload) });
    state.accounts = state.accounts.map(a => (a.id === accountId ? { ...a, ...result.account } : a));
    const avatarComplete = Boolean(result.account.avatar_url) && (avatarVerified || state.profileSyncedThisSession.has(accountId));
    const identityComplete = Boolean(result.account.homepage_url && result.account.platform_account_id);
    const profileComplete = avatarComplete && identityComplete;
    if (profileComplete) {
      state.profileSyncedThisSession.add(accountId);
      clearProfileTimers(accountId);
      setProfileSyncState(accountId, 'synced');
    } else {
      setProfileSyncState(accountId, 'error', identityComplete ? '昵称已更新，头像仍未识别' : '资料已更新，主页链接仍在识别');
    }
    renderWorkspaceViews();
    const avatarChanged = payload.avatar_url && before?.avatar_url !== result.account.avatar_url;
    if (!silent || avatarChanged) {
      toast(profileComplete
        ? (avatarChanged ? '头像和账号资料已更新' : '账号资料已同步')
        : (identityComplete ? '昵称已更新，头像仍待同步' : '资料已更新，主页链接仍在识别'));
    }
    return profileComplete;
  } catch (err) {
    if (state.profileSync.get(accountId)?.status === 'syncing') setProfileSyncState(accountId, 'error', err.message);
    if (!silent) toast(`同步资料失败：${err.message}`);
    return false;
  }
}

/* ---------- 采集中心 ---------- */
async function loadCollectCenter() {
  try {
    state.collectConfig = await api('/api/collect/config');
  } catch { /* 后端旧版无此接口时用默认 */ }
  renderCollectConfig();
  renderLoginPlatforms();
  await Promise.all([loadCollectTargets(), loadCollectHistory()]);
}
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function nextRunText(c) {
  if (!c.auto_enabled) return '';
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number(c.hour) || 0, Number(c.minute) || 0, 0, 0);
  if (c.frequency === 'weekly') {
    const wd = Number(c.weekday) || 0;
    let add = (wd - now.getDay() + 7) % 7;
    if (add === 0 && next <= now) add = 7;
    next.setDate(next.getDate() + add);
  } else if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `下次自动采集：${pad(next.getMonth() + 1)}-${pad(next.getDate())} ${pad(next.getHours())}:${pad(next.getMinutes())}`;
}
function renderCollectConfig() {
  const c = state.collectConfig;
  $('#autoToggle').checked = !!c.auto_enabled;
  $('#freqSelect').value = c.frequency === 'weekly' ? 'weekly' : 'daily';
  $('#weekdaySelect').value = String(c.weekday ?? 1);
  $('#weekdaySelect').style.display = c.frequency === 'weekly' ? '' : 'none';
  $('#collectTimeInput').value = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
  $('#scanLimitInput').value = c.scan_limit ?? 20;
  $('#showBrowserToggle').checked = c.show_browser !== false;
  $('#nextRunNote').textContent = nextRunText(c);
  $('#platformToggles').innerHTML = state.platforms.map(p => {
    const supported = state.collectSupported.includes(p);
    const on = (c.platforms || []).includes(p);
    return `<button class="pf-toggle ${on ? 'on' : ''} ${supported ? '' : 'disabled'}" data-pf="${p}" ${supported ? '' : 'disabled'}>${p}${supported ? '' : ' (待开放)'}</button>`;
  }).join('');
  $$('#platformToggles .pf-toggle:not(.disabled)').forEach(btn => {
    btn.onclick = () => {
      const pf = btn.dataset.pf;
      const set = new Set(state.collectConfig.platforms || []);
      set.has(pf) ? set.delete(pf) : set.add(pf);
      state.collectConfig.platforms = [...set];
      renderCollectConfig();
    };
  });
}
function renderLoginPlatforms() {
  $('#loginPlatforms').innerHTML = state.collectSupported.map(p => `
    <div class="login-item">
      <div class="li-main"><span class="avatar"><span class="pf ${PF_CLASS[p]}">${PF_SHORT[p]}</span></span>
        <span class="li-name">${p}</span></div>
      <button class="btn mini subtle" onclick="openCollectLogin('${p}')">登录小号</button>
    </div>
  `).join('');
}
async function openCollectLogin(platform) {
  if (!window.accountConsole?.collectOpenLogin) { toast('请在桌面端使用采集浏览器'); return; }
  await window.accountConsole.collectOpenLogin(platform);
  toast(`已打开 ${platform} 采集浏览器，请用采集专用小号登录`);
}
function renderCollectTargetRows() {
  const list = state.accounts.filter(a => state.collectTargetIds.has(Number(a.id)));
  $('#collectTargets').innerHTML = list.map(a => {
    const hasUrl = a.homepage_url && String(a.homepage_url).trim();
    const invalidKuaishouIdentity = a.platform === '快手'
      && /^\d+$/.test(String(a.platform_account_id || ''))
      && /\/profile\/\d+/.test(String(a.homepage_url || ''));
    const canCollect = hasUrl && !invalidKuaishouIdentity && state.collectSupported.includes(a.platform);
    return `
      <tr>
        <td><span class="account-cell">${avatar(a)}<span>${esc(a.account_name || '-')}</span></span></td>
        <td>${statusBadge(a.status)}</td>
        <td>${hasUrl
          ? `<a href="${esc(a.homepage_url)}" target="_blank">${esc(short(a.homepage_url, 40))}</a>`
          : state.homepageResolving.has(Number(a.id))
            ? '<span class="badge">正在自动获取…</span>'
            : '<span class="badge warn">缺主页链接</span>'}</td>
        <td class="num">${fmt(a.works_count)}</td>
        <td class="actions">
          <button class="btn mini primary" onclick="collectAccountData(${a.id})" ${canCollect ? '' : 'disabled'} title="${canCollect ? '' : invalidKuaishouIdentity ? '正在核验快手公开主页' : '该平台暂不支持采集或缺少主页链接'}">采集</button>
          <button class="btn mini subtle" onclick="editAccount(${a.id})">编辑</button>
          <button class="btn mini danger-ghost" onclick="removeCollectTarget(${a.id})">移出</button>
        </td>
      </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-cell">暂无采集目标，点击右上「添加采集目标」从已有账号中选择</td></tr>';
}
async function loadCollectTargets() {
  try {
    const data = await api('/api/collect/targets');
    state.collectTargetIds = new Set((data.data || []).map(a => Number(a.id)));
    renderCollectTargetRows();
  } catch (err) {
    $('#collectTargets').innerHTML = `<tr><td colspan="5" class="empty-cell">加载失败：${esc(err.message)}</td></tr>`;
  }
}
function updateCollectPickerSelection() {
  const selected = $$('#collectAccountChoices input[type="checkbox"]:checked').length;
  const button = $('#addSelectedCollectTargets');
  button.disabled = selected === 0;
  button.textContent = selected ? `添加所选账号（${selected}）` : '添加所选账号';
}
function renderCollectAccountPicker() {
  const supported = state.accounts.filter(a => state.collectSupported.includes(a.platform));
  const available = supported.filter(a => !state.collectTargetIds.has(Number(a.id))).length;
  $('#collectCandidateSummary').textContent = `${supported.length} 个可采集平台账号，${available} 个可添加`;
  $('#collectAccountChoices').innerHTML = supported.map(a => {
    const added = state.collectTargetIds.has(Number(a.id));
    const hasUrl = a.homepage_url && String(a.homepage_url).trim();
    return `
      <label class="collect-account-choice ${added ? 'already-added' : ''}">
        ${avatar(a)}
        <span class="collect-choice-main">
          <strong>${esc(a.account_name || '未命名账号')}</strong>
          <span>${esc(a.platform || '未知平台')} · ${hasUrl ? esc(short(a.homepage_url, 42)) : '缺少主页链接，添加后需补充'}</span>
        </span>
        <span class="collect-choice-state">
          ${added ? '<span class="badge ok">已添加</span>' : `<input type="checkbox" value="${a.id}" aria-label="选择${esc(a.account_name || '账号')}">`}
        </span>
      </label>`;
  }).join('') || '<div class="collect-picker-empty">暂无可直接添加的已有账号，请登录新账号。</div>';
  $$('#collectAccountChoices input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', updateCollectPickerSelection);
  });
  updateCollectPickerSelection();
}
function openCollectTargetPicker() {
  closeDrawers();
  closePlatformPicker();
  renderCollectAccountPicker();
  $('#collectTargetPicker').hidden = false;
  $('#overlay').hidden = false;
  requestAnimationFrame(() => $('#collectAccountChoices input[type="checkbox"]')?.focus());
}
function closeCollectTargetPicker() {
  $('#collectTargetPicker').hidden = true;
  if ($('#platformPicker').hidden && !$('#accountEditor').classList.contains('open')) $('#overlay').hidden = true;
}
async function addSelectedCollectTargets() {
  const accountIds = $$('#collectAccountChoices input[type="checkbox"]:checked').map(input => Number(input.value));
  if (!accountIds.length) return;
  try {
    await api('/api/collect/targets', { method: 'POST', body: JSON.stringify({ account_ids: accountIds }) });
    closeCollectTargetPicker();
    await loadCollectTargets();
    toast(`已添加 ${accountIds.length} 个采集目标`);
  } catch (err) { toast(`添加采集目标失败：${err.message}`); }
}
async function removeCollectTarget(id) {
  const account = state.accounts.find(a => a.id === Number(id));
  try {
    await api(`/api/collect/targets/${id}`, { method: 'DELETE' });
    state.collectTargetIds.delete(Number(id));
    renderCollectTargetRows();
    toast(`已将「${account?.account_name || '账号'}」移出采集目标，账号资料仍保留`);
  } catch (err) { toast(`移出采集目标失败：${err.message}`); }
}
async function removeAccount(id) {
  const a = state.accounts.find(x => x.id === id);
  const name = a?.account_name || `账号 ${id}`;
  if (!window.confirm(`确定删除「${name}」吗？\n该账号及其已采集的作品、数据快照会一并删除，不可撤销。`)) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    if (state.wsTabs.includes(id)) await closeWorkspaceTabUi(id);
    toast('账号已删除');
    await reloadAll();
    if (state.view === 'collect') loadCollectTargets();
  } catch (err) { toast(`删除失败：${err.message}`); }
}
async function loadCollectHistory() {
  try {
    const data = await api('/api/collect/runs?limit=30');
    $('#collectHistory').innerHTML = data.data.map(r => `
      <tr>
        <td>${timeText(r.finished_at || r.started_at)}</td>
        <td>${esc(r.account_name || '-')}</td>
        <td>${esc(r.platform || '-')}</td>
        <td>${r.trigger_source === 'scheduled' ? '定时' : '手动'}</td>
        <td>${r.status === 'success' ? '<span class="badge ok">成功</span>' : `<span class="badge bad">失败</span> <span class="muted">${esc(short(r.error_message, 30))}</span>`}</td>
        <td class="num">${fmt(r.works_updated)}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-cell">暂无采集记录</td></tr>';
  } catch (err) {
    $('#collectHistory').innerHTML = `<tr><td colspan="6" class="empty-cell">加载失败：${esc(err.message)}</td></tr>`;
  }
}
async function saveCollectConfig() {
  const [h, m] = ($('#collectTimeInput').value || '06:00').split(':').map(Number);
  const payload = {
    auto_enabled: $('#autoToggle').checked,
    frequency: $('#freqSelect').value,
    weekday: Number($('#weekdaySelect').value),
    hour: h, minute: m,
    scan_limit: Math.max(5, Math.min(100, Number($('#scanLimitInput').value) || 20)),
    show_browser: $('#showBrowserToggle').checked,
    platforms: state.collectConfig.platforms,
  };
  try {
    state.collectConfig = window.accountConsole?.updateSchedule
      ? await window.accountConsole.updateSchedule(payload)
      : await api('/api/collect/config', { method: 'POST', body: JSON.stringify(payload) });
    renderCollectConfig();
    toast('采集设置已保存');
  } catch (err) { toast(`保存失败：${err.message}`); }
}
function setCollectStatus(text) { const el = $('#collectStatus'); el.hidden = !text; el.textContent = text || ''; }
function setCollectLive(running, title, detail) {
  state.collecting = running;
  const box = $('#collectLive');
  if (!box) return;
  box.hidden = !running;
  if (running) {
    $('#clTitle').textContent = title || '采集中';
    $('#clDetail').textContent = detail || '';
  }
  const runAll = $('#collectRunAll');
  if (runAll) runAll.disabled = running;
}
async function collectAccountData(accountId) {
  if (!window.accountConsole?.collectRun) { toast('数据采集需要在桌面端使用'); return; }
  if (state.collecting) { toast('已有采集任务在运行'); return; }
  setCollectLive(true, '采集准备中…', '');
  try {
    const summary = await window.accountConsole.collectRun({
      trigger: 'manual',
      accountIds: accountId ? [Number(accountId)] : undefined,
    });
    if (!summary?.ok) {
      setCollectLive(false);
      setCollectStatus('');
      toast(summary?.message || '采集失败');
      return;
    }
    setCollectLive(false);
    toast(`采集完成${summary.stopped ? '（已停止）' : ''}：成功 ${summary.success}/${summary.total}，新增 ${summary.inserted}，更新 ${summary.updated}`);
    setCollectStatus(summary.errors?.length ? `部分失败：${summary.errors.join('；')}` : '');
    await refreshCollectedData();
    if (state.view === 'collect') loadCollectTargets();
  } catch (err) { setCollectLive(false); setCollectStatus(''); toast(`采集失败：${err.message}`); }
}
async function stopCollecting() {
  if (!window.accountConsole?.collectStop) return;
  const r = await window.accountConsole.collectStop();
  toast(r?.message || '已请求停止');
}

/* ---------- 编辑抽屉 ---------- */
function openDrawer(id) { $(id).classList.add('open'); $('#overlay').hidden = false; }
function closeDrawers() {
  $$('.drawer').forEach(d => d.classList.remove('open'));
  if ($('#platformPicker').hidden && $('#collectTargetPicker').hidden) $('#overlay').hidden = true;
}
// 根据字段配置动态渲染表单控件
function fieldInputHtml(f, value) {
  const name = f.builtin ? f.key : `cf_${f.key}`;
  const val = value == null ? '' : String(value);
  if (f.type === 'platform') {
    return `<select class="input" name="${name}">${state.platforms.map(p =>
      `<option${p === val ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>`;
  }
  if (f.type === 'select') {
    const options = [...(f.options || [])];
    if (val && !options.includes(val)) options.unshift(val); // 已存值不在选项里也不丢
    return `<select class="input" name="${name}">${options.map(o =>
      `<option${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (f.type === 'textarea') return `<textarea class="input" name="${name}" rows="3">${esc(val)}</textarea>`;
  if (f.type === 'number') return `<input class="input" name="${name}" type="number" value="${esc(val)}">`;
  const placeholder = f.type === 'url' ? 'https://...（抖音可直接粘贴分享口令）' : '';
  return `<input class="input" name="${name}" value="${esc(val)}" placeholder="${placeholder}" ${f.required ? 'required' : ''}>`;
}
function openAccountEditor(account = null) {
  closeDrawers();
  const form = $('#accountForm'); form.reset();
  form.elements.id.value = account?.id || '';
  $('#editorTitle').textContent = account ? '编辑账号' : '新增账号';
  $('#deleteAccountBtn').style.display = account ? '' : 'none';
  const custom = account?.custom_fields || {};
  $('#accountFormFields').innerHTML = state.fieldConfig.map(f => {
    const value = f.builtin ? account?.[f.key] : custom[f.key];
    return `<label>${esc(f.label)}${fieldInputHtml(f, value)}</label>`;
  }).join('');
  openDrawer('#accountEditor');
}
function editAccount(id) { const a = state.accounts.find(x => x.id === id); if (a) openAccountEditor(a); }
async function saveAccount(event) {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(event.target).entries());
  const id = raw.id;
  const payload = {};
  const custom = {};
  state.fieldConfig.forEach(f => {
    if (f.builtin) {
      let v = raw[f.key];
      if (v === undefined) return;
      if (f.type === 'number') v = v === '' ? null : Number(v);
      else if (v === '') v = null;
      payload[f.key] = v;
    } else {
      let v = raw[`cf_${f.key}`];
      if (v === undefined) return;
      if (f.type === 'number' && v !== '') v = Number(v);
      custom[f.key] = v === '' ? null : v;
    }
  });
  // 保留已存但当前配置里不存在的自定义值（字段被删除时不销毁数据）
  const existing = state.accounts.find(a => a.id === Number(id))?.custom_fields || {};
  payload.custom_fields = { ...existing, ...custom };
  try {
    if (id) { await api(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }); toast('账号已更新'); }
    else {
      if (!payload.account_name) { toast('请填写账号名字'); return; }
      await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      toast('账号已创建');
    }
    closeDrawers(); await loadAccounts();
    if (state.view === 'accountDetail' && Number(id) === state.detailAccountId) loadAccountDetail();
    if (state.view === 'collect') loadCollectTargets();
  } catch (err) { toast(`保存失败：${err.message}`); }
}
async function deleteCurrentAccount() {
  const id = $('#accountForm').elements.id.value;
  if (!id) return;
  if (!window.confirm('确定删除这个账号吗？此操作不可撤销。')) return;
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
  if (state.wsTabs.includes(Number(id))) await closeWorkspaceTabUi(Number(id));
  closeDrawers(); toast('账号已删除'); await loadAccounts();
  if (state.view === 'collect') await loadCollectTargets();
}

/* ---------- 全局刷新 ---------- */
async function reloadAll() {
  await Promise.all([loadDashboard(), loadAccounts(), loadWorks()]);
}

async function refreshCollectedData() {
  await Promise.all([loadAccounts(), loadWorks(), loadDashboard(), loadCollectHistory()]);
  if (state.detailAccountId) await loadAccountDetail();
}

/* ---------- 导出给 onclick ---------- */
Object.assign(window, {
  openAccountWorkspace, openWorkspaceTab, activateWorkspaceTab, closeWorkspaceTabUi,
  openAccountManager,
  openAccountDetail, editAccount,
  collectAccountData, removeAccount, removeCollectTarget, closeDrawers, openCollectLogin,
});

/* ---------- 事件 ---------- */
function wireEvents() {
  $$('.nav-item').forEach(b => {
    b.addEventListener('click', () => (b.dataset.view === 'accounts' ? openAccountManager() : setView(b.dataset.view)));
    b.setAttribute('draggable', 'true');
  });
  enableDragSort($('.nav'), '.nav-item', saveNavOrder);
  $('#refreshBtn').addEventListener('click', async () => {
    const btn = $('#refreshBtn');
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '刷新中…';
    try { await reloadAll(); } finally { btn.disabled = false; btn.textContent = original; }
  });
  // 左下角采集状态点击直达采集中心
  $('.sync-box').addEventListener('click', () => setView('collect'));
  $('#rangeSelect').addEventListener('change', async (e) => {
    state.range = Number(e.target.value);
    if (state.view === 'accountDetail') await loadAccountDetail();
    else await loadDashboard();
  });

  // 作品排行指标切换
  $$('#rankTabs button').forEach(btn => btn.addEventListener('click', async () => {
    state.rank = btn.dataset.rank;
    $$('#rankTabs button').forEach(b => b.classList.toggle('active', b === btn));
    await loadDashboard();
  }));

  // 账号详情
  $('#detailBackBtn').addEventListener('click', openAccountManager);
  $('#adCollectBtn').addEventListener('click', () => collectAccountData(state.detailAccountId));
  $('#adWorkspaceBtn').addEventListener('click', () => {
    if (state.detailAccountId) openAccountWorkspace(state.detailAccountId, 'publish');
  });
  $('#adEditBtn').addEventListener('click', () => editAccount(state.detailAccountId));

  // 设置页
  $('#setAutostart').addEventListener('change', applyAutostartSetting);
  $('#setAutostartHidden').addEventListener('change', applyAutostartSetting);
  $('#setCloseBehavior').addEventListener('change', (e) => saveGeneralSettings({ close_to_tray: e.target.value === 'tray' }));
  $('#setNotify').addEventListener('change', (e) => saveGeneralSettings({ notify_on_collect: e.target.checked }));
  $('#openDataDirBtn').addEventListener('click', async () => {
    if (window.accountConsole?.openDataDir) await window.accountConsole.openDataDir();
    else toast('请在桌面端使用');
  });
  $('#backupNowBtn').addEventListener('click', async () => {
    const btn = $('#backupNowBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/backup', { method: 'POST' });
      toast(`备份完成：${r.file}`);
      await loadGeneralSettings();
    } catch (err) { toast(`备份失败：${err.message}`); } finally { btn.disabled = false; }
  });
  $('#addFieldBtn').addEventListener('click', addCustomField);
  $('#restoreFieldsBtn').addEventListener('click', restoreDefaultFields);
  $('#saveFieldsBtn').addEventListener('click', saveFieldConfig);
  $('#addPlatformBtn').addEventListener('click', addPlatform);
  $('#newPlatformInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlatform(); } });
  $('#savePlatformsBtn').addEventListener('click', savePlatforms);

  let searchTimer = null;
  $('#globalSearch').addEventListener('input', (e) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      state.search = e.target.value.trim();
      await Promise.all([loadAccounts(), loadWorks()]);
    }, 250);
  });

  $('#newAccountBtn').addEventListener('click', openPlatformPicker);
  $('#platformFilter').addEventListener('change', loadAccounts);
  $('#statusFilter').addEventListener('change', loadAccounts);
  $('#workPlatformFilter').addEventListener('change', loadWorks);
  $('#workSort').addEventListener('change', loadWorks);

  // 账号标签内的平台页面
  $$('.ws-tab').forEach(t => t.addEventListener('click', () => setWorkspaceTarget(t.dataset.target)));
  $('#wsBack').addEventListener('click', () => navigateWorkspace('back'));
  $('#wsForward').addEventListener('click', () => navigateWorkspace('forward'));
  $('#wsReload').addEventListener('click', () => navigateWorkspace('reload'));
  $('#wsSyncProfile').addEventListener('click', () => syncWorkspaceProfile());

  // 采集中心
  $('#saveCollectCfg').addEventListener('click', saveCollectConfig);
  $('#collectRunAll').addEventListener('click', () => collectAccountData(null));
  $('#collectNewAccount').addEventListener('click', openCollectTargetPicker);
  $('#stopCollectBtn').addEventListener('click', stopCollecting);
  $('#freqSelect').addEventListener('change', () => {
    $('#weekdaySelect').style.display = $('#freqSelect').value === 'weekly' ? '' : 'none';
  });
  $('#setupTaskBtn').addEventListener('click', () => toast('请在项目 scripts 目录运行 setup-collect-schedule.bat'));

  // 平台选择与手动编辑抽屉
  $('#closePlatformPicker').addEventListener('click', closePlatformPicker);
  $('#manualAccountBtn').addEventListener('click', () => {
    closePlatformPicker();
    openAccountEditor();
  });
  $('#closeCollectTargetPicker').addEventListener('click', closeCollectTargetPicker);
  $('#collectLoginNewAccount').addEventListener('click', () => {
    closeCollectTargetPicker();
    openPlatformPicker({ mode: 'collect' });
  });
  $('#addSelectedCollectTargets').addEventListener('click', addSelectedCollectTargets);
  $('#closeAccountEditor').addEventListener('click', closeDrawers);
  $('#overlay').addEventListener('click', () => { closeCollectTargetPicker(); closePlatformPicker(); closeDrawers(); });
  $('#accountForm').addEventListener('submit', saveAccount);
  $('#deleteAccountBtn').addEventListener('click', deleteCurrentAccount);

  window.addEventListener('resize', () => { syncEmbeddedBounds(); if (state.view === 'dashboard') renderCharts(); });
  window.addEventListener('scroll', syncEmbeddedBounds, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#platformPicker').hidden) closePlatformPicker();
    if (event.key === 'Escape' && !$('#collectTargetPicker').hidden) closeCollectTargetPicker();
  });
  // 任何布局变化（折叠列表、隐藏页头等）都跟随同步内嵌浏览器位置
  const embedHostEl = $('#embedHost');
  if (embedHostEl && window.ResizeObserver) new ResizeObserver(() => syncEmbeddedBounds()).observe(embedHostEl);

  if (window.accountConsole?.onCollectProgress) {
    window.accountConsole.onCollectProgress((p) => {
      if (p.stage === 'collecting') {
        setCollectLive(true, `采集中：${p.account_name || '-'}`,
          `账号 ${p.index}/${p.total} · 已采 ${p.collected || 0} 条`);
        setCollectStatus(`采集中 ${p.index}/${p.total}：${p.account_name || ''} · 已采 ${p.collected || 0} 条`);
      } else if (p.stage === 'done-one') {
        setCollectLive(true, `采集中（${p.index}/${p.total} 完成）`,
          `${p.account_name || '-'}：${p.status === 'success' ? '成功' : '失败'}`);
        if (state.view === 'collect') loadCollectHistory();
      } else if (p.stage === 'finished') {
        setCollectLive(false);
        setCollectStatus('');
        if (p.summary?.trigger === 'scheduled') {
          refreshCollectedData().catch((error) => toast(`采集后刷新失败：${error.message}`));
        }
      }
    });
  }
  if (window.accountConsole?.onProfileReady) {
    window.accountConsole.onProfileReady((payload) => {
      const id = Number(payload?.account_id);
      if (!Number.isFinite(id)) return;
      // 登录后的重定向、单页导航和完整加载都会重新安排有限次重试。
      if (state.loginSessions.has(id)) scheduleLoginInspection(id);
      else if (state.view === 'accounts' && state.wsActive === id) scheduleProfileSync(id);
    });
  }
}

/* ---------- 启动 ---------- */
wireEvents();
applyNavOrder();
setView(initialView());
loadMeta().finally(() => reloadAll().catch(err => toast(`加载失败：${err.message}`)));

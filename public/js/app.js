// ===== STATE =====
let currentUser = null;
let currentPage = 'dashboard';
let charts = {};
let userAccounts = []; // cached accounts

// ===== API HELPERS =====
function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // Double-submit CSRF: echo the csrf_token cookie on state-changing requests.
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(url, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function toast(msg, type = 'success', opts = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  if (opts.actionLabel && typeof opts.onAction === 'function') {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.onclick = () => { el.remove(); opts.onAction(); };
    el.appendChild(btn);
  }
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), opts.duration || 3500);
}

function formatBRL(val) {
  const n = Number(val) || 0;
  return 'R$ ' + n.toFixed(2).replace('.', ',');
}

function formatUSD(val) {
  const n = Number(val) || 0;
  return '$ ' + n.toFixed(2);
}

function profitClass(val) {
  const n = Number(val) || 0;
  if (n > 0.005) return 'profit-positive';
  if (n < -0.005) return 'profit-negative';
  return 'profit-zero';
}

function typeLabel(type) {
  const labels = {
    aquecimento: 'Aquecimento',
    arbitragem: 'Arbitragem',
    aumentada25: 'Aumentada 25%',
    arbitragem_br: 'Arbitragem BR',
  };
  return labels[type] || type;
}

function resultLabel(result) {
  const labels = {
    pending: 'Pendente',
    bet365_won: 'Bet365',
    poly_won: 'Poly',
    won: 'Concluída',
    void: 'Anulado',
  };
  return labels[result] || result;
}

// Parse extra_bets JSON safely — operations may store it as string or already-parsed.
function parseExtraBets(op) {
  if (!op || op.extra_bets == null) return [];
  if (Array.isArray(op.extra_bets)) return op.extra_bets;
  try { return JSON.parse(op.extra_bets) || []; } catch { return []; }
}

// Totals/labels for an arbitragem_br op — all legs live in extra_bets.
function brLegsSummary(op) {
  const legs = parseExtraBets(op);
  const totalStake = legs.reduce((s, l) => s + (Number(l.stake) || 0), 0);
  const bookmakers = legs.map(l => (l.bookmaker || '').trim()).filter(Boolean);
  return { legs, totalStake, bookmakers };
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('pt-BR');
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== TAG INPUT COMPONENT =====
let allKnownTags = []; // populated from API

function renderTagsDisplay(tags) {
  if (!tags || !tags.length) return '';
  return tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join(' ');
}

function initTagInput(containerId, initialTags = []) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap._tags = [...initialTags];

  function render() {
    const tags = wrap._tags;
    wrap.innerHTML = tags.map((t, i) =>
      `<span class="tag-item">${escapeHtml(t)}<button type="button" onclick="removeTag('${containerId}',${i})">&times;</button></span>`
    ).join('') +
      `<input type="text" placeholder="${tags.length ? '' : 'Digite uma tag e pressione Enter...'}" onkeydown="tagInputKey(event,'${containerId}')" id="${containerId}-input">`;
    // Suggestions
    const sugId = containerId + '-suggestions';
    let sugEl = document.getElementById(sugId);
    if (!sugEl) {
      sugEl = document.createElement('div');
      sugEl.id = sugId;
      sugEl.className = 'tag-suggestions';
      wrap.parentNode.appendChild(sugEl);
    }
    const unused = allKnownTags.filter(t => !tags.includes(t));
    sugEl.innerHTML = unused.slice(0, 8).map(t =>
      `<button type="button" onclick="addTag('${containerId}','${escapeHtml(t)}')">${escapeHtml(t)}</button>`
    ).join('');
  }
  render();
  wrap.addEventListener('click', () => {
    const inp = document.getElementById(containerId + '-input');
    if (inp) inp.focus();
  });
}

function tagInputKey(e, containerId) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = e.target.value.trim().toLowerCase().replace(/,/g, '');
    if (val) addTag(containerId, val);
  }
  if (e.key === 'Backspace' && !e.target.value) {
    const wrap = document.getElementById(containerId);
    if (wrap && wrap._tags.length) {
      wrap._tags.pop();
      initTagInput(containerId, wrap._tags);
    }
  }
}

function addTag(containerId, tag) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const t = tag.trim().toLowerCase();
  if (t && !wrap._tags.includes(t)) {
    wrap._tags.push(t);
    initTagInput(containerId, wrap._tags);
  }
}

function removeTag(containerId, idx) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  wrap._tags.splice(idx, 1);
  initTagInput(containerId, wrap._tags);
}

function getTagsFromInput(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return [];
  // Also grab any text in the input field that hasn't been committed
  const inp = document.getElementById(containerId + '-input');
  const pending = inp?.value?.trim().toLowerCase();
  const tags = [...(wrap._tags || [])];
  if (pending && !tags.includes(pending)) tags.push(pending);
  return tags;
}

async function loadAccounts() {
  try {
    userAccounts = await api('/api/accounts');
  } catch { userAccounts = []; }
}

// ===== LIVE EXCHANGE RATE =====
let liveRate = null;
let liveRateSource = '';

async function fetchLiveRate() {
  const attempts = [
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDCBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance"})),
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance USDT"})),
    () => fetch("https://open.er-api.com/v6/latest/USD").then(r=>r.json()).then(d=>({price:d.rates.BRL,src:"ExchangeRate-API"})),
  ];
  for (const fn of attempts) {
    try {
      const {price, src} = await fn();
      if (price > 0) { liveRate = price; liveRateSource = src; return price; }
    } catch (_) {}
  }
  return null;
}

// ===== AUTO PROFIT CALCULATION =====
// Pure math lives in /js/surebet-math.js (shared with Vitest tests).
// Destructuring happens in /js/calculator.js (loaded before this file) so the
// globals are visible here; what we *use directly* in app.js is computeProfit.
const { computeProfit } = window.SurebetMath;

// ===== AUTH =====
let isLoginMode = true;

function loginWithDiscord() {
  window.location.href = '/api/auth/discord?action=login';
}

function linkDiscord() {
  window.location.href = '/api/auth/discord?action=link';
}

async function unlinkDiscord() {
  if (!confirm('Desvincular Discord da sua conta?')) return;
  try {
    await api('/api/auth/discord/unlink', { method: 'POST' });
    toast('Discord desvinculado!');
    currentUser.discord_id = null;
    currentUser.discord_username = null;
    currentUser.discord_avatar = null;
    renderSettings();
  } catch (err) { toast(err.message, 'error'); }
}

function getDiscordAvatarUrl(discordId, avatarHash, size = 64) {
  if (!discordId || !avatarHash) return null;
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=${size}`;
}

function handleDiscordUrlParams() {
  const params = new URLSearchParams(location.search);
  if (params.has('discord_login')) {
    toast('Login com Discord realizado!');
  } else if (params.has('discord_linked')) {
    toast('Discord vinculado com sucesso!');
  } else if (params.has('discord_error')) {
    const errors = {
      no_code: 'Falha na autorização do Discord',
      not_configured: 'Discord OAuth não configurado no servidor',
      token_failed: 'Falha ao obter token do Discord',
      profile_failed: 'Falha ao buscar perfil do Discord',
      not_in_guild: 'Você precisa ser membro do servidor do grupo para acessar',
      discord_already_linked: 'Este Discord já está vinculado a outra conta',
      not_authenticated: 'Faça login antes de vincular o Discord',
      server_error: 'Erro interno ao processar login Discord',
    };
    const code = params.get('discord_error');
    toast(errors[code] || `Erro Discord: ${code}`, 'error');
  }
  // Clean URL params
  if (params.has('discord_login') || params.has('discord_linked') || params.has('discord_error')) {
    history.replaceState(null, '', location.pathname);
  }
}

function toggleAuthMode() {
  isLoginMode = !isLoginMode;
  document.getElementById('register-field').style.display = isLoginMode ? 'none' : 'block';
  document.getElementById('auth-btn').textContent = isLoginMode ? 'Entrar' : 'Criar conta';
  document.getElementById('auth-subtitle').textContent = isLoginMode
    ? 'Entre para gerenciar suas operações'
    : 'Crie sua conta para começar';
  document.getElementById('auth-switch-text').textContent = isLoginMode ? 'Não tem conta?' : 'Já tem conta?';
  document.getElementById('auth-switch-link').textContent = isLoginMode ? 'Criar conta' : 'Entrar';
  document.getElementById('auth-error').style.display = 'none';
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const display_name = document.getElementById('auth-display-name').value.trim();
  try {
    const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/register';
    const body = isLoginMode ? { username, password } : { username, password, display_name };
    currentUser = await api(endpoint, { method: 'POST', body });
    showApp();
  } catch (err) {
    const errEl = document.getElementById('auth-error');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

async function checkAuth() {
  handleDiscordUrlParams();
  try {
    currentUser = await api('/api/auth/me');
    showApp();
  } catch {
    document.getElementById('auth-page').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  stopBgPolling();
  document.getElementById('auth-page').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

async function showApp() {
  document.getElementById('auth-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const displayName = currentUser.discord_username || currentUser.display_name;
  document.getElementById('user-name').textContent = displayName;
  const avatarEl = document.getElementById('user-avatar');
  const discordAvatarUrl = getDiscordAvatarUrl(currentUser.discord_id, currentUser.discord_avatar, 64);
  if (discordAvatarUrl) {
    avatarEl.innerHTML = `<img src="${discordAvatarUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    avatarEl.style.overflow = 'hidden';
  } else {
    avatarEl.textContent = displayName.charAt(0).toUpperCase();
  }
  await loadAccounts();
  // Show admin nav item only for admins
  const adminNav = document.getElementById('nav-admin');
  if (adminNav) adminNav.style.display = currentUser.is_admin ? '' : 'none';
  // Auto-navigate to calculator if URL has shared odds params
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.has('n') && urlParams.has('o0')) {
    navigate('calculator');
  } else {
    navigate('dashboard');
  }
  // Start background watcher polling
  startBgPolling();
  // Load initial unseen count
  try {
    const d = await api('/api/watcher/alerts?unseen=1&limit=1');
    unseenAlertCount = d.total || 0;
    updateBadge();
  } catch (_) {}
  // Initial notifications badge
  refreshNotificationsBadge();
}

// ===== NAVIGATION =====
function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
  destroyCharts();

  // Clean up calculator rate interval when leaving
  if (calcRateInterval) {
    clearInterval(calcRateInterval);
    calcRateInterval = null;
  }

  const pages = {
    'dashboard': renderDashboard,
    'new-operation': renderNewOperation,
    'history': renderHistory,
    'ranking': renderRanking,
    'calculator': renderCalculator,
    'freebets': renderFreebets,
    'settings': renderSettings,
    'watcher': renderWatcher,
    'notifications': renderNotifications,
    'admin': renderAdmin,
    'giros': renderGiros,
    'finances': renderFinances,
  };
  (pages[page] || renderDashboard)();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('active');
}

function destroyCharts() {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
}

// ===== DASHBOARD =====
let dashIncludeGiros = localStorage.getItem('dashIncludeGiros') !== '0';

function toggleDashGiros() {
  dashIncludeGiros = !dashIncludeGiros;
  localStorage.setItem('dashIncludeGiros', dashIncludeGiros ? '1' : '0');
  if (window._dashStatsData) renderStats(window._dashStatsData);
  const btn = document.getElementById('dash-giros-toggle');
  if (btn) btn.textContent = dashIncludeGiros ? 'Incluindo giros' : 'Sem giros';
}

async function renderDashboard() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-description">Resumo das suas operações</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="dash-giros-toggle" onclick="toggleDashGiros()" title="Alternar inclusão de giros no lucro">${dashIncludeGiros ? 'Incluindo giros' : 'Sem giros'}</button>
        <button class="btn btn-primary" onclick="navigate('new-operation')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nova Operação
        </button>
      </div>
    </div>
    <div class="stats-grid" id="stats-grid"></div>
    <div id="dash-operators-card"></div>
    <div class="volume-card" id="volume-card"></div>
    <div class="charts-row">
      <div class="chart-container">
        <h3 class="chart-title">Lucro Diário (últimos 30 dias)</h3>
        <div class="chart-wrapper"><canvas id="profit-chart"></canvas></div>
      </div>
      <div class="chart-container">
        <h3 class="chart-title">Por Tipo de Operação</h3>
        <div class="chart-wrapper"><canvas id="type-chart"></canvas></div>
      </div>
    </div>
    <div class="table-container">
      <div class="table-header">
        <h3 class="table-title">Operações Recentes</h3>
        <button class="btn btn-ghost btn-sm" onclick="navigate('history')">Ver todas</button>
      </div>
      <div id="recent-table"></div>
    </div>
  `;

  try {
    const data = await api('/api/dashboard/stats');
    window._dashStatsData = data;
    renderStats(data);
    renderDashOperators(data.operators);
    renderVolumeTracker(data);
    renderProfitChart(data.dailyProfits);
    renderTypeChart(data.profitByType);
    renderRecentTable(data.recentOps);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDashOperators(op) {
  const el = document.getElementById('dash-operators-card');
  if (!el) return;
  if (!op) { el.innerHTML = ''; return; }
  const pendingCount = op.pending?.count || 0;
  const pendingTotal = Number(op.pending?.total || 0);
  const paidTotal = Number(op.paidMonth?.total || 0);
  const overdue = op.overdueCount || 0;
  el.innerHTML = `
    <div class="chart-container" style="margin-bottom:20px;cursor:pointer" onclick="navigate('finances')" title="Abrir Finanças">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">Operadores Bet365</div>
          <div style="font-size:20px;font-weight:700">${op.activeCount} ativo(s)</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Custo mensal estimado: <b>${formatBRL(op.monthlyCost)}</b></div>
        </div>
        <div style="display:flex;gap:20px;flex-wrap:wrap">
          <div>
            <div style="font-size:11px;color:var(--text-muted)">Pago no mês</div>
            <div style="font-size:16px;font-weight:600">${formatBRL(paidTotal)}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted)">Pendente</div>
            <div style="font-size:16px;font-weight:600;${pendingTotal > 0 ? 'color:var(--warning)' : ''}">${formatBRL(pendingTotal)}${pendingCount ? ` <span style="font-size:11px;color:var(--text-muted)">(${pendingCount})</span>` : ''}</div>
          </div>
          ${overdue > 0 ? `
          <div>
            <div style="font-size:11px;color:var(--text-muted)">Atrasados</div>
            <div style="font-size:16px;font-weight:600;color:var(--danger)">${overdue}</div>
          </div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function statDelta(current, previous, label) {
  if (!previous || previous === 0) return '';
  const diff = current - previous;
  const pct = ((diff / Math.abs(previous)) * 100).toFixed(0);
  const isUp = diff > 0;
  const isZero = diff === 0;
  if (isZero) return '';
  const arrow = isUp ? '\u25B2' : '\u25BC';
  const cls = isUp ? 'stat-delta-up' : 'stat-delta-down';
  return `<span class="${cls}" title="vs ${label}: ${formatBRL(previous)}">${arrow} ${isUp ? '+' : ''}${pct}%</span>`;
}

function renderStats(data) {
  const yesterdayProfit = data.yesterday ? data.yesterday.profit : 0;
  const prevWeekProfit = data.prevWeek ? data.prevWeek.profit : 0;
  const prevMonthProfit = data.prevMonth ? data.prevMonth.profit : 0;
  const avgDaily = data.avgDailyProfit || 0;
  const giros = data.giros || { today: {profit:0}, week: {profit:0}, month: {profit:0}, allTime: {profit:0} };

  const mkLine = (opsProfit, girosProfit) => {
    if (!girosProfit) return '';
    if (dashIncludeGiros) {
      return `<div class="giros-breakdown">Ops: <b class="${profitClass(opsProfit)}">${formatBRL(opsProfit)}</b> · Giros: <b class="${profitClass(girosProfit)}">${formatBRL(girosProfit)}</b></div>`;
    }
    return `<div class="giros-breakdown">Giros (não incluso): <b class="${profitClass(girosProfit)}">${formatBRL(girosProfit)}</b></div>`;
  };

  const todayTotal = data.today.profit + (dashIncludeGiros ? (giros.today.profit || 0) : 0);
  const weekTotal = data.week.profit + (dashIncludeGiros ? (giros.week.profit || 0) : 0);
  const monthTotal = data.month.profit + (dashIncludeGiros ? (giros.month.profit || 0) : 0);
  const allTotal = data.allTime.profit + (dashIncludeGiros ? (giros.allTime.profit || 0) : 0);

  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Lucro Hoje</div>
      <div class="stat-value ${profitClass(todayTotal)}">${formatBRL(todayTotal)}</div>
      <div class="stat-sub">
        ${data.today.count} operação(ões)
        ${statDelta(todayTotal, yesterdayProfit, 'ontem')}
      </div>
      ${mkLine(data.today.profit, giros.today.profit || 0)}
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro na Semana</div>
      <div class="stat-value ${profitClass(weekTotal)}">${formatBRL(weekTotal)}</div>
      <div class="stat-sub">
        ${data.week.count} operação(ões)
        ${statDelta(weekTotal, prevWeekProfit, 'semana anterior')}
      </div>
      ${mkLine(data.week.profit, giros.week.profit || 0)}
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro no Mês</div>
      <div class="stat-value ${profitClass(monthTotal)}">${formatBRL(monthTotal)}</div>
      <div class="stat-sub">
        ${data.month.count} operação(ões)
        ${statDelta(monthTotal, prevMonthProfit, 'mês anterior')}
      </div>
      ${mkLine(data.month.profit, giros.month.profit || 0)}
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro Total</div>
      <div class="stat-value ${profitClass(allTotal)}">${formatBRL(allTotal)}</div>
      <div class="stat-sub">
        ${data.allTime.count} operação(ões)
        ${avgDaily > 0 ? `<span class="stat-avg" title="Média diária desde a primeira operação">\u00D8 ${formatBRL(avgDaily)}/dia</span>` : ''}
      </div>
      ${mkLine(data.allTime.profit, giros.allTime.profit || 0)}
    </div>
  `;
}

function renderVolumeTracker(data) {
  const goal = data.weeklyVolumeGoal;
  const accounts = data.accountVolumes;

  if (!accounts.length) {
    document.getElementById('volume-card').innerHTML = `
      <div class="volume-header">
        <div class="volume-title">Volume Semanal (Freebet)</div>
      </div>
      <div style="color:var(--text-muted);font-size:14px;padding:8px 0">
        Nenhuma conta Bet365 cadastrada. <a href="#" onclick="navigate('settings');return false" style="color:var(--primary)">Adicione nas configurações</a>.
      </div>
    `;
    return;
  }

  const allComplete = accounts.every(a => a.volume >= goal);

  document.getElementById('volume-card').innerHTML = `
    <div class="volume-header">
      <div>
        <div class="volume-title">${allComplete ? '&#10003; ' : ''}Volume Semanal por Conta (Freebet)</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
          Apostas com odd &ge; 3.0 na Bet365 desde ${formatDate(data.weekStart)} | Meta: ${formatBRL(goal)} por conta
        </div>
      </div>
    </div>
    <div class="volume-accounts-grid">
      ${accounts.map(acc => {
        const pct = Math.min((acc.volume / goal) * 100, 100);
        const complete = pct >= 100;
        return `
          <div class="volume-account-item">
            <div class="volume-account-header">
              <span class="volume-account-name">${escapeHtml(acc.account_name)}</span>
              <span class="volume-account-amount">${formatBRL(acc.volume)} / ${formatBRL(goal)}</span>
            </div>
            <div class="progress-bar" style="height:8px">
              <div class="progress-fill ${complete ? 'complete' : ''}" style="width:${pct}%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--text-muted)">
              <span>${pct.toFixed(0)}%</span>
              <span>${complete ? 'Freebet garantida!' : `Faltam ${formatBRL(goal - acc.volume)}`}</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderProfitChart(dailyProfits) {
  const ctx = document.getElementById('profit-chart');
  if (!ctx) return;
  const labels = dailyProfits.map(d => {
    const date = new Date(d.date + 'T12:00:00');
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  });
  const values = dailyProfits.map(d => d.profit);
  const colors = values.map(v => v >= 0 ? 'rgba(0,200,83,0.8)' : 'rgba(239,83,80,0.8)');
  charts.profit = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Lucro (R$)', data: values, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b8fa3', font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b8fa3', callback: v => 'R$' + v } }
      }
    }
  });
}

function renderTypeChart(profitByType) {
  const ctx = document.getElementById('type-chart');
  if (!ctx) return;
  const typeColors = { aquecimento: '#ffa726', arbitragem: '#00c853', aumentada25: '#6c5ce7', arbitragem_br: '#26c6da' };
  if (!profitByType.length) {
    charts.type = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: ['Sem dados'], datasets: [{ data: [1], backgroundColor: ['#2e3247'] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8b8fa3' } } } }
    });
    return;
  }
  charts.type = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: profitByType.map(p => typeLabel(p.type)),
      datasets: [{ data: profitByType.map(p => p.count), backgroundColor: profitByType.map(p => typeColors[p.type] || '#6c5ce7'), borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { color: '#e4e6f0', padding: 16, font: { size: 12 } } } }
    }
  });
}

function renderRecentTable(ops) {
  const container = document.getElementById('recent-table');
  if (!ops.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#128202;</div>
      <div class="empty-state-text">Nenhuma operação registrada</div>
      <div class="empty-state-sub">Clique em "Nova Operação" para começar</div>
    </div>`;
    return;
  }
  container.innerHTML = `
    <table>
      <thead><tr>
        <th>Data</th><th>Jogo</th><th>Tipo</th><th>Tags</th><th>Stake B365</th><th>Stake Poly</th><th>Lucro</th><th>Contas</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${ops.map(op => {
          const isBR = op.type === 'arbitragem_br';
          const br = isBR ? brLegsSummary(op) : null;
          return `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
          <td>${renderTagsDisplay(op.tags)}</td>
          <td>${isBR ? formatBRL(br.totalStake) : formatBRL(op.stake_bet365)}</td>
          <td>${isBR ? '<span style="color:var(--text-muted)">—</span>' : `${formatUSD(op.stake_poly_usd)} <span class="currency-tag">USD</span>`}</td>
          <td class="${profitClass(op.profit)}">${formatBRL(op.profit)}</td>
          <td>${isBR ? (br.bookmakers.map(escapeHtml).join(', ') || '-') : ((op.accounts || []).map(a => escapeHtml(a.name)).join(', ') || '-')}</td>
          <td><span class="badge badge-${op.result === 'pending' ? 'pending' : 'won'}">${resultLabel(op.result)}</span></td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ===== NEW OPERATION =====
function localDateStr(d) {
  const dt = d || new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

async function renderNewOperation() {
  await loadAccounts();
  const today = localDateStr();
  const activeAccounts = userAccounts.filter(a => a.active);

  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Nova Operação</h1>
        <p class="page-description">Registre uma nova operação de surebet</p>
      </div>
    </div>

    ${!activeAccounts.length ? `<div class="chart-container" style="margin-bottom:20px;border-left:3px solid var(--warning)">
      <p style="color:var(--warning);font-size:14px">Nenhuma conta Bet365 cadastrada. <a href="#" onclick="navigate('settings');return false" style="color:var(--primary)">Adicione nas configurações</a> antes de registrar operações.</p>
    </div>` : ''}

    <form id="new-op-form" class="chart-container">
      <h3 class="chart-title" style="margin-bottom:20px">Tipo de Operação</h3>
      <div class="type-selector">
        <div class="type-option" data-type="aquecimento" onclick="selectType(this)">
          <div class="type-option-icon">&#128293;</div>
          <div class="type-option-name">Aquecimento/Clube</div>
          <div class="type-option-desc">Volume para freebet semanal</div>
        </div>
        <div class="type-option" data-type="arbitragem" onclick="selectType(this)">
          <div class="type-option-icon">&#128176;</div>
          <div class="type-option-name">Arbitragem</div>
          <div class="type-option-desc">Operação visando lucro</div>
        </div>
        <div class="type-option" data-type="aumentada25" onclick="selectType(this)">
          <div class="type-option-icon">&#128640;</div>
          <div class="type-option-name">Aumentada 25%</div>
          <div class="type-option-desc">Promoção de odds aumentadas</div>
        </div>
        <div class="type-option" data-type="arbitragem_br" onclick="selectType(this)">
          <div class="type-option-icon">&#127463;&#127479;</div>
          <div class="type-option-name">Arbitragem BR</div>
          <div class="type-option-desc">Casas brasileiras variadas (só R$)</div>
        </div>
      </div>
      <input type="hidden" id="new-type">

      <div class="form-group full">
        <label class="form-label">Jogo / Evento</label>
        <input type="text" class="form-input" id="new-game" placeholder="Ex: Real Madrid vs Barcelona - Vencedor" required>
      </div>

      ${activeAccounts.length ? `
      <div id="new-accounts-section">
        <h3 class="chart-title" style="margin:24px 0 12px">Contas Utilizadas</h3>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Selecione quais contas Bet365 foram usadas nesta operação</p>
        <label class="account-check" style="margin-bottom:12px;cursor:pointer;display:inline-flex">
          <input type="checkbox" id="new-custom-stakes-toggle" onchange="toggleCustomStakes('new')">
          <div class="account-check-dot"></div>
          <div style="font-size:13px">Usar stake personalizado por conta</div>
        </label>
        <div class="accounts-checklist" id="new-accounts-list">
          ${activeAccounts.map(acc => `
            <label class="account-check" onclick="accountCheckClick(event, this)">
              <input type="checkbox" name="accounts" value="${acc.id}" data-account-id="${acc.id}">
              <div class="account-check-dot"></div>
              <div style="flex:1">
                <div>${escapeHtml(acc.name)}</div>
                <div class="account-check-info">Max aumentada: ${formatBRL(acc.max_stake_aumentada)}</div>
              </div>
              <input type="number" step="0.01" min="0" class="form-input per-account-stake"
                data-account-id="${acc.id}"
                placeholder="R$"
                style="display:none;width:100px;margin-left:8px"
                onclick="event.stopPropagation()"
                oninput="onPerAccountStakeChange('new')">
            </label>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <div class="form-grid" style="margin-top:20px">
        <div class="form-group">
          <label class="form-label">Data do Evento</label>
          <input type="date" class="form-input" id="new-event-date" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">Resultado</label>
          <select class="form-select" id="new-result">
            <option value="pending">Pendente</option>
            <option value="bet365_won" data-for="bet365-poly">Bet365 Ganhou</option>
            <option value="poly_won" data-for="bet365-poly">Polymarket Ganhou</option>
            <option value="won" data-for="br" hidden>Concluída</option>
            <option value="void">Anulado</option>
          </select>
        </div>
      </div>

      <div id="new-bet365-section">
        <h3 class="chart-title" style="margin:24px 0 16px">Bet365 (BRL) <span id="new-bet365-label" style="font-size:12px;font-weight:400;color:var(--text-muted)"></span></h3>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Stake Total Bet365 (R$) <span style="font-size:11px;color:var(--text-muted)">(soma de todas as contas)</span></label>
            <input type="number" step="0.01" min="0" class="form-input" id="new-stake-bet365" placeholder="0,00">
          </div>
          <div class="form-group">
            <label class="form-label">Odd Bet365</label>
            <input type="number" step="0.01" min="1" class="form-input" id="new-odd-bet365" placeholder="0,00">
          </div>
          <div class="form-group full">
            <label class="account-check" style="cursor:pointer;display:inline-flex;padding:6px 10px">
              <input type="checkbox" id="new-uses-freebet" onchange="toggleMainFreebetAccount('new')">
              <div class="account-check-dot"></div>
              <div style="font-size:13px">Usar saldo de freebet nesta aposta (n\u00E3o conta no volume e paga s\u00F3 o lucro)</div>
            </label>
            <div id="new-freebet-account-wrap" style="display:none;margin-left:32px;margin-top:6px">
              <select class="form-select" id="new-freebet-account" style="max-width:240px">
                ${freebetAccountOptions()}
              </select>
            </div>
          </div>
        </div>
        <div id="stake-per-account-info" style="font-size:12px;color:var(--text-muted);margin-bottom:16px"></div>

        <div id="new-extra-bets-section" style="display:none;margin-top:16px">
          <h3 class="chart-title" style="margin:0 0 12px">Apostas Secund\u00E1rias Bet365
            <span style="font-size:12px;font-weight:400;color:var(--text-muted)">(fechando as demais op\u00E7\u00F5es)</span>
          </h3>
          <div id="new-extra-bets-list"></div>
          <button type="button" class="btn btn-ghost btn-sm" onclick="addExtraBet()">+ Adicionar aposta</button>
        </div>
      </div>

      <div id="new-poly-section">
        <h3 class="chart-title" style="margin:24px 0 16px">Polymarket (USD)</h3>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Stake Polymarket (USD)</label>
            <input type="number" step="0.01" min="0" class="form-input" id="new-stake-poly-usd" placeholder="0,00">
          </div>
          <div class="form-group">
            <label class="form-label">Odd Polymarket</label>
            <input type="number" step="0.01" min="1" class="form-input" id="new-odd-poly" placeholder="0,00">
          </div>
          <div class="form-group">
            <label class="form-label">Cotação USD/BRL <span id="new-rate-status" style="font-size:11px"></span></label>
            <input type="number" step="0.0001" min="0" class="form-input" id="new-exchange-rate" placeholder="Buscando...">
          </div>
          <div class="form-group">
            <label class="form-label">Equivalente em BRL</label>
            <input type="text" class="form-input" id="new-poly-brl" readonly style="opacity:0.7">
          </div>
        </div>
      </div>

      <div id="new-br-legs-section" style="display:none">
        <h3 class="chart-title" style="margin:24px 0 12px">Apostas (R$)
          <span style="font-size:12px;font-weight:400;color:var(--text-muted)">uma linha por casa de aposta</span>
        </h3>
        <div id="new-br-legs-list"></div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="addBrLeg()">+ Adicionar aposta</button>
      </div>

      <h3 class="chart-title" style="margin:24px 0 16px">Resultado Financeiro</h3>
      <div id="new-auto-profit-info" style="display:none;font-size:12px;color:var(--success);margin-bottom:8px"></div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Lucro Total da Operação (R$)</label>
          <input type="number" step="0.01" class="form-input" id="new-profit" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Notas (opcional)</label>
          <input type="text" class="form-input" id="new-notes" placeholder="Observações...">
        </div>
      </div>

      <div class="form-group full" style="margin-top:8px">
        <label class="form-label">Tags (opcional)</label>
        <div class="tags-input-wrap" id="new-tags"></div>
      </div>

      <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:24px">
        <button type="button" class="btn btn-ghost" onclick="navigate('dashboard')">Cancelar</button>
        <button type="submit" class="btn btn-primary">Registrar Operação</button>
      </div>
    </form>
  `;

  // Auto-fetch live exchange rate
  const rateInput = document.getElementById('new-exchange-rate');
  const rateStatus = document.getElementById('new-rate-status');
  rateStatus.textContent = '(buscando...)';
  rateStatus.style.color = 'var(--warning)';
  fetchLiveRate().then(rate => {
    if (rate && rateInput && !rateInput.value) {
      rateInput.value = rate.toFixed(4);
      rateStatus.textContent = `(${liveRateSource} - ao vivo)`;
      rateStatus.style.color = 'var(--success)';
      updatePolyBRL();
      updateAutoProfit();
    } else if (rate) {
      rateStatus.textContent = `(${liveRateSource}: ${rate.toFixed(4)})`;
      rateStatus.style.color = 'var(--text-muted)';
    } else {
      rateStatus.textContent = '(falha - digite manualmente)';
      rateStatus.style.color = 'var(--danger)';
    }
  });

  // Live calc for BRL equivalent
  const polyUsdInput = document.getElementById('new-stake-poly-usd');
  const brlDisplay = document.getElementById('new-poly-brl');

  function updatePolyBRL() {
    const usd = parseFloat(polyUsdInput?.value) || 0;
    const rate = parseFloat(rateInput?.value) || 0;
    if (brlDisplay) brlDisplay.value = usd && rate ? formatBRL(usd * rate) : '';
  }
  polyUsdInput?.addEventListener('input', updatePolyBRL);
  rateInput?.addEventListener('input', updatePolyBRL);

  // Live calc for stake per account
  const stakeBet365Input = document.getElementById('new-stake-bet365');
  function updateStakePerAccount() {
    const info = document.getElementById('stake-per-account-info');
    if (!info) return;
    const customOn = document.getElementById('new-custom-stakes-toggle')?.checked;
    if (customOn) {
      info.textContent = 'Stake personalizado ativo — defina o valor de cada conta';
      return;
    }
    const checked = document.querySelectorAll('#new-accounts-list input[name="accounts"]:checked');
    const total = parseFloat(stakeBet365Input?.value) || 0;
    if (checked.length > 0 && total > 0) {
      const perAccount = total / checked.length;
      info.textContent = `${formatBRL(perAccount)} por conta (${checked.length} conta${checked.length > 1 ? 's' : ''} selecionada${checked.length > 1 ? 's' : ''})`;
    } else {
      info.textContent = '';
    }
  }
  stakeBet365Input?.addEventListener('input', updateStakePerAccount);
  document.querySelectorAll('#new-accounts-list input').forEach(cb => {
    cb.addEventListener('change', updateStakePerAccount);
  });

  // Auto-profit calculation when result changes
  const resultSelect = document.getElementById('new-result');
  const oddBet365Input = document.getElementById('new-odd-bet365');
  const oddPolyInput = document.getElementById('new-odd-poly');
  const profitInput = document.getElementById('new-profit');
  const autoProfitInfo = document.getElementById('new-auto-profit-info');

  function updateAutoProfit() {
    const result = resultSelect?.value;
    const type = document.getElementById('new-type')?.value;
    // BR arbitrage doesn't fit the bet365/poly profit formula — leave to manual entry.
    if (result === 'pending' || type === 'arbitragem_br') {
      autoProfitInfo.style.display = 'none';
      return;
    }
    const p = computeProfit(
      stakeBet365Input?.value, oddBet365Input?.value,
      polyUsdInput?.value, oddPolyInput?.value,
      rateInput?.value, result
    );
    if (p !== null) {
      profitInput.value = p.toFixed(2);
      const label = result === 'void' ? 'Anulado - lucro zerado' :
        `Lucro calculado: ${formatBRL(p)} (${result === 'bet365_won' ? 'Bet365 ganhou' : 'Poly ganhou'})`;
      autoProfitInfo.textContent = label;
      autoProfitInfo.style.display = 'block';
      autoProfitInfo.style.color = p >= 0 ? 'var(--success)' : 'var(--danger)';
    }
  }

  resultSelect?.addEventListener('change', updateAutoProfit);
  // Recalculate when stakes/odds change if result is not pending
  [stakeBet365Input, oddBet365Input, polyUsdInput, oddPolyInput, rateInput].forEach(el => {
    el?.addEventListener('input', () => {
      if (resultSelect?.value !== 'pending') updateAutoProfit();
      updatePolyBRL();
    });
  });

  document.getElementById('new-op-form').addEventListener('submit', submitNewOperation);

  // Load known tags and init tag input
  try {
    const tagData = await api('/api/operations?limit=0');
    if (tagData.allTags) allKnownTags = tagData.allTags;
  } catch {}
  initTagInput('new-tags');

  // Pre-fill from calculator import
  if (window._calcImport) {
    const imp = window._calcImport;
    window._calcImport = null;

    // Select type
    const typeEl = document.querySelector(`.type-option[data-type="${imp.type}"]`);
    if (typeEl) selectType(typeEl);

    // Fill fields
    if (imp.stakeBet365) document.getElementById('new-stake-bet365').value = imp.stakeBet365.toFixed(2);
    if (imp.oddBet365) document.getElementById('new-odd-bet365').value = imp.oddBet365.toFixed(2);
    if (imp.stakePolyUSD) document.getElementById('new-stake-poly-usd').value = imp.stakePolyUSD.toFixed(2);
    if (imp.oddPoly) document.getElementById('new-odd-poly').value = imp.oddPoly.toFixed(2);
    if (imp.usesFreebet) {
      const fb = document.getElementById('new-uses-freebet');
      if (fb) fb.checked = true;
      toggleMainFreebetAccount('new');
      if (imp.freebetAccountId) {
        const sel = document.getElementById('new-freebet-account');
        if (sel) sel.value = imp.freebetAccountId;
      }
    }
    if (imp.extraBets && imp.extraBets.length) {
      if (imp.type === 'arbitragem_br') {
        const list = document.getElementById('new-br-legs-list');
        if (list) {
          list.innerHTML = '';
          imp.extraBets.forEach(b => addBrLeg(b));
        }
      } else {
        const list = document.getElementById('new-extra-bets-list');
        if (list) {
          list.innerHTML = '';
          imp.extraBets.forEach(b => addExtraBet(b));
        }
      }
    }
    if (imp.exchangeRate) {
      rateInput.value = imp.exchangeRate.toFixed(4);
      rateStatus.textContent = '(da calculadora)';
      rateStatus.style.color = 'var(--success)';
    }
    if (imp.notes) document.getElementById('new-notes').value = imp.notes;

    // Pre-fill profit from calculator (fee-adjusted guaranteed profit).
    if (imp.minProfitBRL != null) {
      profitInput.value = imp.minProfitBRL.toFixed(2);
      if (autoProfitInfo) {
        autoProfitInfo.textContent = `Lucro garantido da calculadora: ${formatBRL(imp.minProfitBRL)}`;
        autoProfitInfo.style.display = 'block';
        autoProfitInfo.style.color = imp.minProfitBRL >= 0 ? 'var(--success)' : 'var(--danger)';
      }
    }

    // Extra fields from duplicate operation
    if (imp.game) document.getElementById('new-game').value = imp.game;
    if (imp.eventDate) document.getElementById('new-event-date').value = imp.eventDate;
    if (imp.accountIds && imp.accountIds.length) {
      imp.accountIds.forEach(id => {
        const cb = document.querySelector(`#new-accounts-list input[value="${id}"]`);
        if (cb) {
          cb.checked = true;
          cb.closest('label.account-check')?.classList.add('checked');
        }
      });
    }
    if (imp.accountStakes && imp.accountStakes.length) {
      const toggle = document.getElementById('new-custom-stakes-toggle');
      if (toggle) {
        toggle.checked = true;
        toggleCustomStakes('new');
      }
      imp.accountStakes.forEach(({ account_id, stake }) => {
        const inp = document.querySelector(`#new-accounts-list input.per-account-stake[data-account-id="${account_id}"]`);
        if (inp && stake != null) inp.value = Number(stake).toFixed(2);
      });
      onPerAccountStakeChange('new');
    }

    // Pre-fill tags from duplicate
    if (imp.tags && imp.tags.length) {
      initTagInput('new-tags', imp.tags);
    }

    updatePolyBRL();
    updateStakePerAccount();
  }
}

function selectType(el) {
  document.querySelectorAll('.type-option').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  const t = el.dataset.type;
  document.getElementById('new-type').value = t;
  const isBR = t === 'arbitragem_br';

  // Toggle bet365/poly/accounts sections (hidden for BR).
  const setDisplay = (id, show) => { const n = document.getElementById(id); if (n) n.style.display = show ? '' : 'none'; };
  setDisplay('new-bet365-section', !isBR);
  setDisplay('new-poly-section', !isBR);
  setDisplay('new-accounts-section', !isBR);
  setDisplay('new-br-legs-section', isBR);

  const extraSection = document.getElementById('new-extra-bets-section');
  const label = document.getElementById('new-bet365-label');
  if (extraSection) extraSection.style.display = t === 'aumentada25' ? '' : 'none';
  if (label) label.textContent = t === 'aumentada25' ? '— aposta principal (aumentada)' : '';

  // Result dropdown: BR uses generic "Concluída"; others use bet365_won / poly_won.
  const resultSel = document.getElementById('new-result');
  if (resultSel) {
    for (const opt of resultSel.options) {
      if (opt.dataset.for === 'bet365-poly') opt.hidden = isBR;
      if (opt.dataset.for === 'br') opt.hidden = !isBR;
    }
    const curOpt = resultSel.selectedOptions[0];
    if (curOpt && curOpt.hidden) resultSel.value = 'pending';
  }

  // Aumentada operations use 4 bets by default — seed two extras if list is empty.
  if (t === 'aumentada25') {
    const list = document.getElementById('new-extra-bets-list');
    if (list && !list.children.length) { addExtraBet(); addExtraBet(); }
  }
  // BR arbitrage defaults to 2 legs.
  if (isBR) {
    const list = document.getElementById('new-br-legs-list');
    if (list && !list.children.length) { addBrLeg(); addBrLeg(); }
  }
}

let _extraBetSeq = 0;
function freebetAccountOptions(selectedId) {
  const active = userAccounts.filter(a => a.active);
  return '<option value="">— conta —</option>' +
    active.map(a => `<option value="${a.id}" ${a.id === Number(selectedId) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
}
function extraBetRowHtml(idx, data = {}) {
  const uid = `extra-${++_extraBetSeq}`;
  const showAcct = !!data.uses_freebet;
  return `
    <div class="form-grid extra-bet-row" data-uid="${uid}" style="align-items:end;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px">
      <div class="form-group">
        <label class="form-label">Stake (R$)</label>
        <input type="number" step="0.01" min="0" class="form-input extra-bet-stake" value="${data.stake != null ? Number(data.stake).toFixed(2) : ''}" placeholder="0,00">
      </div>
      <div class="form-group">
        <label class="form-label">Odd</label>
        <input type="number" step="0.01" min="1" class="form-input extra-bet-odd" value="${data.odd != null ? Number(data.odd).toFixed(2) : ''}" placeholder="0,00">
      </div>
      <div class="form-group">
        <label class="account-check" style="cursor:pointer;display:inline-flex;padding:4px 8px">
          <input type="checkbox" class="extra-bet-freebet" onchange="toggleExtraBetAccount(this)" ${data.uses_freebet ? 'checked' : ''}>
          <div class="account-check-dot"></div>
          <div style="font-size:12px">Freebet</div>
        </label>
      </div>
      <div class="form-group extra-bet-account-wrap" style="display:${showAcct ? '' : 'none'}">
        <label class="form-label">Conta freebet</label>
        <select class="form-select extra-bet-account">${freebetAccountOptions(data.account_id)}</select>
      </div>
      <div class="form-group" style="text-align:right">
        <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.extra-bet-row').remove()">Remover</button>
      </div>
    </div>
  `;
}
function toggleExtraBetAccount(cb) {
  const row = cb.closest('.extra-bet-row');
  const wrap = row?.querySelector('.extra-bet-account-wrap');
  if (wrap) wrap.style.display = cb.checked ? '' : 'none';
}
function addExtraBet(data, listId = 'new-extra-bets-list') {
  const list = document.getElementById(listId);
  if (!list) return;
  list.insertAdjacentHTML('beforeend', extraBetRowHtml(list.children.length, data));
}
function collectExtraBets(containerId = 'new-extra-bets-list') {
  const rows = document.querySelectorAll(`#${containerId} .extra-bet-row`);
  const out = [];
  for (const row of rows) {
    const stake = parseFloat(row.querySelector('.extra-bet-stake')?.value) || 0;
    const odd = parseFloat(row.querySelector('.extra-bet-odd')?.value) || 0;
    const uses_freebet = !!row.querySelector('.extra-bet-freebet')?.checked;
    const entry = { stake, odd, uses_freebet };
    if (uses_freebet) {
      const accSel = row.querySelector('.extra-bet-account');
      if (accSel?.value) entry.account_id = Number(accSel.value);
    }
    if (stake > 0 || odd > 0) out.push(entry);
  }
  return out;
}

function toggleMainFreebetAccount(prefix) {
  const cb = document.getElementById(`${prefix}-uses-freebet`);
  const wrap = document.getElementById(`${prefix}-freebet-account-wrap`);
  if (wrap) wrap.style.display = cb?.checked ? '' : 'none';
}

// BR arbitrage legs: free-text bookmaker name, BRL stake, odd. All legs live in
// extra_bets for this type; stake_bet365/odd_bet365/poly columns stay at 0.
function brLegRowHtml(data = {}) {
  return `
    <div class="form-grid br-leg-row" style="align-items:end;padding:8px;border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px">
      <div class="form-group">
        <label class="form-label">Casa</label>
        <input type="text" class="form-input br-leg-bookmaker" value="${data.bookmaker ? escapeHtml(data.bookmaker) : ''}" placeholder="Ex: Superbet, KTO...">
      </div>
      <div class="form-group">
        <label class="form-label">Stake (R$)</label>
        <input type="number" step="0.01" min="0" class="form-input br-leg-stake" value="${data.stake != null ? Number(data.stake).toFixed(2) : ''}" placeholder="0,00">
      </div>
      <div class="form-group">
        <label class="form-label">Odd</label>
        <input type="number" step="0.01" min="1" class="form-input br-leg-odd" value="${data.odd != null ? Number(data.odd).toFixed(2) : ''}" placeholder="0,00">
      </div>
      <div class="form-group" style="text-align:right">
        <button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.br-leg-row').remove()">Remover</button>
      </div>
    </div>
  `;
}
function addBrLeg(data) {
  const list = document.getElementById('new-br-legs-list');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', brLegRowHtml(data));
}
function collectBrLegs() {
  const rows = document.querySelectorAll('#new-br-legs-list .br-leg-row');
  const out = [];
  for (const row of rows) {
    const bookmaker = (row.querySelector('.br-leg-bookmaker')?.value || '').trim();
    const stake = parseFloat(row.querySelector('.br-leg-stake')?.value) || 0;
    const odd = parseFloat(row.querySelector('.br-leg-odd')?.value) || 0;
    if (stake > 0 || odd > 0) out.push({ bookmaker, stake, odd });
  }
  return out;
}

async function submitNewOperation(e) {
  e.preventDefault();
  const type = document.getElementById('new-type').value;
  if (!type) { toast('Selecione o tipo de operação', 'error'); return; }

  const useCustomStakes = document.getElementById('new-custom-stakes-toggle')?.checked;
  const checkedBoxes = document.querySelectorAll('#new-accounts-list input[name="accounts"]:checked');
  const account_ids = Array.from(checkedBoxes).map(cb => Number(cb.value));

  let account_stakes;
  let totalStakeBet365 = parseFloat(document.getElementById('new-stake-bet365').value) || 0;
  if (useCustomStakes && account_ids.length > 0) {
    account_stakes = [];
    let sum = 0;
    for (const cb of checkedBoxes) {
      const accId = Number(cb.dataset.accountId);
      const inp = document.querySelector(`#new-accounts-list input.per-account-stake[data-account-id="${accId}"]`);
      const stake = parseFloat(inp?.value) || 0;
      sum += stake;
      account_stakes.push({ account_id: accId, stake });
    }
    totalStakeBet365 = sum;
  }

  const isBR = type === 'arbitragem_br';
  const body = {
    type,
    game: document.getElementById('new-game').value.trim(),
    event_date: document.getElementById('new-event-date').value,
    stake_bet365: isBR ? 0 : totalStakeBet365,
    odd_bet365: isBR ? 0 : (parseFloat(document.getElementById('new-odd-bet365').value) || 0),
    stake_poly_usd: isBR ? 0 : (parseFloat(document.getElementById('new-stake-poly-usd').value) || 0),
    odd_poly: isBR ? 0 : (parseFloat(document.getElementById('new-odd-poly').value) || 0),
    exchange_rate: isBR ? 1 : (parseFloat(document.getElementById('new-exchange-rate').value) || 5.0),
    result: document.getElementById('new-result').value,
    profit: parseFloat(document.getElementById('new-profit').value) || 0,
    notes: document.getElementById('new-notes').value.trim(),
    tags: getTagsFromInput('new-tags'),
    uses_freebet: isBR ? false : (document.getElementById('new-uses-freebet')?.checked || false),
    freebet_account_id: (!isBR && document.getElementById('new-uses-freebet')?.checked)
      ? (document.getElementById('new-freebet-account')?.value || null) : null,
  };
  if (type === 'aumentada25') {
    body.extra_bets = collectExtraBets();
  } else if (isBR) {
    const legs = collectBrLegs();
    if (legs.length < 2) { toast('Registre pelo menos 2 apostas', 'error'); return; }
    body.extra_bets = legs;
  }
  if (isBR) {
    body.account_ids = [];
  } else if (account_stakes) {
    body.account_stakes = account_stakes;
  } else {
    body.account_ids = account_ids;
  }

  try {
    await api('/api/operations', { method: 'POST', body });
    toast('Operação registrada com sucesso!');
    navigate('dashboard');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Toggle custom per-account stake mode ('new' or 'edit')
function toggleCustomStakes(mode) {
  const prefix = mode === 'new' ? 'new' : 'edit';
  const listId = mode === 'new' ? 'new-accounts-list' : 'edit-accounts-list';
  const toggle = document.getElementById(`${prefix}-custom-stakes-toggle`);
  const stakeInputs = document.querySelectorAll(`#${listId} .per-account-stake`);
  const totalInput = document.getElementById(`${prefix}-stake-bet365`);
  const enabled = toggle?.checked;
  stakeInputs.forEach(inp => { inp.style.display = enabled ? '' : 'none'; });
  if (totalInput) {
    totalInput.readOnly = enabled;
    totalInput.style.opacity = enabled ? '0.7' : '';
    totalInput.title = enabled ? 'Calculado automaticamente a partir das stakes por conta' : '';
  }
  if (enabled) onPerAccountStakeChange(mode);
  // Update info text for 'new' mode
  if (mode === 'new') {
    const info = document.getElementById('stake-per-account-info');
    if (info && enabled) info.textContent = 'Stake personalizado ativo — defina o valor de cada conta';
  }
}

function onPerAccountStakeChange(mode) {
  const prefix = mode === 'new' ? 'new' : 'edit';
  const listId = mode === 'new' ? 'new-accounts-list' : 'edit-accounts-list';
  const toggle = document.getElementById(`${prefix}-custom-stakes-toggle`);
  if (!toggle?.checked) return;
  const totalInput = document.getElementById(`${prefix}-stake-bet365`);
  const checked = document.querySelectorAll(`#${listId} input[name="accounts"]:checked, #${listId} input[name="edit-accounts"]:checked`);
  let sum = 0;
  for (const cb of checked) {
    const accId = Number(cb.dataset.accountId || cb.value);
    const inp = document.querySelector(`#${listId} input.per-account-stake[data-account-id="${accId}"]`);
    sum += parseFloat(inp?.value) || 0;
  }
  if (totalInput) totalInput.value = sum ? sum.toFixed(2) : '';
}

// Wrapper: toggle checked state, but ignore clicks on the per-account stake input
function accountCheckClick(event, label) {
  if (event.target.classList.contains('per-account-stake')) return;
  if (event.target.tagName === 'INPUT' && event.target.type !== 'checkbox') return;
  label.classList.toggle('checked');
}

// ===== HISTORY =====
let historyPage = 0;
const PAGE_SIZE = 20;

async function renderHistory() {
  historyPage = 0;
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Histórico</h1>
        <p class="page-description">Todas as suas operações</p>
      </div>
      <button class="btn btn-primary" onclick="navigate('new-operation')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Nova Operação
      </button>
    </div>
    <div class="filters-bar" style="flex-wrap:wrap">
      <select class="form-select" id="filter-type" onchange="loadHistory()">
        <option value="">Todos os tipos</option>
        <option value="aquecimento">Aquecimento</option>
        <option value="arbitragem">Arbitragem</option>
        <option value="aumentada25">Aumentada 25%</option>
        <option value="arbitragem_br">Arbitragem BR</option>
      </select>
      <select class="form-select" id="filter-tag" onchange="loadHistory()">
        <option value="">Todas tags</option>
      </select>
      <input type="date" class="form-input" id="filter-from" onchange="loadHistory()">
      <input type="date" class="form-input" id="filter-to" onchange="loadHistory()">
      <div class="date-presets" style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('today')">Hoje</button>
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('7d')">7d</button>
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('30d')">30d</button>
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('month')">Este mês</button>
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('last-month')">Mês passado</button>
        <button class="btn btn-ghost btn-sm" onclick="applyDatePreset('year')">Ano</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="clearFilters()">Limpar</button>
    </div>
    <div class="table-container">
      <div id="history-table"></div>
      <div class="pagination" id="history-pagination"></div>
    </div>
    <div id="history-summary" class="stat-card" style="margin-top:16px"></div>
  `;
  loadHistory();
}

async function loadHistory() {
  const type = document.getElementById('filter-type').value;
  const tag = document.getElementById('filter-tag').value;
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: historyPage * PAGE_SIZE });
  if (type) params.append('type', type);
  if (tag) params.append('tag', tag);
  if (from) params.append('from', from);
  if (to) params.append('to', to);

  try {
    const { operations, total, allTags } = await api(`/api/operations?${params}`);

    // Populate tag filter dropdown
    const tagSelect = document.getElementById('filter-tag');
    if (tagSelect && allTags) {
      const currentTag = tagSelect.value;
      allKnownTags = allTags;
      tagSelect.innerHTML = '<option value="">Todas tags</option>' +
        allTags.map(t => `<option value="${t}" ${t === currentTag ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
    }

    renderHistoryTable(operations);
    renderPagination(total);
    const totalProfit = operations.reduce((s, o) => s + o.profit, 0);
    document.getElementById('history-summary').innerHTML = `
      <div style="display:flex;gap:32px;align-items:center">
        <div><div class="stat-label">Total na Página</div><div class="stat-value ${profitClass(totalProfit)}">${formatBRL(totalProfit)}</div></div>
        <div><div class="stat-label">Operações</div><div class="stat-value">${total}</div></div>
      </div>
    `;
  } catch (err) { toast(err.message, 'error'); }
}

function renderHistoryTable(ops) {
  const container = document.getElementById('history-table');
  if (!ops.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&#128270;</div><div class="empty-state-text">Nenhuma operação encontrada</div></div>`;
    return;
  }
  container.innerHTML = `
    <table>
      <thead><tr>
        <th>Data</th><th>Jogo</th><th>Tipo</th><th>Tags</th><th>Stake B365</th><th>Stake Poly</th><th>Contas</th><th>Lucro</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${ops.map(op => {
          const isBR = op.type === 'arbitragem_br';
          const br = isBR ? brLegsSummary(op) : null;
          return `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
          <td>${renderTagsDisplay(op.tags)}</td>
          <td>${isBR ? formatBRL(br.totalStake) : formatBRL(op.stake_bet365)}</td>
          <td>${isBR ? '<span style="color:var(--text-muted)">—</span>' : `${formatUSD(op.stake_poly_usd)} <span class="currency-tag">USD</span>`}</td>
          <td style="font-size:12px">${isBR ? (br.bookmakers.map(escapeHtml).join(', ') || '-') : ((op.accounts || []).map(a => escapeHtml(a.name)).join(', ') || '-')}</td>
          <td class="${profitClass(op.profit)}">${formatBRL(op.profit)}</td>
          <td><span class="badge badge-${op.result === 'pending' ? 'pending' : 'won'}">${resultLabel(op.result)}</span></td>
          <td>
            <div class="action-btns">
              <button onclick="duplicateOperation(${op.id})" title="Duplicar">&#128203;</button>
              <button onclick="openWhatIf(${op.id})" title="Simular what-if">&#128302;</button>
              <button onclick="openEditModal(${op.id})" title="Editar">&#9998;</button>
              <button class="delete" onclick="deleteOperation(${op.id})" title="Excluir">&#128465;</button>
            </div>
          </td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderPagination(total) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const container = document.getElementById('history-pagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <button ${historyPage === 0 ? 'disabled' : ''} onclick="historyPage--;loadHistory()">Anterior</button>
    <span>Página ${historyPage + 1} de ${totalPages}</span>
    <button ${historyPage >= totalPages - 1 ? 'disabled' : ''} onclick="historyPage++;loadHistory()">Próxima</button>
  `;
}

function clearFilters() {
  document.getElementById('filter-type').value = '';
  document.getElementById('filter-tag').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  historyPage = 0;
  loadHistory();
}

function applyDatePreset(preset) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let from, to;
  switch (preset) {
    case 'today':      from = today; to = today; break;
    case '7d':         from = new Date(today); from.setDate(from.getDate() - 6); to = today; break;
    case '30d':        from = new Date(today); from.setDate(from.getDate() - 29); to = today; break;
    case 'month':      from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; break;
    case 'last-month': from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                       to   = new Date(today.getFullYear(), today.getMonth(), 0); break;
    case 'year':       from = new Date(today.getFullYear(), 0, 1); to = today; break;
    default: return;
  }
  document.getElementById('filter-from').value = fmt(from);
  document.getElementById('filter-to').value = fmt(to);
  historyPage = 0;
  loadHistory();
}

// ===== WHAT-IF SIMULATOR =====
// Non-destructive "o que aconteceria se..." — uses SurebetMath.computeProfit
// (same math the create/edit form uses for auto-fill) against live inputs.
// Scoped to the 2-leg types (aquecimento/arbitragem) because computeProfit
// covers them cleanly; for aumentada25/arbitragem_br the UI explains why.
let _whatIfOp = null;

async function openWhatIf(id) {
  try {
    const { operations } = await api('/api/operations?limit=999');
    const op = operations.find(o => o.id === id);
    if (!op) { toast('Operação não encontrada', 'error'); return; }
    _whatIfOp = op;
    renderWhatIfModal(op);
  } catch (err) { toast(err.message, 'error'); }
}

function closeWhatIf() {
  const el = document.getElementById('whatif-modal');
  if (el) el.remove();
  _whatIfOp = null;
}

function renderWhatIfModal(op) {
  const supported = op.type === 'aquecimento' || op.type === 'arbitragem';
  const unsupportedNote = supported ? '' : `
    <div style="padding:12px;background:var(--surface2);border:1px solid var(--warning);border-radius:6px;margin-bottom:12px;font-size:13px">
      Tipo <b>${escapeHtml(typeLabel(op.type))}</b> usa apostas extras — use a calculadora completa para simular esse cenário.
    </div>`;

  const fx = op.exchange_rate || 5.0;
  const body = `
    ${unsupportedNote}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">ORIGINAL</div>
        <div class="form-group"><label class="form-label">Stake Bet365 (R$)</label>
          <input type="number" class="form-input" value="${op.stake_bet365}" disabled></div>
        <div class="form-group"><label class="form-label">Odd Bet365</label>
          <input type="number" class="form-input" value="${op.odd_bet365}" disabled></div>
        <div class="form-group"><label class="form-label">Stake Poly (USD)</label>
          <input type="number" class="form-input" value="${op.stake_poly_usd}" disabled></div>
        <div class="form-group"><label class="form-label">Odd Poly</label>
          <input type="number" class="form-input" value="${op.odd_poly}" disabled></div>
        <div class="form-group"><label class="form-label">Resultado</label>
          <input type="text" class="form-input" value="${resultLabel(op.result)}" disabled></div>
        <div class="form-group"><label class="form-label">Lucro</label>
          <input type="text" class="form-input ${profitClass(op.profit)}" value="${formatBRL(op.profit)}" disabled></div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--primary);margin-bottom:8px">WHAT-IF</div>
        <div class="form-group"><label class="form-label">Stake Bet365 (R$)</label>
          <input type="number" step="0.01" class="form-input" id="wi-sb" value="${op.stake_bet365}" oninput="whatIfRecompute()" ${supported ? '' : 'disabled'}></div>
        <div class="form-group"><label class="form-label">Odd Bet365</label>
          <input type="number" step="0.01" class="form-input" id="wi-ob" value="${op.odd_bet365}" oninput="whatIfRecompute()" ${supported ? '' : 'disabled'}></div>
        <div class="form-group"><label class="form-label">Stake Poly (USD)</label>
          <input type="number" step="0.01" class="form-input" id="wi-sp" value="${op.stake_poly_usd}" oninput="whatIfRecompute()" ${supported ? '' : 'disabled'}></div>
        <div class="form-group"><label class="form-label">Odd Poly</label>
          <input type="number" step="0.01" class="form-input" id="wi-op" value="${op.odd_poly}" oninput="whatIfRecompute()" ${supported ? '' : 'disabled'}></div>
        <div class="form-group"><label class="form-label">Resultado</label>
          <select class="form-select" id="wi-result" onchange="whatIfRecompute()" ${supported ? '' : 'disabled'}>
            <option value="bet365_won" ${op.result === 'bet365_won' ? 'selected' : ''}>Bet365 ganhou</option>
            <option value="poly_won" ${op.result === 'poly_won' ? 'selected' : ''}>Poly ganhou</option>
            <option value="void" ${op.result === 'void' ? 'selected' : ''}>Void</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Lucro simulado</label>
          <input type="text" class="form-input" id="wi-profit" value="—" disabled></div>
        <div class="form-group"><label class="form-label">Diferença vs original</label>
          <input type="text" class="form-input" id="wi-diff" value="—" disabled></div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted)">FX: ${fx.toFixed(4)} · simulação não altera dados reais</div>`;

  const overlay = document.createElement('div');
  overlay.id = 'whatif-modal';
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `
    <div class="modal" style="max-width:760px">
      <div class="modal-header">
        <h3 class="modal-title">🔮 Simulador What-If · ${escapeHtml(op.game || '')}</h3>
        <button class="modal-close" onclick="closeWhatIf()">&times;</button>
      </div>
      ${body}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeWhatIf()">Fechar</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWhatIf(); });
  document.body.appendChild(overlay);
  if (supported) whatIfRecompute();
}

function whatIfRecompute() {
  if (!_whatIfOp) return;
  const sb = parseFloat(document.getElementById('wi-sb').value) || 0;
  const ob = parseFloat(document.getElementById('wi-ob').value) || 0;
  const sp = parseFloat(document.getElementById('wi-sp').value) || 0;
  const op = parseFloat(document.getElementById('wi-op').value) || 0;
  const result = document.getElementById('wi-result').value;
  const fx = _whatIfOp.exchange_rate || 5.0;
  const profit = window.SurebetMath.computeProfit(sb, ob, sp, op, fx, result);
  const profitEl = document.getElementById('wi-profit');
  const diffEl = document.getElementById('wi-diff');
  if (profit == null) {
    profitEl.value = '—';
    diffEl.value = '—';
    return;
  }
  profitEl.value = formatBRL(profit);
  profitEl.className = `form-input ${profitClass(profit)}`;
  const diff = profit - (_whatIfOp.profit || 0);
  diffEl.value = (diff >= 0 ? '+' : '') + formatBRL(diff);
  diffEl.className = `form-input ${profitClass(diff)}`;
}

// ===== DUPLICATE OPERATION =====
async function duplicateOperation(id) {
  try {
    const { operations } = await api('/api/operations?limit=999');
    const op = operations.find(o => o.id === id);
    if (!op) { toast('Opera\u00E7\u00E3o n\u00E3o encontrada', 'error'); return; }

    const accs = op.accounts || [];
    let extras = [];
    if (op.extra_bets) {
      try { extras = JSON.parse(op.extra_bets) || []; } catch { extras = []; }
    }
    window._calcImport = {
      type: op.type,
      stakeBet365: op.stake_bet365,
      oddBet365: op.odd_bet365,
      usesFreebet: !!op.uses_freebet,
      freebetAccountId: op.freebet_account_id || null,
      extraBets: extras,
      stakePolyUSD: op.stake_poly_usd,
      oddPoly: op.odd_poly,
      exchangeRate: op.exchange_rate,
      notes: op.notes || '',
      game: op.game || '',
      eventDate: op.event_date || '',
      accountIds: accs.map(a => a.id),
      accountStakes: accs.some(a => a.stake != null)
        ? accs.map(a => ({ account_id: a.id, stake: a.stake }))
        : null,
      tags: op.tags || [],
    };
    navigate('new-operation');
    toast('Opera\u00E7\u00E3o duplicada! Ajuste os dados e salve.', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ===== EDIT MODAL =====
async function openEditModal(id) {
  try {
    await loadAccounts();
    const { operations, allTags } = await api(`/api/operations?limit=999`);
    if (allTags) allKnownTags = allTags;
    const op = operations.find(o => o.id === id);
    if (!op) { toast('Operação não encontrada', 'error'); return; }
    fillEditModal(op);
    document.getElementById('edit-modal').classList.add('active');
  } catch (err) { toast(err.message, 'error'); }
}

function fillEditModal(op) {
  const isBR = op.type === 'arbitragem_br';
  document.getElementById('edit-id').value = op.id;
  document.getElementById('edit-type').value = op.type;
  document.getElementById('edit-game').value = op.game;
  document.getElementById('edit-event-date').value = op.event_date || '';
  document.getElementById('edit-result').value = op.result;
  document.getElementById('edit-stake-bet365').value = op.stake_bet365;
  document.getElementById('edit-odd-bet365').value = op.odd_bet365;
  document.getElementById('edit-stake-poly-usd').value = op.stake_poly_usd;
  document.getElementById('edit-odd-poly').value = op.odd_poly;
  document.getElementById('edit-exchange-rate').value = op.exchange_rate;
  document.getElementById('edit-profit').value = op.profit;
  document.getElementById('edit-notes').value = op.notes || '';
  const editFb = document.getElementById('edit-uses-freebet');
  if (editFb) editFb.checked = !!op.uses_freebet;

  // Freebet account picker for main bet
  const fbAcctSel = document.getElementById('edit-freebet-account');
  if (fbAcctSel) fbAcctSel.innerHTML = freebetAccountOptions(op.freebet_account_id);
  const fbAcctWrap = document.getElementById('edit-freebet-account-wrap');
  if (fbAcctWrap) fbAcctWrap.style.display = op.uses_freebet ? '' : 'none';

  // Extra bets editor (aumentada25 only)
  const editExtraSection = document.getElementById('edit-extra-bets-section');
  const editExtraList = document.getElementById('edit-extra-bets-list');
  const isAumentada = op.type === 'aumentada25';
  if (editExtraSection) editExtraSection.style.display = isAumentada ? '' : 'none';
  if (editExtraList && isAumentada) {
    editExtraList.innerHTML = '';
    const extras = parseExtraBets(op);
    if (extras.length) {
      extras.forEach(b => addExtraBet(b, 'edit-extra-bets-list'));
    } else {
      addExtraBet({}, 'edit-extra-bets-list');
      addExtraBet({}, 'edit-extra-bets-list');
    }
  }

  // Toggle bet365/poly fields vs BR leg summary.
  document.querySelectorAll('#edit-form .edit-bp-field').forEach(el => { el.style.display = isBR ? 'none' : ''; });
  const brWrap = document.getElementById('edit-br-legs-wrap');
  if (brWrap) brWrap.style.display = isBR ? '' : 'none';
  if (isBR) {
    const { legs, totalStake } = brLegsSummary(op);
    const view = document.getElementById('edit-br-legs-view');
    if (view) {
      view.innerHTML = legs.length
        ? legs.map(l => `
          <div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid var(--border)">
            <span>${escapeHtml(l.bookmaker || '—')}</span>
            <span>${formatBRL(l.stake)} @ ${Number(l.odd || 0).toFixed(2)}</span>
          </div>
        `).join('') + `<div style="display:flex;justify-content:space-between;padding-top:6px;font-weight:600"><span>Total</span><span>${formatBRL(totalStake)}</span></div>`
        : '<span>Sem apostas registradas.</span>';
    }
  }

  // Result select: hide bet365/poly options for BR, show won option.
  const resSel = document.getElementById('edit-result');
  if (resSel) {
    for (const opt of resSel.options) {
      if (opt.dataset.for === 'bet365-poly') opt.hidden = isBR;
      if (opt.dataset.for === 'br') opt.hidden = !isBR;
    }
  }

  // Reset auto-profit info
  const autoProfitInfo = document.getElementById('edit-auto-profit-info');
  if (autoProfitInfo) autoProfitInfo.style.display = 'none';

  // Build accounts checklist (with per-account stake inputs)
  const opAccounts = op.accounts || [];
  const opAccountIds = opAccounts.map(a => a.id);
  const accountStakeMap = {};
  let hasCustomStakes = false;
  for (const a of opAccounts) {
    if (a.stake != null) { accountStakeMap[a.id] = a.stake; hasCustomStakes = true; }
  }

  const container = document.getElementById('edit-accounts-list');
  const activeAccounts = userAccounts.filter(a => a.active);

  // Insert toggle above the list (outside, via parent)
  const parentGroup = container.parentElement;
  let toggleLabel = document.getElementById('edit-custom-stakes-wrap');
  if (!toggleLabel) {
    toggleLabel = document.createElement('label');
    toggleLabel.id = 'edit-custom-stakes-wrap';
    toggleLabel.className = 'account-check';
    toggleLabel.style.cssText = 'margin-bottom:12px;cursor:pointer;display:inline-flex';
    toggleLabel.innerHTML = `
      <input type="checkbox" id="edit-custom-stakes-toggle" onchange="toggleCustomStakes('edit')">
      <div class="account-check-dot"></div>
      <div style="font-size:13px">Usar stake personalizado por conta</div>
    `;
    parentGroup.insertBefore(toggleLabel, container);
  }
  const toggleInput = document.getElementById('edit-custom-stakes-toggle');
  if (toggleInput) toggleInput.checked = hasCustomStakes;

  container.innerHTML = activeAccounts.map(acc => {
    const checked = opAccountIds.includes(acc.id);
    const stakeVal = accountStakeMap[acc.id];
    const stakeStr = stakeVal != null ? Number(stakeVal).toFixed(2) : '';
    return `
      <label class="account-check ${checked ? 'checked' : ''}" onclick="accountCheckClick(event, this)">
        <input type="checkbox" name="edit-accounts" value="${acc.id}" data-account-id="${acc.id}" ${checked ? 'checked' : ''}>
        <div class="account-check-dot"></div>
        <div style="flex:1">${escapeHtml(acc.name)}</div>
        <input type="number" step="0.01" min="0" class="form-input per-account-stake"
          data-account-id="${acc.id}"
          placeholder="R$"
          value="${stakeStr}"
          style="display:${hasCustomStakes ? '' : 'none'};width:100px;margin-left:8px"
          onclick="event.stopPropagation()"
          oninput="onPerAccountStakeChange('edit')">
      </label>
    `;
  }).join('') || '<span style="color:var(--text-muted);font-size:13px">Nenhuma conta cadastrada</span>';

  if (hasCustomStakes) {
    const totalEl = document.getElementById('edit-stake-bet365');
    if (totalEl) { totalEl.readOnly = true; totalEl.style.opacity = '0.7'; }
  }

  // Init tags
  initTagInput('edit-tags', op.tags || []);

  // Wire up auto-profit for edit modal
  wireEditAutoProfit(op.result);
}

function wireEditAutoProfit(_originalResult) {
  const resultSelect = document.getElementById('edit-result');
  const stakeBet365 = document.getElementById('edit-stake-bet365');
  const oddBet365 = document.getElementById('edit-odd-bet365');
  const stakePolyUsd = document.getElementById('edit-stake-poly-usd');
  const oddPoly = document.getElementById('edit-odd-poly');
  const exchangeRate = document.getElementById('edit-exchange-rate');
  const autoProfitInfo = document.getElementById('edit-auto-profit-info');

  // Show a non-destructive suggestion instead of overwriting the user's profit value.
  // The user can click the button to apply the calculated profit if they agree.
  function updateEditAutoProfit() {
    if (!autoProfitInfo) return;
    const result = resultSelect?.value;
    const type = document.getElementById('edit-type')?.value;
    if (result === 'pending' || type === 'arbitragem_br') { autoProfitInfo.style.display = 'none'; return; }
    const p = computeProfit(
      stakeBet365?.value, oddBet365?.value,
      stakePolyUsd?.value, oddPoly?.value,
      exchangeRate?.value, result
    );
    if (p === null) { autoProfitInfo.style.display = 'none'; return; }
    const label = result === 'void'
      ? 'Sugestão: lucro 0 (anulado)'
      : `Sugestão: ${formatBRL(p)} (${result === 'bet365_won' ? 'Bet365 ganhou' : 'Poly ganhou'})`;
    autoProfitInfo.innerHTML = `
      <span style="color:${p >= 0 ? 'var(--success)' : 'var(--danger)'}">${label}</span>
      <button type="button" class="btn btn-ghost btn-sm" style="margin-left:8px;padding:2px 8px;font-size:11px"
        onclick="document.getElementById('edit-profit').value='${p.toFixed(2)}'">Aplicar</button>
    `;
    autoProfitInfo.style.display = 'block';
  }

  resultSelect?.addEventListener('change', updateEditAutoProfit);
  [stakeBet365, oddBet365, stakePolyUsd, oddPoly, exchangeRate].forEach(el => {
    el?.addEventListener('input', () => {
      if (resultSelect?.value !== 'pending') updateEditAutoProfit();
    });
  });
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.remove('active');
}

document.getElementById('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const checkedBoxes = document.querySelectorAll('#edit-accounts-list input[name="edit-accounts"]:checked');
  const account_ids = Array.from(checkedBoxes).map(cb => Number(cb.value));

  const useCustomStakes = document.getElementById('edit-custom-stakes-toggle')?.checked;
  let account_stakes;
  if (useCustomStakes) {
    account_stakes = [];
    for (const cb of checkedBoxes) {
      const accId = Number(cb.value);
      const inp = document.querySelector(`#edit-accounts-list input.per-account-stake[data-account-id="${accId}"]`);
      const raw = inp?.value;
      const stake = raw !== '' && raw != null ? parseFloat(raw) : null;
      account_stakes.push({ account_id: accId, stake });
    }
  }

  const body = {
    type: document.getElementById('edit-type').value,
    game: document.getElementById('edit-game').value,
    event_date: document.getElementById('edit-event-date').value,
    result: document.getElementById('edit-result').value,
    stake_bet365: parseFloat(document.getElementById('edit-stake-bet365').value) || 0,
    odd_bet365: parseFloat(document.getElementById('edit-odd-bet365').value) || 0,
    stake_poly_usd: parseFloat(document.getElementById('edit-stake-poly-usd').value) || 0,
    odd_poly: parseFloat(document.getElementById('edit-odd-poly').value) || 0,
    exchange_rate: parseFloat(document.getElementById('edit-exchange-rate').value) || 5.0,
    profit: parseFloat(document.getElementById('edit-profit').value) || 0,
    notes: document.getElementById('edit-notes').value,
    tags: getTagsFromInput('edit-tags'),
    uses_freebet: !!document.getElementById('edit-uses-freebet')?.checked,
    freebet_account_id: document.getElementById('edit-uses-freebet')?.checked
      ? (document.getElementById('edit-freebet-account')?.value || null) : null,
  };
  // Send extra_bets for aumentada25 edits
  const editType = document.getElementById('edit-type')?.value;
  if (editType === 'aumentada25') {
    body.extra_bets = collectExtraBets('edit-extra-bets-list');
  }
  if (account_stakes) body.account_stakes = account_stakes;
  else body.account_ids = account_ids;

  try {
    await api(`/api/operations/${id}`, { method: 'PUT', body });
    toast('Operação atualizada!');
    closeEditModal();
    loadHistory();
  } catch (err) { toast(err.message, 'error'); }
});

async function deleteOperation(id) {
  if (!confirm('Tem certeza que deseja excluir esta operação?')) return;
  try {
    const r = await api(`/api/operations/${id}`, { method: 'DELETE' });
    loadHistory();
    toast('Operação excluída', 'success', {
      actionLabel: 'Desfazer',
      duration: 8000,
      onAction: async () => {
        try {
          await api('/api/operations', { method: 'POST', body: JSON.stringify(r.snapshot) });
          toast('Operação restaurada');
          loadHistory();
        } catch (err) { toast(err.message, 'error'); }
      },
    });
  } catch (err) { toast(err.message, 'error'); }
}

// ===== SETTINGS =====
async function renderSettings() {
  await loadAccounts();

  // Fetch ranking preference
  let showInRanking = true;
  let showInGirosRanking = true;
  try {
    const pref = await api('/api/ranking/me');
    showInRanking = !!pref.show_in_ranking;
    showInGirosRanking = pref.show_in_giros_ranking === undefined ? true : !!pref.show_in_giros_ranking;
  } catch (_) {}

  // Fetch Polymarket wallet/notification prefs
  let polyPrefs = { poly_wallet_address: '', notify_fill_order: false, notify_fill_limit_order: false, notify_redeem: false };
  try { polyPrefs = await api('/api/settings/poly'); } catch (_) {}

  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Configura\u00E7\u00F5es</h1>
        <p class="page-description">Gerencie suas contas e prefer\u00EAncias</p>
      </div>
    </div>

    <!-- Discord -->
    <div class="chart-container" style="margin-bottom:20px">
      <h3 class="chart-title" style="margin-bottom:12px">Discord</h3>
      ${currentUser.discord_id ? `
        <div class="discord-profile">
          <img src="${getDiscordAvatarUrl(currentUser.discord_id, currentUser.discord_avatar, 80) || ''}"
            onerror="this.style.display='none'" alt="Avatar">
          <div class="discord-profile-info">
            <div class="discord-profile-name">${escapeHtml(currentUser.discord_username || '')}</div>
            <div class="discord-profile-id">ID: ${currentUser.discord_id}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="unlinkDiscord()" style="color:var(--danger)">Desvincular</button>
        </div>
        <p style="color:var(--text-muted);font-size:12px;margin-top:8px">
          Seu avatar e nome do Discord aparecer\u00E3o no Ranking.
        </p>
      ` : `
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          Vincule seu Discord para exibir seu avatar e nome no ranking do grupo.
        </p>
        <button class="btn-discord" onclick="linkDiscord()" style="width:auto;padding:8px 20px">
          <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.8 40.8 0 00-1.8 3.7 54 54 0 00-16.2 0A26.5 26.5 0 0025.4.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.5 5a.2.2 0 00-.1 0C1.5 18 -.9 30.6.3 43a.2.2 0 00.1.2A58.7 58.7 0 0018 54.7a.2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.6 38.6 0 01-5.5-2.6.2.2 0 01 0-.4l1.1-.9a.2.2 0 01.2 0 41.9 41.9 0 0035.6 0 .2.2 0 01.2 0l1.1.9a.2.2 0 010 .3 36.2 36.2 0 01-5.5 2.7.2.2 0 00-.1.3 47.2 47.2 0 003.6 5.8.2.2 0 00.3.1A58.5 58.5 0 0070.6 43.2a.2.2 0 00.1-.1c1.4-14.7-2.4-27.5-10.2-38.8a.2.2 0 00-.1 0zM23.7 35.6c-3.4 0-6.1-3.1-6.1-6.9s2.7-6.9 6.1-6.9 6.2 3.1 6.1 6.9c0 3.8-2.7 6.9-6.1 6.9zm22.6 0c-3.4 0-6.1-3.1-6.1-6.9s2.7-6.9 6.1-6.9 6.2 3.1 6.1 6.9c0 3.8-2.7 6.9-6.1 6.9z"/></svg>
          Vincular Discord
        </button>
      `}
    </div>

    <!-- Ranking toggle -->
    <div class="chart-container" style="margin-bottom:20px">
      <h3 class="chart-title" style="margin-bottom:12px">Ranking</h3>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-show-ranking" ${showInRanking ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer"
            onchange="toggleRankingVisibility('show_in_ranking', this.checked)">
          Exibir meu lucro no ranking do grupo
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-show-giros-ranking" ${showInGirosRanking ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer"
            onchange="toggleRankingVisibility('show_in_giros_ranking', this.checked)">
          Exibir meu lucro no ranking de Giros (Sortudos)
        </label>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:6px">
        Quando desativado, seu perfil n\u00E3o aparecer\u00E1 no ranking correspondente.
      </p>
    </div>

    <!-- Polymarket Wallet + Notifications -->
    <div class="chart-container" style="margin-bottom:20px">
      <h3 class="chart-title" style="margin-bottom:4px">Wallet Polymarket</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
        Preencha sua wallet para receber notifica\u00E7\u00F5es da sua atividade no Polymarket.
      </p>
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label">Endere\u00E7o da Wallet</label>
        <input type="text" class="form-input" id="setting-poly-wallet"
          placeholder="0x..."
          value="${escapeHtml(polyPrefs.poly_wallet_address || '')}">
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-notify-fill" ${polyPrefs.notify_fill_order ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer">
          Notificar fill order (ordem executada no mercado)
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-notify-fill-limit" ${polyPrefs.notify_fill_limit_order ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer">
          Notificar fill limit order (ordem limit executada)
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-notify-redeem" ${polyPrefs.notify_redeem ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer">
          Notificar redeem dispon\u00EDvel (aposta vencedora pronta para sacar)
        </label>
      </div>
      <button class="btn btn-primary" onclick="savePolySettings()">Salvar prefer\u00EAncias</button>
    </div>

    <!-- Wallet import/export -->
    <div class="chart-container" style="margin-bottom:20px">
      <h3 class="chart-title" style="margin-bottom:4px">Wallets do Watcher</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
        Importe ou exporte a lista de wallets monitoradas para compartilhar com outros membros do grupo.
      </p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="exportWallets()" id="export-wallets-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Exportar Wallets
        </button>
        <label class="btn btn-primary" style="cursor:pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Importar Wallets
          <input type="file" accept=".json,.txt" style="display:none" onchange="importWallets(this)">
        </label>
      </div>
      <div id="wallet-import-result" style="margin-top:10px"></div>
    </div>

    <!-- Tag rules -->
    <div class="chart-container" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px">
        <h3 class="chart-title" style="margin:0">Regras de Tags automáticas</h3>
        <button class="btn btn-primary btn-sm" onclick="openTagRuleModal()">+ Nova regra</button>
      </div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
        Atribui tags automaticamente a operações que batam com as condições. Avaliado ao criar e editar operação.
      </p>
      <div id="tag-rules-list"><div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Carregando...</div></div>
    </div>

    <!-- Bet365 accounts -->
    <div class="chart-container">
      <h3 class="chart-title" style="margin-bottom:4px">Contas Bet365</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        Cada conta tem seu pr\u00F3prio volume semanal de R$ 1.500 para a freebet e um stake m\u00E1ximo para aumentadas.
      </p>

      <div id="accounts-list-settings"></div>

      <div style="border-top:1px solid var(--border);padding-top:20px;margin-top:12px">
        <h4 style="font-size:14px;font-weight:600;margin-bottom:16px">Adicionar Nova Conta</h4>
        <form id="add-account-form" class="form-grid">
          <div class="form-group">
            <label class="form-label">Nome da Conta</label>
            <input type="text" class="form-input" id="acc-name" placeholder="Ex: Conta Principal" required>
          </div>
          <div class="form-group">
            <label class="form-label">Stake M\u00E1ximo Aumentada (R$)</label>
            <input type="number" step="0.01" min="0" class="form-input" id="acc-max-stake" placeholder="250" value="250">
          </div>
          <div class="form-group">
            <button type="submit" class="btn btn-primary" style="margin-top:22px">Adicionar Conta</button>
          </div>
        </form>
      </div>
    </div>
  `;

  renderAccountsList();
  loadTagRules();

  document.getElementById('add-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('acc-name').value.trim();
    const max_stake_aumentada = parseFloat(document.getElementById('acc-max-stake').value) || 250;
    try {
      await api('/api/accounts', { method: 'POST', body: { name, max_stake_aumentada } });
      toast('Conta adicionada!');
      document.getElementById('acc-name').value = '';
      document.getElementById('acc-max-stake').value = '250';
      await loadAccounts();
      renderAccountsList();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function toggleRankingVisibility(field, checked) {
  try {
    await api('/api/ranking/me', { method: 'PUT', body: { [field]: checked } });
    const label = field === 'show_in_giros_ranking' ? 'ranking de Giros' : 'ranking';
    toast(checked ? `Seu lucro agora aparece no ${label}` : `Seu lucro foi ocultado do ${label}`);
  } catch (err) { toast(err.message, 'error'); }
}

async function savePolySettings() {
  const body = {
    poly_wallet_address: document.getElementById('setting-poly-wallet').value.trim(),
    notify_fill_order: document.getElementById('setting-notify-fill').checked,
    notify_fill_limit_order: document.getElementById('setting-notify-fill-limit').checked,
    notify_redeem: document.getElementById('setting-notify-redeem').checked,
  };
  try {
    await api('/api/settings/poly', { method: 'PUT', body });
    toast('Prefer\u00EAncias da Polymarket salvas!');
  } catch (err) { toast(err.message, 'error'); }
}

async function exportWallets() {
  try {
    const wallets = await api('/api/watcher/wallets');
    const active = wallets.filter(w => w.active);
    const exportData = active.map(w => ({ label: w.label, address: w.address }));
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wallets.json';
    a.click();
    URL.revokeObjectURL(url);
    toast(`${exportData.length} wallet(s) exportada(s)!`);
  } catch (err) { toast(err.message, 'error'); }
}

async function importWallets(input) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = document.getElementById('wallet-import-result');

  try {
    const text = await file.text();
    let wallets;
    try {
      wallets = JSON.parse(text);
    } catch (_) {
      // Try parsing as plain text: one line per wallet, format "label address" or "label,address"
      wallets = text.split('\n').filter(l => l.trim()).map(line => {
        const parts = line.includes(',') ? line.split(',') : line.split(/\s+/);
        const address = parts.pop().trim();
        const label = parts.join(' ').trim() || address;
        return { label, address };
      });
    }
    if (!Array.isArray(wallets)) wallets = [wallets];

    const result = await api('/api/watcher/wallets/import', {
      method: 'POST',
      body: { wallets }
    });

    resultEl.innerHTML = `<div style="color:var(--success);font-size:13px">${result.added} adicionada(s), ${result.skipped} ignorada(s) (duplicada/inv\u00E1lida)</div>`;
    toast(`${result.added} wallet(s) importada(s)!`);
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--danger);font-size:13px">${escapeHtml(err.message)}</div>`;
    toast(err.message, 'error');
  }
  input.value = '';
}

function renderAccountsList() {
  const container = document.getElementById('accounts-list-settings');
  if (!userAccounts.length) {
    container.innerHTML = `<div class="empty-state" style="padding:30px">
      <div class="empty-state-icon">&#127919;</div>
      <div class="empty-state-text">Nenhuma conta cadastrada</div>
      <div class="empty-state-sub">Adicione sua primeira conta Bet365 abaixo</div>
    </div>`;
    return;
  }

  container.innerHTML = userAccounts.map(acc => `
    <div class="account-card ${acc.active ? '' : 'inactive'}" id="acc-card-${acc.id}">
      <div class="account-card-left">
        <div class="account-card-icon">${escapeHtml(acc.name.charAt(0).toUpperCase())}</div>
        <div>
          <div class="account-card-name">
            ${escapeHtml(acc.name)}
            ${!acc.active ? '<span style="color:var(--danger);font-size:11px;margin-left:6px">(INATIVA)</span>' : ''}
          </div>
          <div class="account-card-meta">
            Stake máx. aumentada: <strong>${formatBRL(acc.max_stake_aumentada)}</strong>
          </div>
        </div>
      </div>
      <div class="account-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="editAccount(${acc.id})">Editar</button>
        ${acc.active
          ? `<button class="btn btn-ghost btn-sm" style="color:var(--warning, #ffa726)" onclick="toggleAccountActive(${acc.id}, false)">Desativar</button>`
          : `<button class="btn btn-ghost btn-sm" onclick="toggleAccountActive(${acc.id}, true)">Reativar</button>`}
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteAccount(${acc.id})">Remover</button>
      </div>
    </div>
  `).join('');
}

async function editAccount(id) {
  const acc = userAccounts.find(a => a.id === id);
  if (!acc) return;
  const newName = prompt('Nome da conta:', acc.name);
  if (newName === null) return;
  const newMax = prompt('Stake máximo aumentada (R$):', acc.max_stake_aumentada);
  if (newMax === null) return;

  try {
    await api(`/api/accounts/${id}`, {
      method: 'PUT',
      body: { name: newName.trim() || acc.name, max_stake_aumentada: parseFloat(newMax) || acc.max_stake_aumentada }
    });
    toast('Conta atualizada!');
    await loadAccounts();
    renderAccountsList();
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleAccountActive(id, active) {
  try {
    await api(`/api/accounts/${id}`, { method: 'PUT', body: { active } });
    toast(active ? 'Conta reativada!' : 'Conta desativada');
    await loadAccounts();
    renderAccountsList();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteAccount(id) {
  const acc = userAccounts.find(a => a.id === id);
  if (!acc) return;
  if (!confirm(`Remover a conta "${acc.name}"?\n\nO histórico de operações vinculadas será mantido, mas a conta deixará de aparecer nas listagens.`)) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    toast('Conta removida');
    await loadAccounts();
    renderAccountsList();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== TAG RULES =====
let _tagRulesCache = [];
const TAG_RULE_FIELDS = [
  { id: 'type',           label: 'Tipo',           numeric: false },
  { id: 'game',           label: 'Jogo',           numeric: false },
  { id: 'notes',          label: 'Notas',          numeric: false },
  { id: 'result',         label: 'Resultado',      numeric: false },
  { id: 'odd_bet365',     label: 'Odd Bet365',     numeric: true },
  { id: 'odd_poly',       label: 'Odd Poly',       numeric: true },
  { id: 'stake_bet365',   label: 'Stake Bet365',   numeric: true },
  { id: 'stake_poly_usd', label: 'Stake Poly USD', numeric: true },
  { id: 'profit',         label: 'Lucro',          numeric: true },
];
const TAG_RULE_NUM_OPS = [
  { id: '>',  label: '>' }, { id: '>=', label: '≥' },
  { id: '<',  label: '<' }, { id: '<=', label: '≤' },
  { id: '==', label: '=' }, { id: '!=', label: '≠' },
];
const TAG_RULE_STR_OPS = [
  { id: '==',          label: 'igual a' },
  { id: '!=',          label: 'diferente de' },
  { id: 'contains',    label: 'contém' },
  { id: 'not_contains', label: 'não contém' },
];

function tagRuleFieldLabel(id) { return (TAG_RULE_FIELDS.find(f => f.id === id) || {}).label || id; }
function tagRuleOpLabel(id) {
  return ((TAG_RULE_NUM_OPS.concat(TAG_RULE_STR_OPS)).find(o => o.id === id) || {}).label || id;
}

async function loadTagRules() {
  try {
    _tagRulesCache = await api('/api/tag-rules');
    renderTagRulesList();
  } catch (err) {
    const el = document.getElementById('tag-rules-list');
    if (el) el.innerHTML = `<div style="color:var(--danger);padding:12px;font-size:13px">${escapeHtml(err.message)}</div>`;
  }
}

function renderTagRulesList() {
  const el = document.getElementById('tag-rules-list');
  if (!el) return;
  if (!_tagRulesCache.length) {
    el.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Nenhuma regra ainda — clique em "Nova regra".</div>`;
    return;
  }
  el.innerHTML = _tagRulesCache.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div style="font-weight:600;margin-bottom:4px">${escapeHtml(r.name)} → <span class="badge">${escapeHtml(r.tag)}</span></div>
        <div style="font-size:12px;color:var(--text-muted)">
          ${(r.conditions || []).map(c => `${escapeHtml(tagRuleFieldLabel(c.field))} ${escapeHtml(tagRuleOpLabel(c.op))} ${escapeHtml(String(c.value))}`).join(' E ')}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleTagRule(${r.id}, this.checked)"
            style="width:16px;height:16px;accent-color:var(--primary)">
          Ativa
        </label>
        <button class="btn btn-ghost btn-sm" onclick="openTagRuleModal(${r.id})">Editar</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteTagRule(${r.id})">Excluir</button>
      </div>
    </div>
  `).join('');
}

async function toggleTagRule(id, enabled) {
  try {
    await api(`/api/tag-rules/${id}`, { method: 'PUT', body: { enabled } });
    const r = _tagRulesCache.find(x => x.id === id);
    if (r) r.enabled = enabled;
  } catch (err) { toast(err.message, 'error'); loadTagRules(); }
}

async function deleteTagRule(id) {
  if (!confirm('Excluir esta regra?')) return;
  try {
    await api(`/api/tag-rules/${id}`, { method: 'DELETE' });
    toast('Regra excluída');
    loadTagRules();
  } catch (err) { toast(err.message, 'error'); }
}

function openTagRuleModal(id) {
  const existing = id ? _tagRulesCache.find(r => r.id === id) : null;
  const rule = existing || { name: '', tag: '', conditions: [{ field: 'odd_bet365', op: '>', value: '' }] };

  const overlay = document.createElement('div');
  overlay.id = 'tag-rule-modal';
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header">
        <h3 class="modal-title">${existing ? 'Editar regra' : 'Nova regra'}</h3>
        <button class="modal-close" onclick="closeTagRuleModal()">&times;</button>
      </div>
      <div class="form-group">
        <label class="form-label">Nome da regra</label>
        <input type="text" class="form-input" id="tr-name" value="${escapeHtml(rule.name)}" placeholder="Ex: Odd alta">
      </div>
      <div class="form-group">
        <label class="form-label">Tag a aplicar</label>
        <input type="text" class="form-input" id="tr-tag" value="${escapeHtml(rule.tag)}" placeholder="Ex: high-odd">
      </div>
      <div class="form-group">
        <label class="form-label">Condições (todas precisam bater)</label>
        <div id="tr-conds"></div>
        <button class="btn btn-ghost btn-sm" onclick="tagRuleAddCond()" style="margin-top:8px">+ Adicionar condição</button>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeTagRuleModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="saveTagRule(${id || 'null'})">${existing ? 'Salvar' : 'Criar'}</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTagRuleModal(); });
  document.body.appendChild(overlay);
  window._tagRuleDraft = { conditions: JSON.parse(JSON.stringify(rule.conditions || [])) };
  tagRuleRenderConds();
}

function closeTagRuleModal() {
  const el = document.getElementById('tag-rule-modal');
  if (el) el.remove();
  delete window._tagRuleDraft;
}

function tagRuleAddCond() {
  window._tagRuleDraft.conditions.push({ field: 'odd_bet365', op: '>', value: '' });
  tagRuleRenderConds();
}

function tagRuleRemoveCond(idx) {
  window._tagRuleDraft.conditions.splice(idx, 1);
  if (!window._tagRuleDraft.conditions.length) tagRuleAddCond();
  else tagRuleRenderConds();
}

function tagRuleOnCondChange(idx, key, value) {
  const c = window._tagRuleDraft.conditions[idx];
  c[key] = value;
  if (key === 'field') {
    const f = TAG_RULE_FIELDS.find(x => x.id === value);
    const opsList = f?.numeric ? TAG_RULE_NUM_OPS : TAG_RULE_STR_OPS;
    if (!opsList.some(o => o.id === c.op)) c.op = opsList[0].id;
    tagRuleRenderConds();
  }
}

function tagRuleRenderConds() {
  const host = document.getElementById('tr-conds');
  if (!host) return;
  host.innerHTML = window._tagRuleDraft.conditions.map((c, i) => {
    const f = TAG_RULE_FIELDS.find(x => x.id === c.field) || TAG_RULE_FIELDS[0];
    const ops = f.numeric ? TAG_RULE_NUM_OPS : TAG_RULE_STR_OPS;
    return `
      <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;flex-wrap:wrap">
        <select class="form-select" style="max-width:160px" onchange="tagRuleOnCondChange(${i}, 'field', this.value)">
          ${TAG_RULE_FIELDS.map(x => `<option value="${x.id}" ${x.id === c.field ? 'selected' : ''}>${x.label}</option>`).join('')}
        </select>
        <select class="form-select" style="max-width:140px" onchange="tagRuleOnCondChange(${i}, 'op', this.value)">
          ${ops.map(o => `<option value="${o.id}" ${o.id === c.op ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <input type="${f.numeric ? 'number' : 'text'}" step="0.01" class="form-input" style="flex:1;min-width:120px"
          value="${escapeHtml(String(c.value ?? ''))}"
          oninput="tagRuleOnCondChange(${i}, 'value', ${f.numeric ? 'parseFloat(this.value)' : 'this.value'})">
        <button class="btn btn-ghost btn-sm" onclick="tagRuleRemoveCond(${i})" title="Remover condição">×</button>
      </div>`;
  }).join('');
}

async function saveTagRule(id) {
  const name = document.getElementById('tr-name').value.trim();
  const tag = document.getElementById('tr-tag').value.trim().toLowerCase();
  const conditions = (window._tagRuleDraft.conditions || []).filter(c =>
    c.field && c.op && c.value !== '' && c.value !== null && !(typeof c.value === 'number' && isNaN(c.value))
  );
  if (!name || !tag || !conditions.length) { toast('Nome, tag e condições são obrigatórios', 'error'); return; }
  try {
    if (id) {
      await api(`/api/tag-rules/${id}`, { method: 'PUT', body: { name, tag, conditions } });
      toast('Regra atualizada');
    } else {
      await api('/api/tag-rules', { method: 'POST', body: { name, tag, conditions } });
      toast('Regra criada');
    }
    closeTagRuleModal();
    loadTagRules();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== RANKING =====
let rankingTab = 'general'; // 'general' | 'sortudos'

async function renderRanking() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Ranking</h1>
        <p class="page-description">Membros do grupo ranqueados por lucro</p>
      </div>
    </div>
    <div class="watcher-tabs" style="margin-bottom:16px">
      <button class="watcher-tab ${rankingTab === 'general' ? 'active' : ''}" onclick="switchRankingTab('general')">Ranking Geral</button>
      <button class="watcher-tab ${rankingTab === 'sortudos' ? 'active' : ''}" onclick="switchRankingTab('sortudos')">Sortudos (Giros)</button>
    </div>
    <div class="table-container">
      <div id="ranking-content"><div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div></div>
    </div>
  `;
  loadRankingTab();
}

function switchRankingTab(tab) {
  rankingTab = tab;
  document.querySelectorAll('.watcher-tabs .watcher-tab').forEach(b => {
    b.classList.toggle('active',
      (tab === 'general' && b.textContent.includes('Geral')) ||
      (tab === 'sortudos' && b.textContent.includes('Sortudos')));
  });
  loadRankingTab();
}

async function loadRankingTab() {
  const container = document.getElementById('ranking-content');
  if (!container) return;
  container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div>`;
  try {
    const endpoint = rankingTab === 'sortudos' ? '/api/ranking/sortudos' : '/api/ranking';
    const data = await api(endpoint);
    if (!data.length) {
      const emptyText = rankingTab === 'sortudos' ? 'Nenhum giro registrado ainda' : 'Nenhum membro visivel no ranking';
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&#127942;</div><div class="empty-state-text">${emptyText}</div><div class="empty-state-sub">${rankingTab === 'sortudos' ? 'Registre giros na aba Giros' : 'Ative a visibilidade nas Configura\u00E7\u00F5es'}</div></div>`;
      return;
    }

    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px;padding:4px 0">
        ${data.map((u, i) => {
          const medal = i < 3 ? medals[i] : `<span style="color:var(--text-muted);font-weight:600;font-size:14px">${i+1}</span>`;
          const profitVal = Number(u.total_profit) || 0;
          const isMe = u.id === currentUser?.id;
          const dName = u.discord_username || u.display_name;
          const dAvatar = getDiscordAvatarUrl(u.discord_id, u.discord_avatar, 80);
          const avatarInner = dAvatar
            ? `<img src="${dAvatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.parentElement.textContent='${escapeHtml(dName.charAt(0).toUpperCase())}'"/>`
            : escapeHtml(dName.charAt(0).toUpperCase());
          const subLine = rankingTab === 'sortudos'
            ? `${u.total_giros} giro(s) registrado(s) · ${u.total_quantity || 0} giros grátis`
            : `${u.total_ops} opera\u00E7\u00F5es`;
          return `
            <div class="ranking-row ${isMe ? 'ranking-me' : ''}" style="
              display:flex;align-items:center;gap:16px;
              padding:14px 20px;
              background:var(--bg-card);
              border:1px solid ${isMe ? 'var(--primary)' : 'var(--border)'};
              border-radius:var(--radius);
              ${isMe ? 'box-shadow:0 0 12px rgba(108,92,231,.15);' : ''}
            ">
              <div style="width:36px;text-align:center;font-size:${i < 3 ? '22px' : '14px'}">${medal}</div>
              <div style="
                width:38px;height:38px;border-radius:50%;overflow:hidden;
                background:${isMe ? 'var(--primary)' : 'var(--border)'};
                display:flex;align-items:center;justify-content:center;
                font-weight:700;font-size:16px;color:${isMe ? '#fff' : 'var(--text-muted)'};
                flex-shrink:0;
              ">${avatarInner}</div>
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:15px;${isMe ? 'color:var(--primary)' : ''}">${escapeHtml(dName)}${isMe ? ' (voc\u00EA)' : ''}</div>
                <div style="font-size:12px;color:var(--text-muted)">${subLine}</div>
              </div>
              <div style="text-align:right">
                <div class="${profitClass(profitVal)}" style="font-weight:700;font-size:17px;font-family:'JetBrains Mono',monospace">${formatBRL(profitVal)}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--danger)">${escapeHtml(err.message)}</div>`;
  }
}

// ===== FREEBETS =====
// Availability is derived from operation volume — the user only interacts with
// this tab to dismiss weeks where the freebet didn't actually land or to log
// partial usage of the R$100 credit.
async function renderFreebets() {
  await loadAccounts();
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Freebets</h1>
        <p class="page-description">Freebets concedidas automaticamente ao bater R$1.500 semanais por conta</p>
      </div>
    </div>
    <div id="freebets-content"><div class="empty-state"><div class="empty-state-text">Carregando...</div></div></div>
  `;
  loadFreebets();
}

async function loadFreebets() {
  try {
    const data = await api('/api/freebets');
    const container = document.getElementById('freebets-content');
    const goal = data.weekly_goal;
    const freebetValue = data.freebet_value;

    const availableByAcc = {};
    let totalRemaining = 0, totalValue = 0, totalUsed = 0;
    for (const w of data.weeks) {
      for (const a of w.accounts) {
        if (a.available) {
          if (!availableByAcc[a.account_id]) {
            availableByAcc[a.account_id] = { name: a.account_name, weeks: [] };
          }
          availableByAcc[a.account_id].weeks.push({ ...a, week_start: w.week_start });
          totalRemaining += a.remaining;
          totalValue += freebetValue;
          totalUsed += a.used_amount;
        }
      }
    }

    const currentWeek = data.weeks.find(w => w.is_current);
    const pastWeeks = data.weeks.filter(w => !w.is_current);

    container.innerHTML = `
      <div class="stats-grid" style="margin-bottom:20px">
        <div class="stat-card">
          <div class="stat-card-label">Saldo disponível</div>
          <div class="stat-card-value">${formatBRL(totalRemaining)}</div>
          <div class="stat-card-change neutral">de ${formatBRL(totalValue)} concedidos</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-label">Total usado</div>
          <div class="stat-card-value">${formatBRL(totalUsed)}</div>
        </div>
      </div>

      <div class="chart-container" style="margin-bottom:20px">
        <h3 class="chart-title">Freebets disponíveis</h3>
        ${Object.keys(availableByAcc).length === 0
          ? `<div class="empty-state"><div class="empty-state-text">Nenhuma freebet disponível no momento</div></div>`
          : Object.entries(availableByAcc).map(([accId, info]) => `
            <div style="padding:12px 0;border-bottom:1px solid var(--border)">
              <div style="font-weight:600;margin-bottom:8px">${escapeHtml(info.name)}</div>
              ${info.weeks.map(w => freebetRow(w)).join('')}
            </div>
          `).join('')}
      </div>

      ${currentWeek && currentWeek.accounts.length ? `
      <div class="chart-container" style="margin-bottom:20px">
        <h3 class="chart-title">Progresso da semana atual (${formatDate(currentWeek.week_start)})</h3>
        ${currentWeek.accounts.map(a => {
          const pct = Math.min(100, (a.volume / goal) * 100);
          const missing = Math.max(0, goal - a.volume);
          return `
            <div style="padding:10px 0;border-bottom:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:500">${escapeHtml(a.account_name)}</div>
                <div style="font-size:13px;color:${a.earned ? 'var(--success)' : 'var(--text-muted)'}">${a.earned ? '&#10003; Freebet garantida!' : `Faltam ${formatBRL(missing)}`}</div>
              </div>
              <div style="background:var(--bg);border-radius:4px;overflow:hidden;height:6px">
                <div style="background:${a.earned ? 'var(--success)' : 'var(--primary)'};height:100%;width:${pct}%"></div>
              </div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${formatBRL(a.volume)} de ${formatBRL(goal)}</div>
            </div>
          `;
        }).join('')}
      </div>
      ` : ''}

      <div class="chart-container">
        <h3 class="chart-title">Histórico</h3>
        ${pastWeeks.filter(w => w.accounts.length).length === 0
          ? `<div class="empty-state"><div class="empty-state-text">Sem histórico ainda</div></div>`
          : pastWeeks.filter(w => w.accounts.length).map(w => `
            <div style="padding:12px 0;border-bottom:1px solid var(--border)">
              <div style="font-weight:600;margin-bottom:8px;color:var(--text-muted);font-size:13px">Semana de ${formatDate(w.week_start)}</div>
              ${w.accounts.map(a => freebetHistoryRow(a, w.week_start)).join('')}
            </div>
          `).join('')}
      </div>
    `;
  } catch (err) { toast(err.message, 'error'); }
}

function freebetRow(a) {
  return `
    <div style="display:flex;gap:12px;align-items:center;padding:8px 0;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-size:13px">Semana de ${formatDate(a.week_start)}</div>
        <div style="font-size:12px;color:var(--text-muted)">Volume: ${formatBRL(a.volume)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--text-muted)">Usado:</span>
        <input type="number" step="0.01" min="0" max="100" value="${a.used_amount}"
          style="width:90px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text)"
          onchange="updateFreebetUsed(${a.account_id}, '${a.week_start}', this.value)">
        <span style="font-size:12px;color:var(--text-muted)">/ R$ 100</span>
      </div>
      <div style="font-size:13px;color:var(--success);font-weight:500">Resta ${formatBRL(a.remaining)}</div>
      <button class="btn btn-ghost btn-sm" onclick="dismissFreebet(${a.account_id}, '${a.week_start}')" title="Não recebi a freebet">Descartar</button>
    </div>
  `;
}

function freebetHistoryRow(a, weekStart) {
  let status;
  if (a.dismissed) {
    status = `<span style="color:var(--text-muted)">Descartada</span> <a href="#" onclick="undismissFreebet(${a.account_id}, '${weekStart}');return false" style="font-size:11px;color:var(--primary)">restaurar</a>`;
  } else if (a.earned) {
    status = a.used_amount >= 100
      ? `<span style="color:var(--success)">Usada integralmente</span>`
      : a.used_amount > 0
        ? `<span style="color:var(--warning)">Parcial: ${formatBRL(a.used_amount)} / R$100</span>`
        : `<span style="color:var(--warning)">Não usada</span>`;
  } else {
    status = `<span style="color:var(--text-muted)">Volume insuficiente (${formatBRL(a.volume)})</span>`;
  }
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
      <div style="font-size:13px">${escapeHtml(a.account_name)}</div>
      <div style="font-size:12px">${status}</div>
    </div>
  `;
}

async function updateFreebetUsed(account_id, week_start, value) {
  try {
    const used_amount = Math.max(0, Math.min(100, parseFloat(value) || 0));
    await api('/api/freebets/adjust', { method: 'POST', body: { account_id, week_start, used_amount } });
    toast('Atualizado');
    loadFreebets();
  } catch (err) { toast(err.message, 'error'); }
}

async function dismissFreebet(account_id, week_start) {
  if (!confirm('Marcar essa freebet como não recebida? Ela sai do saldo disponível.')) return;
  try {
    await api('/api/freebets/adjust', { method: 'POST', body: { account_id, week_start, dismissed: true } });
    toast('Descartada');
    loadFreebets();
  } catch (err) { toast(err.message, 'error'); }
}

async function undismissFreebet(account_id, week_start) {
  try {
    await api('/api/freebets/adjust', { method: 'POST', body: { account_id, week_start, dismissed: false } });
    toast('Restaurada');
    loadFreebets();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== GIROS =====

let girosPlatforms = [];
let girosList = [];
let girosRecentOps = [];
let girosEditingId = null;

async function renderGiros() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Giros</h1>
        <p class="page-description">Registre giros grátis recebidos das plataformas</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="openGirosPlatformsModal()">Plataformas</button>
        <button class="btn btn-primary" onclick="showGiroForm()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Novo Giro
        </button>
      </div>
    </div>
    <div id="giros-form-area"></div>
    <div class="table-container">
      <div class="table-header"><h3 class="table-title">Histórico de Giros</h3></div>
      <div id="giros-list"><div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div></div>
    </div>
  `;
  await loadGirosData();
  renderGirosList();
}

async function loadGirosData() {
  try {
    const [platforms, list, ops] = await Promise.all([
      api('/api/giros/platforms'),
      api('/api/giros'),
      api('/api/operations?limit=50').catch(() => ({ operations: [] })),
    ]);
    girosPlatforms = platforms || [];
    girosList = list || [];
    girosRecentOps = (ops && ops.operations) ? ops.operations : (Array.isArray(ops) ? ops : []);
  } catch (err) { toast(err.message, 'error'); }
}

function renderGirosList() {
  const container = document.getElementById('giros-list');
  if (!container) return;
  if (!girosList.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#127775;</div>
      <div class="empty-state-text">Nenhum giro registrado</div>
      <div class="empty-state-sub">Clique em "Novo Giro" para começar</div>
    </div>`;
    return;
  }
  const total = girosList.length;
  container.innerHTML = girosList.map((g, idx) => {
    const num = total - idx;
    const opLoss = (g.operation && Number(g.operation.profit) < 0) ? Number(g.operation.profit) : 0;
    const giroProfit = Number(g.profit) || 0;
    const hasOp = !!g.operation;
    const netTotal = giroProfit + opLoss;
    const breakdown = hasOp
      ? `<div class="giro-breakdown">
           <span>Lucro giro: <b class="${profitClass(giroProfit)}">${formatBRL(giroProfit)}</b></span>
           <span>${opLoss < 0 ? 'Perda operação' : 'Resultado operação'}: <b class="${profitClass(Number(g.operation.profit))}">${formatBRL(Number(g.operation.profit))}</b></span>
           <span>Total: <b class="${profitClass(netTotal)}">${formatBRL(netTotal)}</b></span>
         </div>`
      : '';
    return `
      <div class="giro-card">
        <div class="giro-card-head">
          <div class="giro-title">Giros grátis #${num}</div>
          <div class="giro-date">${formatDate(g.created_at)}</div>
        </div>
        <div class="giro-grid">
          <div><div class="giro-k">Plataforma</div><div class="giro-v">${escapeHtml(g.platform_name || '-')}</div></div>
          <div><div class="giro-k">Quantidade</div><div class="giro-v">${g.quantity}</div></div>
          <div><div class="giro-k">Lucro giro</div><div class="giro-v ${profitClass(giroProfit)}">${formatBRL(giroProfit)}</div></div>
          <div><div class="giro-k">Operação</div><div class="giro-v">${hasOp ? escapeHtml(g.operation.game || ('#' + g.operation.id)) : '—'}</div></div>
          ${g.notes ? `<div class="giro-notes-row"><div class="giro-k">Notas</div><div class="giro-v">${escapeHtml(g.notes)}</div></div>` : ''}
        </div>
        ${breakdown}
        <div class="giro-actions">
          <button class="btn btn-ghost btn-sm" onclick="editGiro(${g.id})">Editar</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteGiro(${g.id})" style="color:var(--danger)">Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

function showGiroForm(existing) {
  girosEditingId = existing ? existing.id : null;
  const area = document.getElementById('giros-form-area');
  if (!area) return;

  const platformOpts = girosPlatforms.length
    ? girosPlatforms.map(p => `<option value="${p.id}" ${existing && existing.platform_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')
    : '';

  const opOpts = girosRecentOps.map(op => {
    const sel = existing && existing.operation_id === op.id ? 'selected' : '';
    const label = `#${op.id} — ${op.game || ''} (${formatBRL(op.profit)})`;
    return `<option value="${op.id}" ${sel}>${escapeHtml(label)}</option>`;
  }).join('');

  area.innerHTML = `
    <div class="chart-container">
      <h3 class="chart-title">${existing ? 'Editar giro' : 'Registrar giro grátis'}</h3>
      <form id="giro-form" class="form-grid">
        <div class="form-group">
          <label class="form-label">Plataforma</label>
          ${girosPlatforms.length
            ? `<select class="form-select" id="giro-platform" required><option value="">Selecione</option>${platformOpts}</select>`
            : `<div style="display:flex;gap:8px">
                 <input type="text" class="form-input" id="giro-new-platform" placeholder="Nome da plataforma" required>
                 <button type="button" class="btn btn-ghost" onclick="addGiroPlatformInline()">Adicionar</button>
               </div>
               <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Nenhuma plataforma cadastrada — adicione a primeira acima.</div>`}
        </div>
        <div class="form-group">
          <label class="form-label">Quantidade</label>
          <input type="number" min="0" step="1" class="form-input" id="giro-qty" value="${existing ? existing.quantity : ''}" placeholder="0" required>
        </div>
        <div class="form-group">
          <label class="form-label">Lucro do giro (R$)</label>
          <input type="number" step="0.01" class="form-input" id="giro-profit" value="${existing ? existing.profit : ''}" placeholder="0,00" required>
        </div>
        <div class="form-group">
          <label class="form-label">Operação vinculada (opcional)</label>
          <select class="form-select" id="giro-op">
            <option value="">Nenhuma</option>
            ${opOpts}
          </select>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Útil quando os giros vieram de uma promoção cumprida em uma operação.</div>
        </div>
        <div class="form-group full">
          <label class="form-label">Notas (opcional)</label>
          <textarea class="form-textarea" id="giro-notes" rows="2" placeholder="Observações">${existing && existing.notes ? escapeHtml(existing.notes) : ''}</textarea>
        </div>
        <div class="form-group full" style="display:flex;gap:12px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="closeGiroForm()">Cancelar</button>
          <button type="submit" class="btn btn-primary">${existing ? 'Salvar' : 'Registrar giro'}</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById('giro-form').addEventListener('submit', saveGiro);
}

function closeGiroForm() {
  const area = document.getElementById('giros-form-area');
  if (area) area.innerHTML = '';
  girosEditingId = null;
}

async function addGiroPlatformInline() {
  const input = document.getElementById('giro-new-platform');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { toast('Informe o nome da plataforma', 'error'); return; }
  try {
    await api('/api/giros/platforms', { method: 'POST', body: { name } });
    girosPlatforms = await api('/api/giros/platforms');
    showGiroForm(null);
    toast('Plataforma adicionada');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveGiro(e) {
  e.preventDefault();
  const platform_id = Number(document.getElementById('giro-platform')?.value) || null;
  if (!platform_id) { toast('Selecione uma plataforma', 'error'); return; }
  const quantity = Number(document.getElementById('giro-qty').value) || 0;
  const profit = Number(document.getElementById('giro-profit').value) || 0;
  const opVal = document.getElementById('giro-op').value;
  const operation_id = opVal ? Number(opVal) : null;
  const notes = document.getElementById('giro-notes').value;

  try {
    if (girosEditingId) {
      await api(`/api/giros/${girosEditingId}`, {
        method: 'PUT',
        body: { platform_id, quantity, profit, operation_id, notes },
      });
      toast('Giro atualizado');
    } else {
      await api('/api/giros', {
        method: 'POST',
        body: { platform_id, quantity, profit, operation_id, notes },
      });
      toast('Giro registrado');
    }
    closeGiroForm();
    await loadGirosData();
    renderGirosList();
  } catch (err) { toast(err.message, 'error'); }
}

function editGiro(id) {
  const g = girosList.find(x => x.id === id);
  if (!g) return;
  showGiroForm(g);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteGiro(id) {
  if (!confirm('Excluir este giro?')) return;
  try {
    await api(`/api/giros/${id}`, { method: 'DELETE' });
    toast('Giro excluído');
    await loadGirosData();
    renderGirosList();
  } catch (err) { toast(err.message, 'error'); }
}

function openGirosPlatformsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'giros-platforms-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-header">
        <h3 class="modal-title">Plataformas de giros</h3>
        <button class="modal-close" onclick="closeGirosPlatformsModal()">&times;</button>
      </div>
      <div style="padding:4px 0 12px">
        <form id="giros-platform-add-form" style="display:flex;gap:8px;margin-bottom:16px">
          <input type="text" class="form-input" id="giros-new-platform-name" placeholder="Nome da plataforma" required style="flex:1">
          <button type="submit" class="btn btn-primary">Adicionar</button>
        </form>
        <div id="giros-platforms-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('giros-platform-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = document.getElementById('giros-new-platform-name');
    const name = inp.value.trim();
    if (!name) return;
    try {
      await api('/api/giros/platforms', { method: 'POST', body: { name } });
      inp.value = '';
      girosPlatforms = await api('/api/giros/platforms');
      renderGirosPlatformsModalList();
      toast('Plataforma adicionada');
    } catch (err) { toast(err.message, 'error'); }
  });
  renderGirosPlatformsModalList();
}

function renderGirosPlatformsModalList() {
  const el = document.getElementById('giros-platforms-list');
  if (!el) return;
  if (!girosPlatforms.length) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px 0">Nenhuma plataforma cadastrada</div>`;
    return;
  }
  el.innerHTML = girosPlatforms.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:14px">${escapeHtml(p.name)}</span>
      <button class="btn btn-ghost btn-sm" onclick="deleteGiroPlatform(${p.id})" style="color:var(--danger)">Excluir</button>
    </div>
  `).join('');
}

async function deleteGiroPlatform(id) {
  if (!confirm('Excluir esta plataforma?')) return;
  try {
    await api(`/api/giros/platforms/${id}`, { method: 'DELETE' });
    girosPlatforms = await api('/api/giros/platforms');
    renderGirosPlatformsModalList();
    toast('Plataforma excluída');
  } catch (err) { toast(err.message, 'error'); }
}

function closeGirosPlatformsModal() {
  const el = document.getElementById('giros-platforms-modal');
  if (el) el.remove();
}

// ===== GROUP =====

// ===== WATCHER =====
let watcherTab = 'alerts'; // 'alerts' | 'positions' | 'config'
let watchedWallets = [];
let watcherSoundEnabled = true;
let watcherPaused = false;

// Audio context for alert sound
let audioCtx = null;
function playAlertSound() {
  if (!watcherSoundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Two-tone notification: C5 then E5
    [523.25, 659.25].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i * 0.15 + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + i * 0.15);
      osc.stop(audioCtx.currentTime + i * 0.15 + 0.25);
    });
  } catch (_) {}
}

async function loadWatchedWallets() {
  try {
    watchedWallets = await api('/api/watcher/wallets');
  } catch { watchedWallets = []; }
}

// Background polling (runs every 30s even when not on watcher page)
let bgWatcherTimer = null;
let unseenAlertCount = 0;
let pollInProgress = false; // prevent concurrent polls

function updateBadge() {
  const badge = document.getElementById('watcher-badge');
  if (!badge) return;
  if (unseenAlertCount > 0) {
    badge.textContent = unseenAlertCount > 99 ? '99+' : unseenAlertCount;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

async function bgPoll() {
  if (watcherPaused || !currentUser || pollInProgress) return;
  pollInProgress = true;
  try {
    const data = await api('/api/watcher/poll', { method: 'POST', body: {} });
    if (data.alerts && data.alerts.length > 0) {
      unseenAlertCount += data.alerts.length;
      updateBadge();
      playAlertSound();

      // Show toast for each new alert (max 3)
      data.alerts.slice(0, 3).forEach(a => {
        const typeEmoji = a.type === 'new_position' ? '🟢' :
                          a.type === 'position_closed' ? '🔴' :
                          a.type === 'trade_buy' ? '📈' : '📉';
        toast(`${typeEmoji} ${a.walletLabel}: ${a.title}`, 'info');
      });
      if (data.alerts.length > 3) {
        toast(`+${data.alerts.length - 3} mais alertas`, 'info');
      }

      // Refresh watcher page if currently viewing it
      if (currentPage === 'watcher' && watcherTab === 'alerts') {
        renderWatcherAlerts();
      }
    }
  } catch (_) {}
  pollInProgress = false;

  // Poll user's own Polymarket wallet for fill/redeem notifications
  try { await api('/api/notifications/poly-poll', { method: 'POST', body: {} }); } catch (_) {}
  // Refresh notifications badge after polling
  refreshNotificationsBadge();
}

// ===== NOTIFICATIONS =====

let notifUnseenCount = 0;
let notifTab = 'general'; // 'general' | 'system'

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  if (notifUnseenCount > 0) {
    badge.textContent = notifUnseenCount > 99 ? '99+' : notifUnseenCount;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

async function refreshNotificationsBadge() {
  if (!currentUser) return;
  try {
    const data = await api('/api/notifications?limit=1');
    notifUnseenCount = (data.general_unseen || 0) + (data.system_unseen || 0);
    updateNotifBadge();
    return data;
  } catch (_) { return null; }
}

async function renderNotifications() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Notifica\u00E7\u00F5es</h1>
        <p class="page-description">Alertas da sua atividade e avisos do sistema</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" onclick="markAllNotifsSeen()">Marcar tudo como lido</button>
        <button class="btn btn-ghost btn-sm" onclick="clearNotifs()" style="color:var(--danger)">Limpar</button>
      </div>
    </div>

    <div class="watcher-tabs">
      <button class="watcher-tab ${notifTab === 'general' ? 'active' : ''}" onclick="switchNotifTab('general')">
        Geral <span class="notif-tab-count" id="notif-count-general" style="display:none"></span>
      </button>
      <button class="watcher-tab ${notifTab === 'system' ? 'active' : ''}" onclick="switchNotifTab('system')">
        Sistema <span class="notif-tab-count" id="notif-count-system" style="display:none"></span>
      </button>
    </div>

    <div id="notif-content">
      <div style="text-align:center;color:var(--text-muted);padding:40px">Carregando...</div>
    </div>
  `;
  switchNotifTab(notifTab);
}

async function switchNotifTab(tab) {
  notifTab = tab;
  document.querySelectorAll('.watcher-tab').forEach(el => {
    el.classList.toggle('active', el.textContent.trim().toLowerCase().startsWith(tab === 'general' ? 'geral' : 'sistema'));
  });
  await loadNotifList();
}

async function loadNotifList() {
  const container = document.getElementById('notif-content');
  if (!container) return;
  try {
    const data = await api(`/api/notifications?category=${notifTab}&limit=100`);

    // Update per-tab counters
    const genEl = document.getElementById('notif-count-general');
    const sysEl = document.getElementById('notif-count-system');
    if (genEl) { if (data.general_unseen > 0) { genEl.textContent = data.general_unseen; genEl.style.display = ''; } else genEl.style.display = 'none'; }
    if (sysEl) { if (data.system_unseen > 0) { sysEl.textContent = data.system_unseen; sysEl.style.display = ''; } else sysEl.style.display = 'none'; }

    const list = data.notifications || [];
    if (!list.length) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px;font-size:14px">
        Nenhuma notifica\u00E7\u00E3o${notifTab === 'general' ? ' geral' : ' de sistema'}.
      </div>`;
    } else {
      container.innerHTML = list.map(n => renderNotifItem(n)).join('');
    }

    // Mark this tab's unseen notifications as seen
    const unseenIds = list.filter(n => !n.seen).map(n => n.id);
    if (unseenIds.length) {
      try {
        await api('/api/notifications/seen', { method: 'POST', body: { ids: unseenIds } });
      } catch (_) {}
      refreshNotificationsBadge();
    }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);padding:20px">${escapeHtml(err.message)}</div>`;
  }
}

function renderNotifItem(n) {
  const iconMap = {
    fill_order: '\u{1F4B0}',
    fill_limit_order: '\u{1F3AF}',
    redeem: '\u{1F3C6}',
    system_update: '\u{1F527}',
  };
  const icon = iconMap[n.type] || '\u{1F4E2}';
  const date = new Date(n.created_at + (n.created_at.includes('Z') ? '' : 'Z'));
  const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
    date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `
    <div class="alert-card ${n.seen ? '' : 'unseen'}" style="display:flex;gap:12px;padding:14px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:${n.seen ? 'transparent' : 'var(--bg-hover, rgba(255,255,255,0.03))'}">
      <div style="font-size:24px">${icon}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <strong style="font-size:14px">${escapeHtml(n.title)}</strong>
          <span style="color:var(--text-muted);font-size:11px;white-space:nowrap">${dateStr}</span>
        </div>
        ${n.body ? `<div style="color:var(--text-muted);font-size:13px;margin-top:4px;white-space:pre-wrap">${escapeHtml(n.body)}</div>` : ''}
      </div>
    </div>
  `;
}

async function markAllNotifsSeen() {
  try {
    await api('/api/notifications/seen', { method: 'POST', body: { ids: 'all' } });
    await refreshNotificationsBadge();
    loadNotifList();
    toast('Notifica\u00E7\u00F5es marcadas como lidas');
  } catch (err) { toast(err.message, 'error'); }
}

async function clearNotifs() {
  if (!confirm(`Limpar todas as notifica\u00E7\u00F5es da aba ${notifTab === 'general' ? 'Geral' : 'Sistema'}?`)) return;
  try {
    await api(`/api/notifications?category=${notifTab}`, { method: 'DELETE' });
    await refreshNotificationsBadge();
    loadNotifList();
    toast('Notificações limpas');
  } catch (err) { toast(err.message, 'error'); }
}


async function renderWatcherConfig() {
  const container = document.getElementById('watcher-content');
  await loadWatchedWallets();

  container.innerHTML = `
    <div class="chart-container">
      <h3 class="chart-title" style="margin-bottom:4px">Wallets Monitoradas</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        Adicione o endereço da proxy wallet (0x...) de cada membro do grupo no Polymarket.
        Você encontra o endereço no perfil do usuário no site.
      </p>

      <div id="wallets-list"></div>

      <div style="border-top:1px solid var(--border);padding-top:20px;margin-top:12px">
        <h4 style="font-size:14px;font-weight:600;margin-bottom:16px">Adicionar Wallet</h4>
        <form id="add-wallet-form" class="form-grid">
          <div class="form-group">
            <label class="form-label">Nome / Apelido</label>
            <input type="text" class="form-input" id="wallet-label" placeholder="Ex: João" required>
          </div>
          <div class="form-group">
            <label class="form-label">Endereço Wallet (0x...)</label>
            <input type="text" class="form-input" id="wallet-address" placeholder="0x..." required style="font-family:'JetBrains Mono',monospace;font-size:12px">
          </div>
          <div class="form-group">
            <button type="submit" class="btn btn-primary" style="margin-top:22px">Adicionar</button>
          </div>
        </form>
      </div>
    </div>
  `;

  renderWalletsList();

  document.getElementById('add-wallet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('wallet-label').value.trim();
    const address = document.getElementById('wallet-address').value.trim();
    try {
      await api('/api/watcher/wallets', { method: 'POST', body: { label, address } });
      toast('Wallet adicionada!');
      document.getElementById('wallet-label').value = '';
      document.getElementById('wallet-address').value = '';
      await loadWatchedWallets();
      renderWalletsList();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderWalletsList() {
  const container = document.getElementById('wallets-list');
  if (!container) return;

  if (!watchedWallets.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:30px">
        <div class="empty-state-icon">👁️</div>
        <div class="empty-state-text">Nenhuma wallet monitorada</div>
        <div class="empty-state-sub">Adicione a primeira wallet abaixo</div>
      </div>
    `;
    return;
  }

  container.innerHTML = watchedWallets.map(w => `
    <div class="wallet-card" id="wallet-card-${w.id}">
      <div class="wallet-card-icon">${escapeHtml(w.label.charAt(0).toUpperCase())}</div>
      <div class="wallet-card-info">
        <div class="wallet-card-label">
          ${escapeHtml(w.label)}
          ${!w.active ? '<span style="color:var(--danger);font-size:11px;margin-left:6px">(PAUSADA)</span>' : ''}
        </div>
        <div class="wallet-card-address">${w.address}</div>
      </div>
      <div class="wallet-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="editWallet(${w.id})">Editar</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteWallet(${w.id})">Remover</button>
      </div>
    </div>
  `).join('');
}

async function editWallet(id) {
  const w = watchedWallets.find(x => x.id === id);
  if (!w) return;
  const newLabel = prompt('Nome / Apelido:', w.label);
  if (newLabel === null) return;
  try {
    await api(`/api/watcher/wallets/${id}`, { method: 'PUT', body: { label: newLabel.trim() || w.label } });
    toast('Wallet atualizada!');
    await loadWatchedWallets();
    renderWalletsList();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteWallet(id) {
  if (!confirm('Remover esta wallet? Todas as posições e alertas salvos serão apagados.')) return;
  try {
    await api(`/api/watcher/wallets/${id}`, { method: 'DELETE' });
    toast('Wallet removida!');
    await loadWatchedWallets();
    renderWalletsList();
  } catch (err) { toast(err.message, 'error'); }
}

function toggleWatcherPause() {
  watcherPaused = !watcherPaused;
  const dot = document.getElementById('watcher-dot');
  const text = document.getElementById('watcher-status-text');
  const btn = document.getElementById('watcher-pause-btn');
  if (dot) dot.className = 'watcher-status-dot' + (watcherPaused ? ' paused' : '');
  if (text) text.textContent = watcherPaused ? 'Pausado' : 'Monitorando';
  if (btn) btn.innerHTML = watcherPaused ? '▶ Retomar' : '⏸ Pausar';
}

function toggleWatcherSound() {
  watcherSoundEnabled = !watcherSoundEnabled;
  const btn = document.getElementById('watcher-sound-btn');
  if (btn) btn.innerHTML = watcherSoundEnabled ? '🔔 Som ON' : '🔕 Som OFF';
  toast(watcherSoundEnabled ? 'Som ativado' : 'Som desativado');
}

async function manualPoll() {
  toast('Verificando...', 'info');
  await bgPoll();
  if (currentPage === 'watcher') {
    if (watcherTab === 'alerts') renderWatcherAlerts();
    else if (watcherTab === 'positions') renderWatcherPositions();
  }
}

async function clearAllAlerts() {
  if (!confirm('Limpar todos os alertas?')) return;
  try {
    await api('/api/watcher/alerts', { method: 'DELETE' });
    unseenAlertCount = 0;
    updateBadge();
    renderWatcherAlerts();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== INIT =====
checkAuth();

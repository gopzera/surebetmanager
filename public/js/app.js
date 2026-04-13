// ===== STATE =====
let currentUser = null;
let currentPage = 'dashboard';
let charts = {};
let userAccounts = []; // cached accounts

// ===== API HELPERS =====
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro na requisição');
  return data;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
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
  const labels = { aquecimento: 'Aquecimento', arbitragem: 'Arbitragem', aumentada25: 'Aumentada 25%' };
  return labels[type] || type;
}

function resultLabel(result) {
  const labels = { pending: 'Pendente', bet365_won: 'Bet365', poly_won: 'Poly', void: 'Anulado' };
  return labels[result] || result;
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
function computeProfit(stakeBet365, oddBet365, stakePolyUsd, oddPoly, exchangeRate, result) {
  const sb = parseFloat(stakeBet365) || 0;
  const ob = parseFloat(oddBet365) || 0;
  const sp = parseFloat(stakePolyUsd) || 0;
  const op = parseFloat(oddPoly) || 0;
  const fx = parseFloat(exchangeRate) || 0;

  if (!sb && !sp) return null; // no stakes entered

  const totalInvested = sb + sp * fx;

  if (result === 'bet365_won') {
    return sb * ob - totalInvested;
  } else if (result === 'poly_won') {
    return sp * op * fx - totalInvested;
  } else if (result === 'void') {
    return 0;
  }
  return null; // pending — don't auto-calc
}

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
    renderVolumeTracker(data);
    renderProfitChart(data.dailyProfits);
    renderTypeChart(data.profitByType);
    renderRecentTable(data.recentOps);
  } catch (err) {
    toast(err.message, 'error');
  }
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
          Apostas com odd &ge; 2.0 na Bet365 desde ${formatDate(data.weekStart)} | Meta: ${formatBRL(goal)} por conta
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
  const typeColors = { aquecimento: '#ffa726', arbitragem: '#00c853', aumentada25: '#6c5ce7' };
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
        ${ops.map(op => `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
          <td>${renderTagsDisplay(op.tags)}</td>
          <td>${formatBRL(op.stake_bet365)}</td>
          <td>${formatUSD(op.stake_poly_usd)} <span class="currency-tag">USD</span></td>
          <td class="${profitClass(op.profit)}">${formatBRL(op.profit)}</td>
          <td>${(op.accounts || []).map(a => escapeHtml(a.name)).join(', ') || '-'}</td>
          <td><span class="badge badge-${op.result === 'pending' ? 'pending' : 'won'}">${resultLabel(op.result)}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ===== NEW OPERATION =====
async function renderNewOperation() {
  await loadAccounts();
  const today = new Date().toISOString().split('T')[0];
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
      </div>
      <input type="hidden" id="new-type">

      <div class="form-group full">
        <label class="form-label">Jogo / Evento</label>
        <input type="text" class="form-input" id="new-game" placeholder="Ex: Real Madrid vs Barcelona - Vencedor" required>
      </div>

      ${activeAccounts.length ? `
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
            <option value="bet365_won">Bet365 Ganhou</option>
            <option value="poly_won">Polymarket Ganhou</option>
            <option value="void">Anulado</option>
          </select>
        </div>
      </div>

      <h3 class="chart-title" style="margin:24px 0 16px">Bet365 (BRL)</h3>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Stake Total Bet365 (R$) <span style="font-size:11px;color:var(--text-muted)">(soma de todas as contas)</span></label>
          <input type="number" step="0.01" min="0" class="form-input" id="new-stake-bet365" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Odd Bet365</label>
          <input type="number" step="0.01" min="1" class="form-input" id="new-odd-bet365" placeholder="0,00">
        </div>
      </div>
      <div id="stake-per-account-info" style="font-size:12px;color:var(--text-muted);margin-bottom:16px"></div>

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
    if (result === 'pending') {
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
    if (imp.exchangeRate) {
      rateInput.value = imp.exchangeRate.toFixed(4);
      rateStatus.textContent = '(da calculadora)';
      rateStatus.style.color = 'var(--success)';
    }
    if (imp.notes) document.getElementById('new-notes').value = imp.notes;

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
  document.getElementById('new-type').value = el.dataset.type;
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

  const body = {
    type,
    game: document.getElementById('new-game').value.trim(),
    event_date: document.getElementById('new-event-date').value,
    stake_bet365: totalStakeBet365,
    odd_bet365: parseFloat(document.getElementById('new-odd-bet365').value) || 0,
    stake_poly_usd: parseFloat(document.getElementById('new-stake-poly-usd').value) || 0,
    odd_poly: parseFloat(document.getElementById('new-odd-poly').value) || 0,
    exchange_rate: parseFloat(document.getElementById('new-exchange-rate').value) || 5.0,
    result: document.getElementById('new-result').value,
    profit: parseFloat(document.getElementById('new-profit').value) || 0,
    notes: document.getElementById('new-notes').value.trim(),
    tags: getTagsFromInput('new-tags'),
  };
  if (account_stakes) body.account_stakes = account_stakes;
  else body.account_ids = account_ids;

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
      </select>
      <select class="form-select" id="filter-tag" onchange="loadHistory()">
        <option value="">Todas tags</option>
      </select>
      <input type="date" class="form-input" id="filter-from" onchange="loadHistory()">
      <input type="date" class="form-input" id="filter-to" onchange="loadHistory()">
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
        ${ops.map(op => `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
          <td>${renderTagsDisplay(op.tags)}</td>
          <td>${formatBRL(op.stake_bet365)}</td>
          <td>${formatUSD(op.stake_poly_usd)} <span class="currency-tag">USD</span></td>
          <td style="font-size:12px">${(op.accounts || []).map(a => escapeHtml(a.name)).join(', ') || '-'}</td>
          <td class="${profitClass(op.profit)}">${formatBRL(op.profit)}</td>
          <td><span class="badge badge-${op.result === 'pending' ? 'pending' : 'won'}">${resultLabel(op.result)}</span></td>
          <td>
            <div class="action-btns">
              <button onclick="duplicateOperation(${op.id})" title="Duplicar">&#128203;</button>
              <button onclick="openEditModal(${op.id})" title="Editar">&#9998;</button>
              <button class="delete" onclick="deleteOperation(${op.id})" title="Excluir">&#128465;</button>
            </div>
          </td>
        </tr>`).join('')}
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

// ===== DUPLICATE OPERATION =====
async function duplicateOperation(id) {
  try {
    const { operations } = await api('/api/operations?limit=999');
    const op = operations.find(o => o.id === id);
    if (!op) { toast('Opera\u00E7\u00E3o n\u00E3o encontrada', 'error'); return; }

    const accs = op.accounts || [];
    window._calcImport = {
      type: op.type,
      stakeBet365: op.stake_bet365,
      oddBet365: op.odd_bet365,
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
    if (result === 'pending') { autoProfitInfo.style.display = 'none'; return; }
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
  };
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
    await api(`/api/operations/${id}`, { method: 'DELETE' });
    toast('Operação excluída');
    loadHistory();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== SETTINGS =====
async function renderSettings() {
  await loadAccounts();

  // Fetch ranking preference
  let showInRanking = true;
  try {
    const pref = await api('/api/ranking/me');
    showInRanking = !!pref.show_in_ranking;
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
      <div style="display:flex;align-items:center;gap:12px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px">
          <input type="checkbox" id="setting-show-ranking" ${showInRanking ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--primary);cursor:pointer"
            onchange="toggleRankingVisibility(this.checked)">
          Exibir meu lucro no ranking do grupo
        </label>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin-top:6px">
        Quando desativado, seu perfil n\u00E3o aparecer\u00E1 na p\u00E1gina de Ranking.
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

async function toggleRankingVisibility(checked) {
  try {
    await api('/api/ranking/me', { method: 'PUT', body: { show_in_ranking: checked } });
    toast(checked ? 'Seu lucro agora aparece no ranking' : 'Seu lucro foi ocultado do ranking');
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

// ===== CALCULATOR =====
// -- Polymarket fee categories (effective from 30/03/2026) --
const POLY_CATS = {
  "None (free)":   { feeRate: 0,     exponent: 0   },
  "Crypto":        { feeRate: 0.072, exponent: 1   },
  "Sports":        { feeRate: 0.03,  exponent: 1   },
  "Finance":       { feeRate: 0.04,  exponent: 1   },
  "Politics":      { feeRate: 0.04,  exponent: 1   },
  "Tech":          { feeRate: 0.04,  exponent: 1   },
  "Culture":       { feeRate: 0.05,  exponent: 1   },
  "Economics":     { feeRate: 0.03,  exponent: 0.5 },
  "Weather":       { feeRate: 0.025, exponent: 0.5 },
  "Other/General": { feeRate: 0.2,   exponent: 2   },
  "Mentions":      { feeRate: 0.25,  exponent: 2   },
  "Geopolitical":  { feeRate: 0,     exponent: 0   },
};
const CAT_KEYS = Object.keys(POLY_CATS);

// Fork/formula types
const CALC_FORK_TYPES_2 = [
  { id:"1-2",   label:"1 \u2014 2",        hint:"Home vs Away" },
  { id:"1-X2",  label:"1 \u2014 X2",       hint:"Back Home / Lay X2" },
  { id:"1X-2",  label:"1X \u2014 2",       hint:"Lay Home / Back Away" },
  { id:"AH",    label:"AH1 \u2014 AH2",    hint:"Asian Handicap" },
  { id:"OU",    label:"Over \u2014 Under",  hint:"Goals market" },
];
const CALC_FORK_TYPES_3 = [
  { id:"1-X-2",    label:"1 \u2014 X \u2014 2",       hint:"3-way standard" },
  { id:"3corr",    label:"3 corners",        hint:"Corners market" },
  { id:"DNB+D",    label:"DNB + Draw",       hint:"Draw No Bet + Draw" },
];
const CALC_FORK_TYPES_N = [
  { id:"multi",    label:"Multi-way",        hint:"4+ outcomes" },
];

const CALC_CURR_SYMS = { USD:"$", BRL:"R$" };

// -- Calculator state --
let calcNumOut = 2;
let calcShowComm = false;
let calcRoundValue = 0;
let calcRoundUseFx = false;
let calcNextId = 3;
let calcRows = [];
let calcUsdcBrl = null;
let calcLastUpdated = null;
let calcResult = null;
let calcDarkMode = true;
let calcRateInterval = null;
let calcForkType = "1-2";
let calcTotalStakeOverride = null;

function makeCalcRow(id) {
  return {
    id, odds: "2", comm: "0",
    betType: "back",      // "back" | "lay"
    usePoly: false, cat: "Sports",
    currency: "USD", isFixed: false, fixedStake: "",
    manualStake: null,    // user-typed override when another row is the fixed anchor
    customRate: null      // custom BRL/USD rate for display on USD rows
  };
}

// -- Math --
/**
 * Effective odds taking commission and bet type into account.
 * Back bet: eff = 1 + (raw-1)*(1 - c%)  [commission on profit only]
 * Lay  bet: eff = raw - c%              [lay formula]
 * Then apply Polymarket taker fee on top (back only).
 */
function calcEffOdds(raw, commPct, betType, usePoly, catKey) {
  if (!raw || raw <= 1) return null;
  const c = (parseFloat(commPct) || 0) / 100;
  let eff;
  if (betType === "lay") {
    eff = raw - c;
  } else {
    eff = 1 + (raw - 1) * (1 - c);
  }
  if (eff <= 1) return null;
  if (!usePoly || betType === "lay") return eff;
  const { feeRate, exponent } = POLY_CATS[catKey];
  if (!feeRate) return eff;
  const p = 1 / eff;
  const adjEff = 1 / (p * (1 + feeRate * Math.pow(p * (1 - p), exponent)));
  return adjEff > 1 ? adjEff : null;
}

function calcTakerFeePct(raw, commPct, catKey) {
  if (raw <= 1) return 0;
  const c = (parseFloat(commPct) || 0) / 100;
  const eff = 1 + (raw - 1) * (1 - c);
  if (eff <= 1) return 0;
  const { feeRate, exponent } = POLY_CATS[catKey];
  if (!feeRate) return 0;
  const p = 1 / eff;
  return feeRate * Math.pow(p * (1 - p), exponent) * 100;
}

function cf2(n) { return (typeof n === "number" && isFinite(n)) ? n.toFixed(2) : "\u2014"; }

function calcToDisplay(usdAmt, currency) {
  if (currency === "USD") return usdAmt;
  if (currency === "BRL") return calcUsdcBrl ? usdAmt * calcUsdcBrl : null;
  return null;
}

function calcToUSD(amt, cur) {
  if (cur === "USD") return amt;
  if (cur === "BRL") return calcUsdcBrl ? amt / calcUsdcBrl : amt;
  return amt;
}

function calcFromUSD(usd, cur) {
  if (cur === "USD") return usd;
  if (cur === "BRL") return calcUsdcBrl ? usd * calcUsdcBrl : null;
  return null;
}

// -- Theme --
function calcToggleTheme() {
  calcDarkMode = !calcDarkMode;
  const page = document.getElementById('calc-page-root');
  if (page) page.classList.toggle('light', !calcDarkMode);
  const btn = document.getElementById('calc-theme-btn');
  if (btn) btn.textContent = calcDarkMode ? "\u2728 Light" : "\uD83C\uDF19 Dark";
  localStorage.setItem("calcDarkMode", calcDarkMode);
}

// -- Rate fetcher --
async function calcFetchRate() {
  const dot = document.getElementById('calc-status-dot');
  if (dot) dot.className = "c-dot c-dot-load";
  const attempts = [
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDCBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance USDCBRL"})),
    () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL",{cache:"no-store"}).then(r=>r.json()).then(d=>({price:parseFloat(d.price),src:"Binance USDTBRL"})),
    () => fetch("https://open.er-api.com/v6/latest/USD").then(r=>r.json()).then(d=>({price:d.rates.BRL,src:"ExchangeRate-API"})),
    () => fetch("https://api.frankfurter.app/latest?base=USD&symbols=BRL").then(r=>r.json()).then(d=>({price:d.rates.BRL,src:"Frankfurter/ECB"})),
  ];
  for (const fn of attempts) {
    try {
      const {price, src} = await fn();
      if (price > 0) { calcGotRate(price, src); return; }
    } catch (_) {}
  }
  const body = document.getElementById('calc-ticker-body');
  if (body) body.innerHTML = `<div style="color:var(--red);font-family:var(--mono);font-size:11px">Falha ao buscar cota\u00E7\u00E3o</div>`;
  if (dot) dot.className = "c-dot c-dot-err";
}

function calcGotRate(price, source) {
  calcUsdcBrl = price;
  calcLastUpdated = new Date();
  const dot = document.getElementById('calc-status-dot');
  if (dot) dot.className = "c-dot c-dot-ok";
  const body = document.getElementById('calc-ticker-body');
  if (body) body.innerHTML = `
    <div class="c-ticker-price">R$${price.toFixed(4)}<span class="c-ticker-time">${calcLastUpdated.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</span></div>
    <div class="c-ticker-source">${source}</div>`;
  calcCompute();
  calcUpdateDisplay();
}

// -- Fork type --
function calcBuildForkSelect() {
  const sel = document.getElementById("calc-fork-type");
  if (!sel) return;
  const types = calcNumOut === 2 ? CALC_FORK_TYPES_2 : calcNumOut === 3 ? CALC_FORK_TYPES_3 : CALC_FORK_TYPES_N;
  sel.innerHTML = types.map(t =>
    `<option value="${t.id}" title="${t.hint}"${calcForkType===t.id?" selected":""}>${t.label}</option>`
  ).join("");
  if (!types.find(t=>t.id===calcForkType)) {
    calcForkType = types[0].id;
    sel.value = calcForkType;
  }
}

function calcOnForkChange() {
  calcForkType = document.getElementById("calc-fork-type").value;
  if (calcForkType === "1-X2" && calcRows.length >= 2) {
    calcRows[0].betType = "back"; calcRows[1].betType = "lay";
  } else if (calcForkType === "1X-2" && calcRows.length >= 2) {
    calcRows[0].betType = "lay"; calcRows[1].betType = "back";
  } else {
    calcRows.forEach(r => { if(calcForkType!=="1-X2"&&calcForkType!=="1X-2") r.betType="back"; });
  }
  calcCompute(); calcBuildTable();
}

// -- Outcome buttons --
function calcSetOutcomes(n) {
  calcNumOut = n;
  while (calcRows.length < calcNumOut) calcRows.push(makeCalcRow(calcNextId++));
  calcRows = calcRows.slice(0, calcNumOut);
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle('on', parseInt(b.textContent) === n));
  calcBuildForkSelect();
  calcCompute(); calcBuildTable();
}

function calcToggleShowComm() {
  calcShowComm = !calcShowComm;
  const btn = document.getElementById('calc-show-comm-btn');
  if (btn) { btn.textContent = calcShowComm ? "Hide commissions" : "Show commissions"; btn.classList.toggle('on', calcShowComm); }
  calcBuildTable();
}

// -- Core calculation --
function calcCompute() {
  const effArr = calcRows.map(r =>
    calcEffOdds(parseFloat(r.odds), parseFloat(r.comm)||0, r.betType, r.usePoly, r.cat)
  );
  if (!effArr.every(o => o !== null && o > 1)) { calcResult = null; return; }

  const invSum = effArr.reduce((s, o) => s + 1/o, 0);
  const margin = invSum;
  const isSurebet = margin < 1;

  const fixIdx = calcRows.findIndex(r => r.isFixed);
  let target;
  if (fixIdx >= 0) {
    const fRow = calcRows[fixIdx];
    const raw = parseFloat(fRow.fixedStake) || 0;
    let usdFixed;
    if (fRow.currency === "USD") usdFixed = raw;
    else if (fRow.currency === "BRL") usdFixed = calcUsdcBrl ? raw / calcUsdcBrl : raw;
    else usdFixed = raw;
    target = usdFixed * effArr[fixIdx];
  } else {
    const desiredTotal = calcTotalStakeOverride !== null ? calcTotalStakeOverride : 100;
    target = desiredTotal / invSum;
  }

  let stakesUSD = effArr.map(o => target / o);

  // Apply manual stake overrides
  calcRows.forEach((r, i) => {
    if (r.manualStake !== null && !r.isFixed) {
      const raw = r.manualStake === "" ? null : parseFloat(r.manualStake);
      if (raw !== null && !isNaN(raw)) {
        let usdManual;
        if (r.currency === "USD") usdManual = raw;
        else if (r.currency === "BRL") usdManual = calcUsdcBrl ? raw / calcUsdcBrl : raw;
        else usdManual = raw;
        stakesUSD[i] = usdManual;
      }
    }
  });

  if (calcRoundValue > 0) {
    stakesUSD = stakesUSD.map((s, i) => {
      const row = calcRows[i];
      if (calcRoundUseFx && row.currency === "BRL" && calcUsdcBrl) {
        const brl = s * calcUsdcBrl;
        const rounded = Math.ceil(brl / calcRoundValue) * calcRoundValue;
        return rounded / calcUsdcBrl;
      }
      return Math.ceil(s / calcRoundValue) * calcRoundValue;
    });
  }

  const totalUSD   = stakesUSD.reduce((a,b)=>a+b,0);
  const returnsUSD = stakesUSD.map((s,i)=>s*effArr[i]);
  const profitsUSD = returnsUSD.map(r=>r-totalUSD);
  const minProfit  = Math.min(...profitsUSD);
  const roi        = totalUSD ? (minProfit / totalUSD) * 100 : 0;

  calcResult = { margin, isSurebet, effArr, stakesUSD, totalUSD, returnsUSD, profitsUSD, minProfit, roi };
}

// -- Build table --
// -- Polymarket price/shares helpers (reused in build and update) --
function calcPolyState(row) {
  const isLay = row.betType === "lay";
  const rawOdd = parseFloat(row.odds) || 0;
  const isPoly = !isLay && row.usePoly && rawOdd > 1;
  if (!isPoly) return { isPoly: false };
  const priceExact = 1 / rawOdd;
  const priceRounded = Math.round(priceExact * 100) / 100;
  if (priceRounded <= 0 || priceRounded >= 1) return { isPoly: false };
  const realOdd = 1 / priceRounded;
  const oddDiffers = Math.abs(realOdd - rawOdd) > 1e-9;
  return { isPoly: true, rawOdd, priceRounded, realOdd, oddDiffers };
}

function calcBuildPolyPriceHint(row) {
  const s = calcPolyState(row);
  if (!s.isPoly) return "";
  const priceStr = s.priceRounded.toFixed(2);
  const realOddStr = s.realOdd.toFixed(10);
  return `
    <div class="c-poly-price" title="Preço por share em limit order (arredondado para 2 casas)">$${priceStr}/share</div>
    ${s.oddDiffers ? `<div class="c-poly-real-odd" title="Odd real com preço arredondado">odd real: ${realOddStr}</div>
    <button type="button" class="c-poly-odd-btn" onclick="calcUseRealOdd(${row.id})" title="Substituir a odd pela odd real">transformar em odd real</button>` : ''}
  `;
}

function calcBuildPolySharesHint(row, idx) {
  const s = calcPolyState(row);
  if (!s.isPoly || !calcResult) return "";
  const stakeUSD = calcResult.stakesUSD[idx] || 0;
  if (stakeUSD <= 0) return "";
  const shares = stakeUSD / s.priceRounded;
  return `<div class="c-shares-badge" title="Shares em limit order a $${s.priceRounded.toFixed(2)} cada">Shares: ${shares.toFixed(2)}</div>`;
}

function calcBuildTable() {
  calcCompute();

  let h = `<tr>
    <th style="width:28px" class="c-ctr-col">#</th>
    <th class="c-ctr-col" style="width:50px">B/L</th>
    <th>Odds</th>
    <th class="c-num-col">Prob%</th>`;
  if (calcShowComm) h += `<th>Comm %</th><th class="c-num-col">Eff.Odds</th>`;
  h += `
    <th class="c-poly-th c-ctr-col">Poly</th>
    <th class="c-poly-th">Category</th>
    <th class="c-poly-th c-num-col">Taker Fee</th>
    <th class="c-ctr-col">Currency</th>
    <th>Stake</th>
    <th class="c-ctr-col" style="width:44px">Fix</th>
    <th class="c-num-col">Profit</th>
  </tr>`;
  document.getElementById("calc-thead").innerHTML = h;

  document.getElementById("calc-tbody").innerHTML = calcRows.map((row, idx) => {
    const cur = row.currency;
    const isLay = row.betType === "lay";
    const catOpts = CAT_KEYS.map(k =>
      `<option value="${k}"${row.cat===k?" selected":""}>${k}</option>`
    ).join("");

    let commCols = "";
    if (calcShowComm) {
      const eff = calcResult ? calcResult.effArr[idx] : null;
      commCols = `
        <td><input type="number" min="-40" max="40" step="0.01" value="${row.comm}"
          style="width:70px;text-align:center"
          oninput="calcOnCommInput(${row.id},this.value)"></td>
        <td class="c-num-col" id="calc-ao-${row.id}" style="font-size:12px">
          ${eff ? `<span style="font-family:var(--mono);font-size:11px">${eff.toFixed(4)}</span>` : "\u2014"}
        </td>`;
    }

    // Liability for lay bets
    let liabHtml = "";
    if (isLay && calcResult) {
      const raw = parseFloat(row.odds) || 0;
      const s = calcResult.stakesUSD[idx];
      const liab = s * (raw - 1);
      const liabDisp = calcToDisplay(liab, cur);
      liabHtml = `<div class="c-liab-badge" title="Your liability">Liab: ${CALC_CURR_SYMS[cur]}${cf2(liabDisp??liab)}</div>`;
    }

    const polyPriceHint = calcBuildPolyPriceHint(row);
    const polySharesHint = calcBuildPolySharesHint(row, idx);

    const stakeFixed = (row.isFixed || row.manualStake !== null) ? "c-stake-fixed" : "";
    const stakeVal = row.isFixed ? row.fixedStake
      : row.manualStake !== null ? row.manualStake
      : calcResult ? (() => {
          const v = calcToDisplay(calcResult.stakesUSD[idx], cur);
          return v !== null ? cf2(v) : "";
        })() : "";

    return `
    <tr class="${isLay?"c-is-lay":""}">
      <td class="c-ctr-col" style="font:600 11px/1 var(--mono);color:var(--text3)">${idx+1}</td>
      <td class="c-ctr-col">
        <button class="c-bl-btn ${isLay?"c-lay":"c-back"}" onclick="calcToggleBL(${row.id})" title="${isLay?"Lay (you're the bookmaker)":"Back (you're the bettor)"}">${isLay?"\u2212":"+"}</button>
      </td>
      <td>
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
          <input type="number" min="1.001" step="0.01" value="${row.odds}" style="width:88px;text-align:center"
            placeholder="${isLay?"Lay odds":"Back odds"}"
            oninput="calcOnOddsInput(${row.id},this.value)">
          <div id="calc-polyprice-${row.id}" class="c-polyprice-wrap">${polyPriceHint}</div>
        </div>
      </td>
      <td class="c-num-col" id="calc-prob-${row.id}" style="font-size:12px">
        ${(parseFloat(row.odds)||0) > 1 ? (100/(parseFloat(row.odds))).toFixed(1)+"%" : "\u2014"}
      </td>
      ${commCols}
      <td class="c-poly-td c-ctr-col">
        <input type="checkbox" ${row.usePoly&&!isLay?"checked":""} ${isLay?"disabled":""} onchange="calcOnPolyChange(${row.id},this.checked)" title="${isLay?"Polymarket only for back bets":"Use Polymarket taker fee"}">
      </td>
      <td class="c-poly-td">
        <select id="calc-catsel-${row.id}" ${(row.usePoly&&!isLay)?"":"disabled"} onchange="calcOnCatChange(${row.id},this.value)">${catOpts}</select>
      </td>
      <td id="calc-fee-${row.id}" class="c-poly-td c-num-col">
        ${(!isLay && row.usePoly) ? (() => {
          const fp = calcTakerFeePct(parseFloat(row.odds)||0, parseFloat(row.comm)||0, row.cat);
          return fp > 0 ? `<span class="c-fee-badge">${fp.toFixed(3)}%</span>` : `<span style="color:var(--text3)">\u2014</span>`;
        })() : `<span style="color:var(--text3)">\u2014</span>`}
      </td>
      <td class="c-ctr-col">
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px">
          <button class="c-cur-btn" id="calc-curbtn-${row.id}" onclick="calcCycleCur(${row.id})">${cur==="USD"?"$ USD":"R$ BRL"}</button>
          ${cur==="USD" ? `<div style="display:flex;align-items:center;gap:3px">
            <span style="font:400 9px/1 var(--mono);color:var(--text3)">R$/\$</span>
            <input type="number" min="0.01" step="0.01"
              style="width:64px;font-size:11px;padding:3px 5px;text-align:right"
              placeholder="${calcUsdcBrl ? calcUsdcBrl.toFixed(2) : 'rate'}"
              value="${row.customRate !== null ? row.customRate : ''}"
              oninput="calcOnCustomRate(${row.id},this.value)"
              title="Cota\u00E7\u00E3o USD/BRL personalizada para esta linha">
          </div>` : ""}
        </div>
      </td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;align-items:center;gap:4px">
            <span id="calc-cursym-${row.id}" style="font:400 11px/1 var(--mono);color:var(--text3)">${CALC_CURR_SYMS[cur]}</span>
            <input type="number" id="calc-stake-${row.id}" class="${stakeFixed}" style="width:92px;text-align:right"
              oninput="calcOnStakeInput(${row.id},this.value)"
              value="${stakeVal}"
              placeholder="${isLay?"Backer stake":"Your stake"}">
          </div>
          ${liabHtml}
          <div id="calc-shares-${row.id}" class="c-shares-wrap">${polySharesHint}</div>
          <div id="calc-brl-hint-${row.id}" class="c-dim" style="padding-left:2px;display:none"></div>
        </div>
      </td>
      <td class="c-ctr-col" id="calc-fixcell-${row.id}">
        <button class="c-fix-btn ${row.isFixed?"c-fix-on":"c-fix-off"}" onclick="calcToggleFix(${row.id})"
          title="${row.isFixed?"Unfix stake":"Fix this stake"}">${row.isFixed?"\uD83D\uDD12":"\uD83D\uDD13"}</button>
      </td>
      <td id="calc-profit-${row.id}" class="c-num-col">\u2014</td>
    </tr>`;
  }).join("");

  calcUpdateDisplay();
  calcRenderSimulator();
}

// -- Update display --
function calcUpdateDisplay() {
  const roiBadge = document.getElementById("calc-roi-badge");
  if (!calcResult) {
    document.getElementById("calc-tfoot").innerHTML = "";
    document.getElementById("calc-cards").innerHTML = "";
    if (roiBadge) roiBadge.style.display = "none";
    return;
  }

  calcRows.forEach((row, i) => {
    const probEl = document.getElementById(`calc-prob-${row.id}`);
    if (probEl) {
      probEl.innerHTML = (parseFloat(row.odds)||0) > 1 ? (100/(parseFloat(row.odds))).toFixed(1)+"%" : "\u2014";
    }

    const feeEl = document.getElementById(`calc-fee-${row.id}`);
    if (feeEl) {
      const isLay = row.betType === "lay";
      if (!isLay && row.usePoly) {
        const fp = calcTakerFeePct(parseFloat(row.odds)||0, parseFloat(row.comm)||0, row.cat);
        feeEl.innerHTML = fp > 0 ? `<span class="c-fee-badge">${fp.toFixed(3)}%</span>` : `<span style="color:var(--text3)">\u2014</span>`;
      } else {
        feeEl.innerHTML = `<span style="color:var(--text3)">\u2014</span>`;
      }
    }

    const profEl = document.getElementById(`calc-profit-${row.id}`);
    if (profEl) {
      const pUSD = calcResult.profitsUSD[i];
      const disp = calcToDisplay(pUSD, row.currency);
      const sign = pUSD >= 0 ? "+" : "";
      const cls  = pUSD >= -0.005 ? "c-pos" : "c-neg";
      const sym  = CALC_CURR_SYMS[row.currency];
      const main = disp !== null ? `${sign}${sym}${Math.abs(disp).toFixed(2)}` : `${sign}$${Math.abs(pUSD).toFixed(2)}`;
      const sub  = row.currency !== "USD" && disp !== null ? `<div class="c-dim">${sign}$${cf2(Math.abs(pUSD))}</div>` : "";
      profEl.innerHTML = `<span class="${cls}">${main}</span>${sub}`;
    }

    // Stake
    const stakeEl = document.getElementById(`calc-stake-${row.id}`);
    if (stakeEl && !row.isFixed && row.manualStake === null && document.activeElement !== stakeEl) {
      const v = calcToDisplay(calcResult.stakesUSD[i], row.currency);
      stakeEl.value = v !== null ? cf2(v) : "";
    }

    // Polymarket price/real-odd hint (below odd input)
    const polyPriceWrap = document.getElementById(`calc-polyprice-${row.id}`);
    if (polyPriceWrap) polyPriceWrap.innerHTML = calcBuildPolyPriceHint(row);

    // Polymarket shares badge (near stake)
    const sharesWrap = document.getElementById(`calc-shares-${row.id}`);
    if (sharesWrap) sharesWrap.innerHTML = calcBuildPolySharesHint(row, i);

    // BRL hint for USD rows with customRate
    const brlHint = document.getElementById(`calc-brl-hint-${row.id}`);
    if (brlHint && row.currency === "USD") {
      const activeRate = row.customRate || null;
      if (activeRate) {
        const usdAmt = calcResult.stakesUSD[i];
        brlHint.textContent = `\u2248 R$${cf2(usdAmt * activeRate)}`;
        brlHint.style.display = "";
      } else {
        brlHint.style.display = "none";
      }
    } else if (brlHint) {
      brlHint.style.display = "none";
    }

    // Liability update (for lay rows)
    if (row.betType === "lay") {
      const raw = parseFloat(row.odds) || 0;
      const s = calcResult.stakesUSD[i];
      const liab = s * (raw - 1);
      const liabDisp = calcToDisplay(liab, row.currency);
      const sym = CALC_CURR_SYMS[row.currency];
      const cell = document.getElementById(`calc-stake-${row.id}`)?.closest("td");
      if (cell) {
        let badge = cell.querySelector(".c-liab-badge");
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "c-liab-badge";
          cell.querySelector("div").appendChild(badge);
        }
        badge.textContent = `Liab: ${sym}${cf2(liabDisp??liab)}`;
      }
    }
  });

  // Total stake input sync
  const totalInput = document.getElementById("calc-total-stake-input");
  if (totalInput && document.activeElement !== totalInput) {
    totalInput.value = cf2(calcResult.totalUSD);
  }

  // Footer
  const colCount = 12 + (calcShowComm ? 2 : 0);
  const colsBeforeStake = colCount - 3;
  const totalInputActive = document.activeElement?.id === "calc-total-stake-input";

  if (!totalInputActive) {
    document.getElementById("calc-tfoot").innerHTML = `
      <tr>
        <td colspan="${colsBeforeStake}" style="text-align:right;color:var(--text2);font:500 12px/1 var(--sans)">
          Total stake (USD):</td>
        <td>
          <div style="display:flex;align-items:center;gap:4px">
            <span style="color:var(--text3);font-family:var(--mono);font-size:11px">$</span>
            <input type="number" id="calc-total-stake-input" min="0.01" step="0.01"
              value="${cf2(calcResult.totalUSD)}"
              style="width:92px;text-align:right;font-weight:700"
              title="Edite para distribuir o total entre as apostas"
              oninput="calcOnTotalStakeInput(this.value)">
          </div>
        </td>
        <td></td>
        <td class="c-num-col" id="calc-tfoot-profit">
          <span class="${calcResult.minProfit>=0?"c-pos":"c-neg"}">${calcResult.minProfit>=0?"+":""}$${cf2(Math.abs(calcResult.minProfit))}</span>
          ${calcUsdcBrl?`<div class="c-dim">R$${cf2(calcResult.minProfit*calcUsdcBrl)}</div>`:""}
        </td>
      </tr>`;
  } else {
    const profitCell = document.getElementById("calc-tfoot-profit");
    if (profitCell) {
      profitCell.innerHTML = `
        <span class="${calcResult.minProfit>=0?"c-pos":"c-neg"}">${calcResult.minProfit>=0?"+":""}$${cf2(Math.abs(calcResult.minProfit))}</span>
        ${calcUsdcBrl?`<div class="c-dim">R$${cf2(calcResult.minProfit*calcUsdcBrl)}</div>`:""}`;
    }
  }

  // Cards
  const r = calcResult;
  const vc = r.isSurebet ? "c-green" : "c-red";
  document.getElementById("calc-cards").innerHTML = `
    <div class="c-card ${vc}"><div class="c-card-label">Verdict</div><div class="c-card-value">${r.isSurebet?"\u2713 Surebet":"\u2717 No arb"}</div></div>
    <div class="c-card ${vc}"><div class="c-card-label">Margin</div><div class="c-card-value">${(r.margin*100).toFixed(3)}%</div></div>
    <div class="c-card"><div class="c-card-label">Total USD</div><div class="c-card-value">$${cf2(r.totalUSD)}</div></div>
    ${calcUsdcBrl?`<div class="c-card"><div class="c-card-label">Total BRL</div><div class="c-card-value">R$${(r.totalUSD*calcUsdcBrl).toFixed(2)}</div></div>`:""}
    <div class="c-card ${vc}"><div class="c-card-label">Min Profit</div><div class="c-card-value">+$${cf2(r.minProfit)}</div></div>
    <div class="c-card ${vc}"><div class="c-card-label">ROI</div><div class="c-card-value">${r.roi.toFixed(2)}%</div></div>`;

  // ROI Badge
  if (roiBadge) {
    roiBadge.style.display = "";
    roiBadge.textContent = calcResult.roi.toFixed(2) + "%";
    roiBadge.className = "c-roi-badge " + (calcResult.isSurebet ? "c-arb" : "c-noarb");
  }

  const warn = document.getElementById("calc-brl-warn");
  if (warn) warn.style.display = (calcRows.some(r=>r.currency==="BRL") && !calcUsdcBrl) ? "" : "none";
}

// -- Input handlers --
function calcOnOddsInput(id, val) { calcRows.find(r=>r.id===id).odds = val; calcCompute(); calcUpdateDisplay(); }
function calcUseRealOdd(id) {
  const row = calcRows.find(r => r.id === id);
  if (!row) return;
  const raw = parseFloat(row.odds) || 0;
  if (raw <= 1) return;
  const priceExact = 1 / raw;
  const priceRounded = Math.round(priceExact * 100) / 100;
  if (priceRounded <= 0 || priceRounded >= 1) return;
  const realOdd = 1 / priceRounded;
  row.odds = realOdd.toFixed(10);
  calcCompute();
  calcBuildTable();
}
function calcOnCommInput(id, val) { calcRows.find(r=>r.id===id).comm = val; calcCompute(); calcUpdateDisplay(); }
function calcOnPolyChange(id, checked) {
  const row = calcRows.find(r=>r.id===id);
  row.usePoly = checked;
  const sel = document.getElementById(`calc-catsel-${id}`);
  if (sel) sel.disabled = !checked;
  calcCompute(); calcBuildTable();
}
function calcOnCatChange(id, val) { calcRows.find(r=>r.id===id).cat = val; calcCompute(); calcUpdateDisplay(); }

function calcOnStakeInput(id, val) {
  const row = calcRows.find(r=>r.id===id);
  calcTotalStakeOverride = null;
  if (row.isFixed) {
    row.fixedStake = val;
  } else {
    row.manualStake = (val === "" || val === null) ? null : val;
  }
  calcCompute(); calcUpdateDisplay();
}

function calcToggleBL(id) {
  const row = calcRows.find(r=>r.id===id);
  row.betType = row.betType === "back" ? "lay" : "back";
  if (row.betType === "lay") { row.usePoly = false; }
  calcCompute(); calcBuildTable();
}

function calcCycleCur(id) {
  const row = calcRows.find(r=>r.id===id);
  const order = ["USD","BRL"];
  const next = order[(order.indexOf(row.currency)+1) % order.length];
  row.customRate = null;
  if (row.isFixed && row.fixedStake) {
    const usd = calcToUSD(parseFloat(row.fixedStake), row.currency);
    row.fixedStake = cf2(calcFromUSD(usd, next) ?? usd);
  }
  if (row.manualStake !== null && row.manualStake !== "") {
    const usd = calcToUSD(parseFloat(row.manualStake), row.currency);
    row.manualStake = cf2(calcFromUSD(usd, next) ?? usd);
  }
  row.currency = next;
  calcCompute(); calcBuildTable();
}

function calcToggleFix(id) {
  const row = calcRows.find(r=>r.id===id);
  if (row.isFixed) {
    row.isFixed = false; row.fixedStake = "";
  } else {
    calcRows.forEach(r => { r.isFixed = false; r.fixedStake = ""; r.manualStake = null; });
    calcTotalStakeOverride = null;
    row.isFixed = true;
    const stakeEl = document.getElementById(`calc-stake-${id}`);
    const typedVal = row.manualStake !== null && row.manualStake !== ""
      ? row.manualStake
      : (stakeEl && stakeEl.value !== "" ? stakeEl.value : null);
    if (typedVal !== null) {
      row.fixedStake = typedVal;
    } else {
      const idx = calcRows.indexOf(row);
      const usd = calcResult ? calcResult.stakesUSD[idx] : 0;
      const disp = calcFromUSD(usd, row.currency);
      row.fixedStake = cf2(disp ?? usd);
    }
    row.manualStake = null;
  }
  calcCompute(); calcBuildTable();
}

function calcOnCustomRate(id, val) {
  const row = calcRows.find(r=>r.id===id);
  row.customRate = (val === "" || val === null) ? null : parseFloat(val) || null;
  calcUpdateDisplay();
}

function calcOnTotalStakeInput(val) {
  const parsed = parseFloat(val);
  if (!isNaN(parsed) && parsed > 0) {
    calcTotalStakeOverride = parsed;
    calcRows.forEach(r => { r.isFixed = false; r.fixedStake = ""; r.manualStake = null; });
    calcCompute(); calcUpdateDisplay();
  } else if (val === "" || val === null) {
    calcTotalStakeOverride = null;
    calcCompute(); calcUpdateDisplay();
  }
}

// -- Share odds --
function calcShareOdds() {
  if (!calcRows.some(r => r.odds)) return alert("Enter odds first.");
  const params = new URLSearchParams();
  params.set("n", calcNumOut);
  params.set("ft", calcForkType);
  calcRows.forEach((r, i) => {
    params.set(`o${i}`, r.odds);
    params.set(`c${i}`, r.comm);
    params.set(`bt${i}`, r.betType);
    params.set(`poly${i}`, r.usePoly ? "1" : "0");
    params.set(`cat${i}`, r.cat);
    params.set(`cur${i}`, r.currency);
    params.set(`fx${i}`, r.isFixed ? "1" : "0");
    if (r.isFixed && r.fixedStake) params.set(`fxs${i}`, r.fixedStake);
    if (r.customRate !== null) params.set(`cr${i}`, r.customRate);
  });
  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById("calc-share-btn");
    if (btn) { const orig = btn.textContent; btn.textContent = "\u2705 Link copied!"; setTimeout(() => btn.textContent = orig, 2000); }
  }).catch(() => {
    prompt("Copy this link:", url);
  });
}

// -- Import to operation (BUG FIX: uses highest BRL stake row's odd, not highest odd) --
function calcImportToOperation() {
  if (!calcResult) return alert("Calcule uma surebet antes de importar.");

  const polyRows = [];
  const bet365Rows = [];
  calcRows.forEach((row, i) => {
    const data = {
      row,
      idx: i,
      odds: parseFloat(row.odds) || 0,
      stakeUSD: calcResult.stakesUSD[i],
      stakeBRL: calcResult.stakesUSD[i] * (calcUsdcBrl || 5),
      currency: row.currency,
      usePoly: row.usePoly,
    };
    if (row.usePoly) polyRows.push(data);
    else bet365Rows.push(data);
  });

  if (!polyRows.length || !bet365Rows.length) {
    return alert("Marque pelo menos um outcome como Poly e tenha pelo menos um outcome Bet365.");
  }

  const poly = polyRows[0];
  const polyStakeUSD = poly.stakeUSD;
  const polyOdd = poly.odds;

  // Bet365 side: sum of BRL stakes, and the odd from the row with the HIGHEST BRL STAKE (the aumentada)
  const totalStakeBet365BRL = bet365Rows.reduce((s, r) => s + r.stakeBRL, 0);
  const aumentadaRow = bet365Rows.reduce((best, r) => r.stakeBRL > best.stakeBRL ? r : best, bet365Rows[0]);
  const aumentadaOdd = aumentadaRow.odds;

  const isAumentada = bet365Rows.length >= 3 && polyRows.length >= 1;
  const type = isAumentada ? 'aumentada25' : 'arbitragem';

  let notes = '';
  if (isAumentada) {
    const sorted = [...bet365Rows].sort((a, b) => b.stakeBRL - a.stakeBRL);
    notes = sorted.map((r, i) => {
      const label = i === 0 ? 'Aumentada' : `Aposta ${i + 1}`;
      const stakeDisplay = r.currency === 'BRL'
        ? `R$${r.stakeBRL.toFixed(2)}`
        : `$${r.stakeUSD.toFixed(2)} (R$${r.stakeBRL.toFixed(2)})`;
      return `${label}: odd ${r.odds.toFixed(2)} / stake ${stakeDisplay}`;
    }).join(' | ');
    notes += ` | Poly: odd ${polyOdd.toFixed(2)} / $${polyStakeUSD.toFixed(2)}`;
  }

  window._calcImport = {
    type,
    stakeBet365: totalStakeBet365BRL,
    oddBet365: aumentadaOdd,
    stakePolyUSD: polyStakeUSD,
    oddPoly: polyOdd,
    exchangeRate: calcUsdcBrl || 5,
    notes,
  };

  navigate('new-operation');
  toast('Dados importados da calculadora!', 'success');
}

// -- Scenario Simulator --
function calcRenderSimulator() {
  const container = document.getElementById('calc-simulator');
  if (!container) return;

  if (!calcResult || !calcResult.isSurebet) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  const r = calcResult;
  const fx = calcUsdcBrl || 5.0;

  // Breakeven: at what margin does profit = 0? margin = 1.0
  // Find how much one odd can drop before margin hits 1
  const effArr = r.effArr;
  const breakevens = effArr.map((_, i) => {
    const otherSum = effArr.reduce((s, o, j) => j === i ? s : s + 1/o, 0);
    const neededInv = 1 - otherSum;
    if (neededInv <= 0) return null;
    return 1 / neededInv;
  });

  const currentTotal = r.totalUSD;

  const beRows = breakevens.map((be, i) => {
    if (!be) return null;
    const currentEff = effArr[i];
    const drop = currentEff - be;
    const dropPct = currentEff > 1 ? (drop / (currentEff - 1) * 100) : 0;
    return { idx: i, currentEff, breakeven: be, drop, dropPct };
  }).filter(Boolean);

  container.innerHTML = `
    <div style="
      margin-bottom:12px;padding:16px;
      background:var(--surface2);border:1px solid var(--border);
      border-radius:var(--r-sm);
    ">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:600;opacity:.85">\uD83D\uDD2C Simulador de Cen\u00E1rios</h3>

      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px">Breakeven por Linha</div>
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr style="color:var(--text3)">
            <th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">#</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Odd Atual</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Odd Breakeven</th>
            <th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">Margem</th>
          </tr></thead>
          <tbody>
            ${beRows.map(b => `
              <tr>
                <td style="padding:3px 8px;font-family:var(--mono)">${b.idx + 1}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono)">${b.currentEff.toFixed(3)}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:var(--yellow)">${b.breakeven.toFixed(3)}</td>
                <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:${b.dropPct > 10 ? 'var(--green-bright)' : 'var(--red)'}">
                  ${b.dropPct.toFixed(1)}%
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="font-size:10px;color:var(--text3);margin-top:6px">
          Margem = quanto a odd efetiva pode cair antes de perder a surebet
        </div>
      </div>

      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Simulador R\u00E1pido</div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--text3)">Stake total:</label>
          <input type="range" id="calc-sim-slider" min="10" max="10000" step="10" value="${Math.round(currentTotal)}"
            oninput="calcSimSliderUpdate()" style="flex:1;min-width:120px;accent-color:var(--green-bright)">
          <span id="calc-sim-stake" style="font-family:var(--mono);font-size:13px;min-width:70px">$${Math.round(currentTotal)}</span>
          <span id="calc-sim-profit" style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--green-bright);min-width:90px">
            \u2192 R$${(r.minProfit * fx).toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  `;
}

function calcSimSliderUpdate() {
  const slider = document.getElementById('calc-sim-slider');
  const stakeEl = document.getElementById('calc-sim-stake');
  const profitEl = document.getElementById('calc-sim-profit');
  if (!slider || !calcResult) return;
  const total = parseFloat(slider.value);
  const profit = total * (calcResult.roi / 100);
  const fx = calcUsdcBrl || 5.0;
  stakeEl.textContent = `$${Math.round(total)}`;
  profitEl.textContent = `\u2192 R$${(profit * fx).toFixed(2)}`;
}

function calcResetAll() {
  calcNumOut = 2; calcForkType = "1-2";
  calcRows = [makeCalcRow(1), makeCalcRow(2)];
  calcNextId = 3; calcRoundValue = 0; calcRoundUseFx = false; calcTotalStakeOverride = null;
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle("on", b.textContent==="2"));
  calcBuildForkSelect();
  calcShowComm = false;
  const commBtn = document.getElementById("calc-show-comm-btn");
  if (commBtn) { commBtn.textContent = "Show commissions"; commBtn.classList.remove("on"); }
  calcSaveState();
  calcCompute(); calcBuildTable();
}

// -- Odds history (last 10 saved calculations) --
const CALC_HISTORY_KEY = 'calcOddsHistory';
const CALC_HISTORY_MAX = 10;

function calcGetHistory() {
  try {
    return JSON.parse(localStorage.getItem(CALC_HISTORY_KEY) || '[]');
  } catch (_) { return []; }
}

function calcSaveToHistory() {
  if (!calcResult || !calcResult.isSurebet) return; // only save surebets
  const entry = {
    ts: Date.now(),
    forkType: calcForkType,
    numOut: calcNumOut,
    roi: calcResult.roi,
    minProfit: calcResult.minProfit,
    totalUSD: calcResult.totalUSD,
    rows: calcRows.map(r => ({
      odds: r.odds, comm: r.comm, betType: r.betType,
      usePoly: r.usePoly, cat: r.cat, currency: r.currency,
      customRate: r.customRate,
    })),
  };
  const history = calcGetHistory();
  // Avoid duplicate: skip if last entry has same odds
  if (history.length > 0) {
    const last = history[0];
    const sameOdds = last.rows.length === entry.rows.length &&
      last.rows.every((r, i) => r.odds === entry.rows[i].odds && r.betType === entry.rows[i].betType);
    if (sameOdds) return;
  }
  history.unshift(entry);
  if (history.length > CALC_HISTORY_MAX) history.length = CALC_HISTORY_MAX;
  localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(history));
  calcRenderHistory();
}

function calcLoadFromHistory(idx) {
  const history = calcGetHistory();
  const entry = history[idx];
  if (!entry) return;
  calcNumOut = entry.numOut || 2;
  calcForkType = entry.forkType || "1-2";
  calcTotalStakeOverride = null;
  calcRows = entry.rows.map((r, i) => ({
    id: i + 1, odds: r.odds || "", comm: r.comm || "0",
    betType: r.betType || "back", usePoly: !!r.usePoly,
    cat: r.cat || "Sports", currency: r.currency || "USD",
    isFixed: false, fixedStake: "", manualStake: null,
    customRate: r.customRate !== undefined ? r.customRate : null,
  }));
  calcNextId = calcRows.length + 1;

  // Update outcome buttons
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b =>
    b.classList.toggle('on', parseInt(b.textContent) === calcNumOut)
  );
  calcBuildForkSelect();
  const forkSel = document.getElementById('calc-fork-type');
  if (forkSel) forkSel.value = calcForkType;

  calcCompute();
  calcBuildTable();
  toast('C\u00E1lculo restaurado do hist\u00F3rico');
}

function calcDeleteHistory(idx) {
  const history = calcGetHistory();
  history.splice(idx, 1);
  localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(history));
  calcRenderHistory();
}

function calcClearHistory() {
  localStorage.removeItem(CALC_HISTORY_KEY);
  calcRenderHistory();
}

function calcRenderHistory() {
  const container = document.getElementById('calc-history-list');
  if (!container) return;
  const history = calcGetHistory();
  if (!history.length) {
    container.innerHTML = `<div style="color:var(--text3);font-size:12px;padding:8px 0;text-align:center">Nenhum c\u00E1lculo salvo. Use o bot\u00E3o \u201CSalvar no hist\u00F3rico\u201D para guardar um c\u00E1lculo.</div>`;
    return;
  }
  container.innerHTML = history.map((entry, idx) => {
    const date = new Date(entry.ts);
    const timeStr = date.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' }) + ' ' +
      date.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const oddsStr = entry.rows.map((r, i) => {
      const prefix = r.betType === 'lay' ? 'L' : '';
      const poly = r.usePoly ? '*' : '';
      return `${prefix}${r.odds}${poly}`;
    }).join(' / ');
    const forkLabel = entry.forkType || '';
    return `
      <div style="
        display:flex;align-items:center;gap:10px;
        padding:8px 12px;
        background:var(--surface2);border:1px solid var(--border);
        border-radius:var(--r-sm);font-size:12px;
      ">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--mono);font-weight:600;color:var(--text)">${oddsStr}</div>
          <div style="color:var(--text3);font-size:10px;margin-top:2px">${timeStr} \u2022 ${forkLabel} \u2022 ROI: <span style="color:${entry.roi >= 0 ? 'var(--green-bright)' : 'var(--red)'}">${entry.roi.toFixed(2)}%</span></div>
        </div>
        <button class="c-btn" style="padding:3px 8px;font-size:11px" onclick="calcLoadFromHistory(${idx})" title="Carregar">\u21BB</button>
        <button class="c-btn" style="padding:3px 8px;font-size:11px;color:var(--red)" onclick="calcDeleteHistory(${idx})" title="Remover">\u2715</button>
      </div>
    `;
  }).join('');
}

// -- State persistence --
function calcSaveState() {
  const state = {
    numOut: calcNumOut,
    showComm: calcShowComm,
    roundValue: calcRoundValue,
    roundUseFx: calcRoundUseFx,
    forkType: calcForkType,
    totalStakeOverride: calcTotalStakeOverride,
    nextId: calcNextId,
    rows: calcRows.map(r => ({
      id: r.id, odds: r.odds, comm: r.comm, betType: r.betType,
      usePoly: r.usePoly, cat: r.cat, currency: r.currency,
      isFixed: r.isFixed, fixedStake: r.fixedStake,
      manualStake: r.manualStake, customRate: r.customRate
    })),
  };
  sessionStorage.setItem('calcState', JSON.stringify(state));
}

function calcRestoreState() {
  try {
    const raw = sessionStorage.getItem('calcState');
    if (!raw) return false;
    const state = JSON.parse(raw);
    calcNumOut = state.numOut || 2;
    calcShowComm = state.showComm || false;
    calcRoundValue = state.roundValue || 0;
    calcRoundUseFx = state.roundUseFx || false;
    calcForkType = state.forkType || "1-2";
    calcTotalStakeOverride = state.totalStakeOverride || null;
    calcNextId = state.nextId || 3;
    if (state.rows && state.rows.length) {
      calcRows = state.rows.map(r => ({
        id: r.id, odds: r.odds || "", comm: r.comm || "0",
        betType: r.betType || "back", usePoly: !!r.usePoly,
        cat: r.cat || "Sports", currency: r.currency || "USD",
        isFixed: !!r.isFixed, fixedStake: r.fixedStake || "",
        manualStake: r.manualStake !== undefined ? r.manualStake : null,
        customRate: r.customRate !== undefined ? r.customRate : null
      }));
    } else {
      return false;
    }
    return true;
  } catch (_) { return false; }
}

// Persist current state on every change (does NOT save to history — that's manual).
const _origCalcCompute = calcCompute;
calcCompute = function() {
  _origCalcCompute();
  calcSaveState();
};

function calcManualSaveToHistory() {
  if (!calcResult || !calcResult.isSurebet) {
    toast('Nada para salvar: insira uma surebet v\u00E1lida primeiro', 'error');
    return;
  }
  const before = calcGetHistory().length;
  calcSaveToHistory();
  const after = calcGetHistory().length;
  if (after > before) toast('C\u00E1lculo salvo no hist\u00F3rico', 'success');
  else toast('Esse c\u00E1lculo j\u00E1 est\u00E1 no hist\u00F3rico', 'info');
}

// -- Load shared odds from URL --
function calcLoadFromURL() {
  const params = new URLSearchParams(location.search);
  if (!params.has("n") || !params.has("o0")) return false;

  const n = parseInt(params.get("n")) || 2;
  calcNumOut = n;
  calcForkType = params.get("ft") || "1-2";
  calcShowComm = false;
  calcRoundValue = 0;
  calcRoundUseFx = false;
  calcTotalStakeOverride = null;
  calcRows = [];
  for (let i = 0; i < n; i++) {
    const r = makeCalcRow(i + 1);
    r.odds     = params.get(`o${i}`)   || "";
    r.comm     = params.get(`c${i}`)   || "0";
    r.betType  = params.get(`bt${i}`)  || "back";
    r.usePoly  = params.get(`poly${i}`) === "1";
    r.cat      = params.get(`cat${i}`) || "Sports";
    r.currency = params.get(`cur${i}`) || "USD";
    r.isFixed  = params.get(`fx${i}`) === "1";
    r.fixedStake = r.isFixed ? (params.get(`fxs${i}`) || "") : "";
    r.customRate = params.has(`cr${i}`) ? parseFloat(params.get(`cr${i}`)) || null : null;
    calcRows.push(r);
  }
  calcNextId = n + 1;

  // Clean URL params so refresh doesn't re-apply
  history.replaceState(null, '', location.pathname);
  return true;
}

// -- Render --
function renderCalculator() {
  // Priority: URL params > sessionStorage > defaults
  const fromURL = calcLoadFromURL();
  if (!fromURL) {
    const restored = calcRestoreState();
    if (!restored) {
      calcRows = [makeCalcRow(1), makeCalcRow(2)];
      calcNextId = 3;
      calcNumOut = 2;
      calcShowComm = false;
      calcRoundValue = 0;
      calcRoundUseFx = false;
      calcForkType = "1-2";
      calcTotalStakeOverride = null;
      calcResult = null;
    }
  }

  const stored = localStorage.getItem("calcDarkMode");
  if (stored !== null) calcDarkMode = stored === "true";

  const mc = document.getElementById('main-content');
  mc.innerHTML = `
  <div class="calc-page ${calcDarkMode ? '' : 'light'}" id="calc-page-root">

    <div class="c-hdr">
      <div class="c-hdr-brand">
        <h2>Sure<em>bet</em></h2>
        <div class="c-sub">Arbitrage + Polymarket</div>
      </div>
      <div class="c-hdr-right">
        <div id="calc-roi-badge" class="c-roi-badge" style="display:none">\u2014</div>
        <button class="c-theme-btn" id="calc-theme-btn" onclick="calcToggleTheme()">${calcDarkMode ? "\u2728 Light" : "\uD83C\uDF19 Dark"}</button>
        <div class="c-ticker">
          <div class="c-ticker-top">
            <span><span class="c-dot c-dot-load" id="calc-status-dot"></span>USDC / BRL</span>
            <button class="c-refresh-btn" onclick="calcFetchRate()" title="Atualizar">\u21BA</button>
          </div>
          <div id="calc-ticker-body"><div class="c-ticker-load">Buscando cota\u00E7\u00E3o\u2026</div></div>
          <div class="c-ticker-note">\u21BB atualiza a cada 5s</div>
        </div>
      </div>
    </div>

    <div class="c-controls">
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Outcomes</span>
        <div id="calc-outcome-btns" style="display:flex;gap:5px">
          ${[2,3,4,5,6].map(n => `<button class="c-btn ${n===calcNumOut?'on':''}" onclick="calcSetOutcomes(${n})">${n}</button>`).join('')}
        </div>
      </div>
      <div class="c-ctrl-sep"></div>
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Type</span>
        <select class="c-fork-select" id="calc-fork-type" onchange="calcOnForkChange()"></select>
      </div>
      <div class="c-ctrl-sep"></div>
      <button class="c-btn ${calcShowComm?'on':''}" id="calc-show-comm-btn" onclick="calcToggleShowComm()">${calcShowComm ? "Hide commissions" : "Show commissions"}</button>

      <div id="calc-brl-warn" style="display:none" class="c-warn-bar">\u26A0 Linhas em BRL precisam da cota\u00E7\u00E3o ao vivo</div>
    </div>

    <div class="c-tbl-wrap">
      <table>
        <thead id="calc-thead"></thead>
        <tbody id="calc-tbody"></tbody>
        <tfoot id="calc-tfoot"></tfoot>
      </table>
    </div>

    <div class="c-cards" id="calc-cards"></div>

    <div class="c-actions">
      <button class="c-btn c-primary" onclick="calcShareOdds()" id="calc-share-btn">\uD83D\uDD17 Share odds</button>
      <button class="c-btn c-primary" onclick="calcImportToOperation()" id="calc-import-btn">\uD83D\uDCE5 Importar p/ Opera\u00E7\u00E3o</button>
      <button class="c-btn" onclick="calcManualSaveToHistory()" id="calc-save-history-btn">\uD83D\uDCBE Salvar no hist\u00F3rico</button>
      <button class="c-btn" onclick="calcResetAll()">Reset all</button>
    </div>

    <div id="calc-simulator" style="display:none"></div>

    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;font-size:14px;font-weight:600;opacity:.85">\uD83D\uDCCB Hist\u00F3rico de C\u00E1lculos</h3>
        <button class="c-btn" onclick="calcClearHistory()" style="font-size:11px;padding:3px 10px">Limpar</button>
      </div>
      <div id="calc-history-list" style="display:flex;flex-direction:column;gap:6px"></div>
    </div>

    <div class="c-legend">
      <strong>Polymarket taker fee (a partir de 30/03/2026):</strong><br>
      Back: <code>eff = 1 + (raw\u22121)\u00D7(1\u2212c%)</code> | Lay: <code>eff = raw \u2212 c%</code><br>
      <code>taker_fee = feeRate \u00D7 (p \u00D7 (1\u2212p))^exponent</code> onde p = 1/eff_odds.
    </div>

  </div>`;

  // Build fork select
  calcBuildForkSelect();

  // Start rate fetching
  calcFetchRate();
  calcRateInterval = setInterval(calcFetchRate, 5000);

  // Build initial table
  calcCompute();
  calcBuildTable();
  calcRenderHistory();
}

// ===== FREEBETS =====
async function renderFreebets() {
  await loadAccounts();
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Freebets</h1>
        <p class="page-description">Registro semanal de volume e freebets por conta</p>
      </div>
      <button class="btn btn-primary" onclick="showFreebetForm()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Registrar Semana
      </button>
    </div>
    <div id="freebet-form-area"></div>
    <div class="table-container">
      <div class="table-header"><h3 class="table-title">Histórico de Freebets</h3></div>
      <div id="freebets-list"></div>
    </div>
  `;
  loadFreebets();
}

async function loadFreebets() {
  try {
    const freebets = await api('/api/freebets');
    const container = document.getElementById('freebets-list');
    if (!freebets.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">&#127873;</div><div class="empty-state-text">Nenhuma freebet registrada</div></div>`;
      return;
    }
    container.innerHTML = freebets.map(fb => {
      const accName = userAccounts.find(a => a.id === fb.account_id)?.name || 'Conta removida';
      return `
        <div class="freebet-card">
          <div>
            <div class="freebet-week">Semana de ${formatDate(fb.week_start)} - ${escapeHtml(accName)}</div>
            <div class="freebet-detail">Volume: ${formatBRL(fb.volume_accumulated)} | Lucro freebet: ${formatBRL(fb.freebet_profit)}</div>
            ${fb.notes ? `<div class="freebet-detail">${escapeHtml(fb.notes)}</div>` : ''}
          </div>
          <div class="freebet-status">
            <div class="freebet-dot ${fb.freebet_earned ? 'earned' : 'not-earned'}"></div>
            <span style="font-size:12px;color:var(--text-muted)">${fb.freebet_earned ? (fb.freebet_used ? 'Usada' : 'Pendente') : 'Não ganhou'}</span>
            <button class="btn btn-ghost btn-sm" onclick="deleteFreebet(${fb.id})" style="margin-left:8px">&#128465;</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) { toast(err.message, 'error'); }
}

function showFreebetForm() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const weekStart = monday.toISOString().split('T')[0];
  const activeAccounts = userAccounts.filter(a => a.active);

  document.getElementById('freebet-form-area').innerHTML = `
    <div class="chart-container">
      <h3 class="chart-title">Registrar Freebet Semanal</h3>
      <form id="freebet-form" class="form-grid">
        <div class="form-group">
          <label class="form-label">Conta Bet365</label>
          <select class="form-select" id="fb-account" required>
            <option value="">Selecione a conta</option>
            ${activeAccounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Início da Semana (segunda)</label>
          <input type="date" class="form-input" id="fb-week-start" value="${weekStart}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Volume Acumulado (R$)</label>
          <input type="number" step="0.01" class="form-input" id="fb-volume" placeholder="0,00">
        </div>
        <div class="form-group">
          <label class="form-label">Ganhou Freebet?</label>
          <select class="form-select" id="fb-earned">
            <option value="0">Não</option>
            <option value="1">Sim</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Usou Freebet?</label>
          <select class="form-select" id="fb-used">
            <option value="0">Não</option>
            <option value="1">Sim</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Lucro da Freebet (R$)</label>
          <input type="number" step="0.01" class="form-input" id="fb-profit" placeholder="0,00">
        </div>
        <div class="form-group full">
          <label class="form-label">Notas</label>
          <input type="text" class="form-input" id="fb-notes" placeholder="Observações">
        </div>
        <div class="form-group full" style="display:flex;gap:12px;justify-content:flex-end">
          <button type="button" class="btn btn-ghost" onclick="document.getElementById('freebet-form-area').innerHTML=''">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById('freebet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountId = document.getElementById('fb-account').value;
    if (!accountId) { toast('Selecione uma conta', 'error'); return; }
    try {
      await api('/api/freebets', {
        method: 'POST',
        body: {
          account_id: Number(accountId),
          week_start: document.getElementById('fb-week-start').value,
          volume_accumulated: parseFloat(document.getElementById('fb-volume').value) || 0,
          freebet_earned: document.getElementById('fb-earned').value === '1',
          freebet_used: document.getElementById('fb-used').value === '1',
          freebet_profit: parseFloat(document.getElementById('fb-profit').value) || 0,
          notes: document.getElementById('fb-notes').value,
        }
      });
      toast('Freebet registrada!');
      document.getElementById('freebet-form-area').innerHTML = '';
      loadFreebets();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function deleteFreebet(id) {
  if (!confirm('Excluir este registro de freebet?')) return;
  try {
    await api(`/api/freebets/${id}`, { method: 'DELETE' });
    toast('Registro excluído');
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

// ===== ADMIN PANEL =====

let adminTab = 'notify'; // 'notify' | 'operations' | 'audit'
let adminUsers = [];

async function renderAdmin() {
  if (!currentUser?.is_admin) {
    const mc = document.getElementById('main-content');
    mc.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">Acesso restrito.</div>`;
    return;
  }
  try { adminUsers = await api('/api/admin/users'); } catch (err) { adminUsers = []; }

  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Admin</h1>
        <p class="page-description">Painel administrativo — ações ficam registradas no audit log</p>
      </div>
    </div>

    <div class="watcher-tabs">
      <button class="watcher-tab ${adminTab === 'notify' ? 'active' : ''}" onclick="switchAdminTab('notify')">Enviar notificação</button>
      <button class="watcher-tab ${adminTab === 'operations' ? 'active' : ''}" onclick="switchAdminTab('operations')">Operações</button>
      <button class="watcher-tab ${adminTab === 'audit' ? 'active' : ''}" onclick="switchAdminTab('audit')">Audit log</button>
    </div>

    <div id="admin-content"></div>
  `;
  switchAdminTab(adminTab);
}

function switchAdminTab(tab) {
  adminTab = tab;
  document.querySelectorAll('.watcher-tab').forEach(el => {
    const txt = el.textContent.trim().toLowerCase();
    el.classList.toggle('active',
      (tab === 'notify' && txt.startsWith('enviar')) ||
      (tab === 'operations' && txt.startsWith('operações')) ||
      (tab === 'audit' && txt.startsWith('audit'))
    );
  });
  if (tab === 'notify') renderAdminNotify();
  else if (tab === 'operations') renderAdminOperations();
  else renderAdminAudit();
}

function renderAdminNotify() {
  const container = document.getElementById('admin-content');
  if (!container) return;
  const userOpts = adminUsers.map(u =>
    `<option value="${u.id}">${escapeHtml(u.display_name)} (${escapeHtml(u.username)})</option>`
  ).join('');
  container.innerHTML = `
    <div class="chart-container" style="max-width:640px">
      <h3 class="chart-title" style="margin-bottom:16px">Enviar notificação de sistema</h3>
      <div class="form-group">
        <label class="form-label">Destinatário</label>
        <select class="form-select" id="admin-notif-target">
          <option value="">Todos os usuários</option>
          ${userOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Título</label>
        <input type="text" class="form-input" id="admin-notif-title" maxlength="200" placeholder="Ex: Nova atualização disponível">
      </div>
      <div class="form-group">
        <label class="form-label">Corpo (opcional)</label>
        <textarea class="form-input" id="admin-notif-body" maxlength="2000" rows="4" placeholder="Detalhes da mensagem..."></textarea>
      </div>
      <button class="btn btn-primary" onclick="submitAdminNotif()">Enviar</button>
    </div>
  `;
}

async function submitAdminNotif() {
  const target = document.getElementById('admin-notif-target').value;
  const title = document.getElementById('admin-notif-title').value.trim();
  const body = document.getElementById('admin-notif-body').value.trim();
  if (!title) { toast('Título é obrigatório', 'error'); return; }
  try {
    const r = await api('/api/admin/notifications', {
      method: 'POST',
      body: { title, body, user_id: target || null },
    });
    toast(`Notificação enviada para ${r.inserted} usuário(s)`);
    document.getElementById('admin-notif-title').value = '';
    document.getElementById('admin-notif-body').value = '';
  } catch (err) { toast(err.message, 'error'); }
}

async function renderAdminOperations() {
  const container = document.getElementById('admin-content');
  if (!container) return;
  const userOpts = adminUsers.map(u =>
    `<option value="${u.id}">${escapeHtml(u.display_name)} (${escapeHtml(u.username)})</option>`
  ).join('');
  container.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
      <label style="font-size:13px;color:var(--text-muted)">Usuário:</label>
      <select class="form-select" id="admin-op-user" onchange="loadAdminOps()" style="min-width:220px">
        <option value="">Todos</option>
        ${userOpts}
      </select>
      <button class="btn btn-ghost btn-sm" onclick="loadAdminOps()">⟳ Recarregar</button>
    </div>
    <div id="admin-ops-list"><div style="padding:20px;color:var(--text-muted)">Carregando...</div></div>
  `;
  loadAdminOps();
}

async function loadAdminOps() {
  const userId = document.getElementById('admin-op-user')?.value || '';
  const listEl = document.getElementById('admin-ops-list');
  if (!listEl) return;
  try {
    const q = userId ? `?user_id=${userId}&limit=200` : '?limit=200';
    const { operations, total } = await api(`/api/admin/operations${q}`);
    if (!operations.length) {
      listEl.innerHTML = `<div style="padding:20px;color:var(--text-muted)">Nenhuma operação encontrada.</div>`;
      return;
    }
    listEl.innerHTML = `
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:8px">${total} operação(ões)</div>
      <table class="table">
        <thead><tr>
          <th>Data</th><th>Usuário</th><th>Tipo</th><th>Jogo</th><th>Resultado</th><th>Lucro</th><th></th>
        </tr></thead>
        <tbody>
          ${operations.map(op => `
            <tr>
              <td>${new Date(op.created_at + (op.created_at.includes('Z') ? '' : 'Z')).toLocaleDateString('pt-BR')}</td>
              <td>${escapeHtml(op.user_display_name || '')}</td>
              <td>${escapeHtml(op.type)}</td>
              <td>${escapeHtml(op.game || '')}</td>
              <td>${escapeHtml(op.result || '')}</td>
              <td style="color:${op.profit >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatBRL(op.profit || 0)}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-ghost btn-sm" onclick="openAdminEditOp(${op.id})">Editar</button>
                <button class="btn btn-ghost btn-sm" onclick="adminDeleteOp(${op.id})" style="color:var(--danger)">Excluir</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--danger);padding:20px">${escapeHtml(err.message)}</div>`;
  }
}

async function openAdminEditOp(id) {
  try {
    const { operations } = await api(`/api/admin/operations?limit=500`);
    const op = operations.find(o => o.id === id);
    if (!op) { toast('Operação não encontrada', 'error'); return; }
    const newProfit = prompt(`Lucro atual: ${op.profit}\nNovo lucro (R$):`, op.profit);
    if (newProfit === null) return;
    const parsed = parseFloat(newProfit);
    if (isNaN(parsed)) { toast('Valor inválido', 'error'); return; }
    await api(`/api/admin/operations/${id}`, { method: 'PUT', body: { profit: parsed } });
    toast('Operação atualizada');
    loadAdminOps();
  } catch (err) { toast(err.message, 'error'); }
}

async function adminDeleteOp(id) {
  if (!confirm('Excluir esta operação? A ação será registrada no audit log.')) return;
  try {
    await api(`/api/admin/operations/${id}`, { method: 'DELETE' });
    toast('Operação excluída');
    loadAdminOps();
  } catch (err) { toast(err.message, 'error'); }
}

async function renderAdminAudit() {
  const container = document.getElementById('admin-content');
  if (!container) return;
  try {
    const { actions } = await api('/api/admin/actions?limit=200');
    if (!actions.length) {
      container.innerHTML = `<div style="padding:20px;color:var(--text-muted)">Nenhuma ação registrada ainda.</div>`;
      return;
    }
    container.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>Quando</th><th>Admin</th><th>Ação</th><th>Alvo</th><th>IP</th><th>Detalhes</th>
        </tr></thead>
        <tbody>
          ${actions.map(a => {
            const when = new Date(a.created_at + (a.created_at.includes('Z') ? '' : 'Z'));
            const whenStr = when.toLocaleDateString('pt-BR') + ' ' + when.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
            const target = a.target_display_name
              ? `${escapeHtml(a.target_display_name)}${a.target_operation_id ? ` (op #${a.target_operation_id})` : ''}`
              : (a.target_operation_id ? `op #${a.target_operation_id}` : '—');
            const detStr = a.details ? JSON.stringify(a.details) : '';
            return `<tr>
              <td style="white-space:nowrap">${whenStr}</td>
              <td>${escapeHtml(a.admin_display_name || '')}</td>
              <td>${escapeHtml(a.action)}</td>
              <td>${target}</td>
              <td style="font-family:monospace;font-size:11px">${escapeHtml(a.ip || '')}</td>
              <td style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(detStr)}">${escapeHtml(detStr.slice(0,80))}${detStr.length > 80 ? '…' : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);padding:20px">${escapeHtml(err.message)}</div>`;
  }
}

function startBgPolling() {
  if (bgWatcherTimer) clearInterval(bgWatcherTimer);
  bgWatcherTimer = setInterval(bgPoll, 30000);
}

function stopBgPolling() {
  if (bgWatcherTimer) { clearInterval(bgWatcherTimer); bgWatcherTimer = null; }
}

async function renderWatcher() {
  await loadWatchedWallets();
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Watcher</h1>
        <p class="page-description">Monitore posições Polymarket do grupo</p>
      </div>
      <div class="watcher-controls">
        <div class="watcher-status">
          <div class="watcher-status-dot ${watcherPaused ? 'paused' : ''}" id="watcher-dot"></div>
          <span id="watcher-status-text">${watcherPaused ? 'Pausado' : 'Monitorando'}</span>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="toggleWatcherPause()" id="watcher-pause-btn">
          ${watcherPaused ? '▶ Retomar' : '⏸ Pausar'}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="toggleWatcherSound()" id="watcher-sound-btn">
          ${watcherSoundEnabled ? '🔔 Som ON' : '🔕 Som OFF'}
        </button>
        <button class="btn btn-primary btn-sm" onclick="manualPoll()">⟳ Verificar agora</button>
      </div>
    </div>

    <div class="watcher-tabs" id="watcher-tabs">
      <button class="watcher-tab ${watcherTab === 'alerts' ? 'active' : ''}" onclick="switchWatcherTab('alerts')">Alertas</button>
      <button class="watcher-tab ${watcherTab === 'positions' ? 'active' : ''}" onclick="switchWatcherTab('positions')">Posições Ativas</button>
      <button class="watcher-tab ${watcherTab === 'config' ? 'active' : ''}" onclick="switchWatcherTab('config')">Wallets</button>
    </div>

    <div id="watcher-content"></div>
  `;

  switchWatcherTab(watcherTab);
}

function switchWatcherTab(tab) {
  watcherTab = tab;
  document.querySelectorAll('.watcher-tab').forEach(el => {
    el.classList.toggle('active', el.textContent.trim().toLowerCase().startsWith(
      tab === 'alerts' ? 'alerta' : tab === 'positions' ? 'posi' : 'wallet'
    ));
  });
  if (tab === 'alerts') renderWatcherAlerts();
  else if (tab === 'positions') renderWatcherPositions();
  else renderWatcherConfig();
}

async function renderWatcherAlerts() {
  const container = document.getElementById('watcher-content');

  // Read filter values BEFORE overwriting the container (otherwise they get destroyed)
  const walletFilter = document.getElementById('alert-filter-wallet')?.value || '';
  const typeFilter = document.getElementById('alert-filter-type')?.value || '';
  const fromFilter = document.getElementById('alert-filter-from')?.value || '';
  const toFilter = document.getElementById('alert-filter-to')?.value || '';

  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div>';

  try {
    // Build filter query string
    const params = new URLSearchParams({ limit: 50 });
    if (walletFilter) params.append('wallet_id', walletFilter);
    if (typeFilter) params.append('type', typeFilter);
    if (fromFilter) params.append('from', fromFilter);
    if (toFilter) params.append('to', toFilter);

    const data = await api(`/api/watcher/alerts?${params}`);
    // Mark as seen
    if (data.alerts.length > 0) {
      const unseenIds = data.alerts.filter(a => !a.seen).map(a => a.id);
      if (unseenIds.length > 0) {
        await api('/api/watcher/alerts/seen', { method: 'POST', body: { ids: unseenIds } });
        unseenAlertCount = Math.max(0, unseenAlertCount - unseenIds.length);
        updateBadge();
      }
    }

    // Build wallet options for filter
    const walletOptions = watchedWallets.map(w =>
      `<option value="${w.id}" ${walletFilter == w.id ? 'selected' : ''}>${escapeHtml(w.label)}</option>`
    ).join('');

    const filtersHTML = `
      <div class="filters-bar" style="margin-bottom:12px;flex-wrap:wrap">
        <select class="form-select" id="alert-filter-wallet" onchange="renderWatcherAlerts()" style="min-width:130px">
          <option value="">Todas wallets</option>
          ${walletOptions}
        </select>
        <select class="form-select" id="alert-filter-type" onchange="renderWatcherAlerts()" style="min-width:130px">
          <option value="" ${!typeFilter ? 'selected' : ''}>Todos tipos</option>
          <option value="new_position" ${typeFilter === 'new_position' ? 'selected' : ''}>Nova posição</option>
          <option value="position_closed" ${typeFilter === 'position_closed' ? 'selected' : ''}>Posição fechada</option>
          <option value="trade_buy" ${typeFilter === 'trade_buy' ? 'selected' : ''}>Compra adicional</option>
          <option value="trade_sell" ${typeFilter === 'trade_sell' ? 'selected' : ''}>Venda parcial</option>
        </select>
        <input type="date" class="form-input" id="alert-filter-from" value="${fromFilter || ''}" onchange="renderWatcherAlerts()" style="min-width:130px">
        <input type="date" class="form-input" id="alert-filter-to" value="${toFilter || ''}" onchange="renderWatcherAlerts()" style="min-width:130px">
        <button class="btn btn-ghost btn-sm" onclick="clearAlertFilters()">Limpar filtros</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-sm" onclick="clearAllAlerts()">Limpar tudo</button>
      </div>
    `;

    if (!data.alerts.length) {
      container.innerHTML = filtersHTML + `
        <div class="empty-state">
          <div class="empty-state-icon">👁️</div>
          <div class="empty-state-text">Nenhum alerta encontrado</div>
          <div class="empty-state-sub">${walletFilter || typeFilter || fromFilter || toFilter ? 'Tente ajustar os filtros' : 'Adicione wallets na aba "Wallets" e os alertas aparecerão aqui quando houver atividade'}</div>
        </div>
      `;
      return;
    }

    container.innerHTML = filtersHTML + `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${data.total} alerta(s) encontrado(s)</div>
      <div class="alert-feed">
        ${data.alerts.map(a => renderAlertCard(a)).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px">${err.message}</div>`;
  }
}

function clearAlertFilters() {
  const w = document.getElementById('alert-filter-wallet');
  const t = document.getElementById('alert-filter-type');
  const f = document.getElementById('alert-filter-from');
  const to = document.getElementById('alert-filter-to');
  if (w) w.value = '';
  if (t) t.value = '';
  if (f) f.value = '';
  if (to) to.value = '';
  renderWatcherAlerts();
}

function renderAlertCard(a) {
  const isNew = a.type === 'new_position' || a.type === 'trade_buy';
  const iconClass = a.type === 'position_closed' ? 'closed' : isNew ? 'buy' : 'sell';
  const iconEmoji = a.type === 'new_position' ? '🟢' :
                    a.type === 'position_closed' ? '🔴' :
                    a.type === 'trade_buy' ? '📈' : '📉';
  const typeText = a.type === 'new_position' ? 'Nova posição' :
                   a.type === 'position_closed' ? 'Posição fechada' :
                   a.type === 'trade_buy' ? 'Compra adicional' : 'Venda parcial';

  const time = a.created_at ? new Date(a.created_at).toLocaleString('pt-BR') : '';

  return `
    <div class="alert-card ${a.seen ? '' : 'unseen'}">
      <div class="alert-card-icon ${iconClass}">${iconEmoji}</div>
      <div class="alert-card-body">
        <div class="alert-card-header">
          <span class="alert-card-member">${escapeHtml(a.wallet_label || 'Desconhecido')}</span>
          <span class="alert-card-time">${time}</span>
        </div>
        <div class="alert-card-title">${escapeHtml(a.title)}</div>
        <div class="alert-card-details">
          <div class="alert-detail"><span>${typeText}</span></div>
          ${a.outcome ? `<div class="alert-detail">Resultado: <strong>${escapeHtml(a.outcome)}</strong></div>` : ''}
          ${a.size ? `<div class="alert-detail">Shares: <strong>${Number(a.size).toFixed(2)}</strong></div>` : ''}
          ${a.price ? `<div class="alert-detail">Preço: <strong>$${Number(a.price).toFixed(3)}</strong></div>` : ''}
          ${a.usdc_size ? `<div class="alert-detail">Valor: <strong>$${Number(a.usdc_size).toFixed(2)}</strong></div>` : ''}
        </div>
      </div>
    </div>
  `;
}

async function renderWatcherPositions() {
  const container = document.getElementById('watcher-content');
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div>';

  try {
    const positions = await api('/api/watcher/positions');
    if (!positions.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <div class="empty-state-text">Nenhuma posição ativa</div>
          <div class="empty-state-sub">As posições aparecerão aqui após a primeira verificação</div>
        </div>
      `;
      return;
    }

    // Group by wallet
    const byWallet = {};
    for (const p of positions) {
      if (!byWallet[p.wallet_label]) byWallet[p.wallet_label] = [];
      byWallet[p.wallet_label].push(p);
    }

    let html = '';
    for (const [label, poss] of Object.entries(byWallet)) {
      const totalVal = poss.reduce((s, p) => s + (p.current_value || 0), 0);
      html += `
        <div style="margin-bottom:24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="font-size:15px;font-weight:700">${escapeHtml(label)}</h3>
            <span style="font-size:13px;color:var(--text-muted)">${poss.length} posições &middot; Total: <strong style="color:var(--text)">$${totalVal.toFixed(2)}</strong></span>
          </div>
          <div class="positions-grid">
            ${poss.map(p => `
              <div class="pos-card">
                <div class="pos-card-header">
                  <span class="pos-card-member">${escapeHtml(label)}</span>
                  ${p.outcome ? `<span class="pos-card-outcome">${escapeHtml(p.outcome)}</span>` : ''}
                </div>
                <div class="pos-card-title">${escapeHtml(p.title || 'Mercado')}</div>
                <div class="pos-card-stats">
                  <div>
                    <div class="pos-stat-label">Shares</div>
                    <div class="pos-stat-value">${Number(p.size).toFixed(2)}</div>
                  </div>
                  <div>
                    <div class="pos-stat-label">Preço Méd.</div>
                    <div class="pos-stat-value">$${Number(p.avg_price).toFixed(3)}</div>
                  </div>
                  <div>
                    <div class="pos-stat-label">Valor Atual</div>
                    <div class="pos-stat-value">$${Number(p.current_value).toFixed(2)}</div>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px">${err.message}</div>`;
  }
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

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
  document.getElementById('user-name').textContent = currentUser.display_name;
  document.getElementById('user-avatar').textContent = currentUser.display_name.charAt(0).toUpperCase();
  await loadAccounts();
  navigate('dashboard');
  // Start background watcher polling
  startBgPolling();
  // Load initial unseen count
  try {
    const d = await api('/api/watcher/alerts?unseen=1&limit=1');
    unseenAlertCount = d.total || 0;
    updateBadge();
  } catch (_) {}
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

  // Clean up watcher polling when leaving watcher page
  if (watcherPollTimer) {
    clearInterval(watcherPollTimer);
    watcherPollTimer = null;
  }

  const pages = {
    'dashboard': renderDashboard,
    'new-operation': renderNewOperation,
    'history': renderHistory,
    'calculator': renderCalculator,
    'freebets': renderFreebets,
    'group': renderGroup,
    'settings': renderSettings,
    'watcher': renderWatcher,
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
async function renderDashboard() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-description">Resumo das suas operações</p>
      </div>
      <button class="btn btn-primary" onclick="navigate('new-operation')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Nova Operação
      </button>
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
    renderStats(data);
    renderVolumeTracker(data);
    renderProfitChart(data.dailyProfits);
    renderTypeChart(data.profitByType);
    renderRecentTable(data.recentOps);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderStats(data) {
  document.getElementById('stats-grid').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Lucro Hoje</div>
      <div class="stat-value ${profitClass(data.today.profit)}">${formatBRL(data.today.profit)}</div>
      <div class="stat-sub">${data.today.count} operação(ões)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro na Semana</div>
      <div class="stat-value ${profitClass(data.week.profit)}">${formatBRL(data.week.profit)}</div>
      <div class="stat-sub">${data.week.count} operação(ões)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro no Mês</div>
      <div class="stat-value ${profitClass(data.month.profit)}">${formatBRL(data.month.profit)}</div>
      <div class="stat-sub">${data.month.count} operação(ões)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro Total</div>
      <div class="stat-value ${profitClass(data.allTime.profit)}">${formatBRL(data.allTime.profit)}</div>
      <div class="stat-sub">${data.allTime.count} operação(ões)</div>
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
        <th>Data</th><th>Jogo</th><th>Tipo</th><th>Stake B365</th><th>Stake Poly</th><th>Lucro</th><th>Contas</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${ops.map(op => `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
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
      <div class="accounts-checklist" id="new-accounts-list">
        ${activeAccounts.map(acc => `
          <label class="account-check" onclick="this.classList.toggle('checked')">
            <input type="checkbox" name="accounts" value="${acc.id}">
            <div class="account-check-dot"></div>
            <div>
              <div>${escapeHtml(acc.name)}</div>
              <div class="account-check-info">Max aumentada: ${formatBRL(acc.max_stake_aumentada)}</div>
            </div>
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
    const checked = document.querySelectorAll('#new-accounts-list input:checked');
    const total = parseFloat(stakeBet365Input?.value) || 0;
    const info = document.getElementById('stake-per-account-info');
    if (!info) return;
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

  const checkedBoxes = document.querySelectorAll('#new-accounts-list input:checked');
  const account_ids = Array.from(checkedBoxes).map(cb => Number(cb.value));

  const body = {
    type,
    game: document.getElementById('new-game').value.trim(),
    event_date: document.getElementById('new-event-date').value,
    stake_bet365: parseFloat(document.getElementById('new-stake-bet365').value) || 0,
    odd_bet365: parseFloat(document.getElementById('new-odd-bet365').value) || 0,
    stake_poly_usd: parseFloat(document.getElementById('new-stake-poly-usd').value) || 0,
    odd_poly: parseFloat(document.getElementById('new-odd-poly').value) || 0,
    exchange_rate: parseFloat(document.getElementById('new-exchange-rate').value) || 5.0,
    result: document.getElementById('new-result').value,
    profit: parseFloat(document.getElementById('new-profit').value) || 0,
    notes: document.getElementById('new-notes').value.trim(),
    account_ids,
  };

  try {
    await api('/api/operations', { method: 'POST', body });
    toast('Operação registrada com sucesso!');
    navigate('dashboard');
  } catch (err) {
    toast(err.message, 'error');
  }
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
    <div class="filters-bar">
      <select class="form-select" id="filter-type" onchange="loadHistory()">
        <option value="">Todos os tipos</option>
        <option value="aquecimento">Aquecimento</option>
        <option value="arbitragem">Arbitragem</option>
        <option value="aumentada25">Aumentada 25%</option>
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
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: historyPage * PAGE_SIZE });
  if (type) params.append('type', type);
  if (from) params.append('from', from);
  if (to) params.append('to', to);

  try {
    const { operations, total } = await api(`/api/operations?${params}`);
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
        <th>Data</th><th>Jogo</th><th>Tipo</th><th>Stake B365</th><th>Stake Poly</th><th>Câmbio</th><th>Contas</th><th>Lucro</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${ops.map(op => `<tr>
          <td>${formatDate(op.created_at)}</td>
          <td>${escapeHtml(op.game)}</td>
          <td><span class="badge badge-${op.type}">${typeLabel(op.type)}</span></td>
          <td>${formatBRL(op.stake_bet365)}</td>
          <td>${formatUSD(op.stake_poly_usd)} <span class="currency-tag">USD</span></td>
          <td style="font-size:12px">${op.exchange_rate?.toFixed(4) || '-'}</td>
          <td style="font-size:12px">${(op.accounts || []).map(a => escapeHtml(a.name)).join(', ') || '-'}</td>
          <td class="${profitClass(op.profit)}">${formatBRL(op.profit)}</td>
          <td><span class="badge badge-${op.result === 'pending' ? 'pending' : 'won'}">${resultLabel(op.result)}</span></td>
          <td>
            <div class="action-btns">
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
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  historyPage = 0;
  loadHistory();
}

// ===== EDIT MODAL =====
async function openEditModal(id) {
  try {
    await loadAccounts();
    const { operations } = await api(`/api/operations?limit=999`);
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

  // Build accounts checklist
  const opAccountIds = (op.accounts || []).map(a => a.id);
  const container = document.getElementById('edit-accounts-list');
  const activeAccounts = userAccounts.filter(a => a.active);
  container.innerHTML = activeAccounts.map(acc => {
    const checked = opAccountIds.includes(acc.id);
    return `
      <label class="account-check ${checked ? 'checked' : ''}" onclick="this.classList.toggle('checked')">
        <input type="checkbox" name="edit-accounts" value="${acc.id}" ${checked ? 'checked' : ''}>
        <div class="account-check-dot"></div>
        <div>${escapeHtml(acc.name)}</div>
      </label>
    `;
  }).join('') || '<span style="color:var(--text-muted);font-size:13px">Nenhuma conta cadastrada</span>';

  // Wire up auto-profit for edit modal
  wireEditAutoProfit(op.result);
}

function wireEditAutoProfit(originalResult) {
  const resultSelect = document.getElementById('edit-result');
  const stakeBet365 = document.getElementById('edit-stake-bet365');
  const oddBet365 = document.getElementById('edit-odd-bet365');
  const stakePolyUsd = document.getElementById('edit-stake-poly-usd');
  const oddPoly = document.getElementById('edit-odd-poly');
  const exchangeRate = document.getElementById('edit-exchange-rate');
  const profitInput = document.getElementById('edit-profit');
  const autoProfitInfo = document.getElementById('edit-auto-profit-info');

  function updateEditAutoProfit() {
    const result = resultSelect?.value;
    if (result === 'pending') {
      if (autoProfitInfo) autoProfitInfo.style.display = 'none';
      return;
    }
    const p = computeProfit(
      stakeBet365?.value, oddBet365?.value,
      stakePolyUsd?.value, oddPoly?.value,
      exchangeRate?.value, result
    );
    if (p !== null && autoProfitInfo) {
      profitInput.value = p.toFixed(2);
      const label = result === 'void' ? 'Anulado - lucro zerado' :
        `Lucro calculado: ${formatBRL(p)} (${result === 'bet365_won' ? 'Bet365 ganhou' : 'Poly ganhou'})`;
      autoProfitInfo.textContent = label;
      autoProfitInfo.style.display = 'block';
      autoProfitInfo.style.color = p >= 0 ? 'var(--success)' : 'var(--danger)';
    }
  }

  // Only auto-calc on result CHANGE (not on initial load)
  const handler = () => {
    if (resultSelect?.value !== originalResult) {
      updateEditAutoProfit();
    }
  };
  resultSelect?.addEventListener('change', handler);

  // Also recalc if stakes/odds change while result is not pending
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
  const checkedBoxes = document.querySelectorAll('#edit-accounts-list input:checked');
  const account_ids = Array.from(checkedBoxes).map(cb => Number(cb.value));

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
    account_ids,
  };

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
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Configurações</h1>
        <p class="page-description">Gerencie suas contas Bet365</p>
      </div>
    </div>

    <div class="chart-container">
      <h3 class="chart-title" style="margin-bottom:4px">Contas Bet365</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px">
        Cada conta tem seu próprio volume semanal de R$ 1.500 para a freebet e um stake máximo para aumentadas.
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
            <label class="form-label">Stake Máximo Aumentada (R$)</label>
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
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteAccount(${acc.id})">
          ${acc.active ? 'Remover' : 'Reativar'}
        </button>
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

async function deleteAccount(id) {
  const acc = userAccounts.find(a => a.id === id);
  if (!acc) return;

  if (!acc.active) {
    // Reactivate
    try {
      await api(`/api/accounts/${id}`, { method: 'PUT', body: { active: true } });
      toast('Conta reativada!');
      await loadAccounts();
      renderAccountsList();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  if (!confirm(`Remover a conta "${acc.name}"? Se já tiver operações vinculadas, será desativada.`)) return;
  try {
    await api(`/api/accounts/${id}`, { method: 'DELETE' });
    toast('Conta removida!');
    await loadAccounts();
    renderAccountsList();
  } catch (err) { toast(err.message, 'error'); }
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

// -- Calculator state --
let calcNumOut = 2;
let calcShowComm = true;
let calcRoundValue = 0;
let calcRoundUseFx = false;
let calcNextId = 3;
let calcRows = [];
let calcUsdcBrl = null;
let calcLastUpdated = null;
let calcResult = null;
let calcDarkMode = true;
let calcRateInterval = null;

function makeCalcRow(id) {
  return { id, odds: "", comm: "0", usePoly: false, cat: "Sports", currency: "USD", isFixed: false, fixedStake: "" };
}

// -- Math --
function calcEffOdds(raw, commPct, usePoly, catKey) {
  if (!raw || raw <= 1) return null;
  let ac = commPct > 0 ? raw * (1 - commPct / 100) + commPct / 100 : raw;
  if (!usePoly) return ac;
  const { feeRate, exponent } = POLY_CATS[catKey];
  if (!feeRate) return ac;
  const p = 1 / ac;
  return 1 / (p * (1 + feeRate * Math.pow(p * (1 - p), exponent)));
}

function calcTakerFeePct(raw, commPct, catKey) {
  if (raw <= 1) return 0;
  let ac = commPct > 0 ? raw * (1 - commPct / 100) + commPct / 100 : raw;
  const { feeRate, exponent } = POLY_CATS[catKey];
  if (!feeRate) return 0;
  const p = 1 / ac;
  return feeRate * Math.pow(p * (1 - p), exponent) * 100;
}

function cf2(n) { return (typeof n === "number" && isFinite(n)) ? n.toFixed(2) : "\u2014"; }
function cCurrSym(c) { return c === "USD" ? "$" : "R$"; }
function cToDisplay(usdAmt, currency) {
  if (currency === "USD") return usdAmt;
  return calcUsdcBrl ? usdAmt * calcUsdcBrl : null;
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
  if (body) body.innerHTML = `<div style="color:var(--red);font-family:var(--mono);font-size:11px">Falha ao buscar cotação</div>`;
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

// -- Outcome buttons --
function calcSetOutcomes(n) {
  calcNumOut = n;
  while (calcRows.length < calcNumOut) calcRows.push(makeCalcRow(calcNextId++));
  calcRows = calcRows.slice(0, calcNumOut);
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle('on', parseInt(b.textContent) === n));
  calcCompute(); calcBuildTable();
}

function calcToggleShowComm() {
  calcShowComm = !calcShowComm;
  const btn = document.getElementById('calc-show-comm-btn');
  if (btn) { btn.textContent = calcShowComm ? "Hide commissions" : "Show commissions"; btn.classList.toggle('on', calcShowComm); }
  calcBuildTable();
}

function calcSetRound(val) {
  calcRoundValue = val;
  ["calc-round-off","calc-round-1","calc-round-5","calc-round-10"].forEach(id => {
    const el = document.getElementById(id); if (el) el.classList.remove("on");
  });
  const btnId = val === 0 ? "calc-round-off" : `calc-round-${val}`;
  const el = document.getElementById(btnId); if (el) el.classList.add("on");
  calcCompute(); calcUpdateDisplay();
}

function calcToggleRoundFx() {
  calcRoundUseFx = !calcRoundUseFx;
  const btn = document.getElementById('calc-round-fx-btn');
  if (btn) { btn.textContent = calcRoundUseFx ? "FX rounding: ON" : "FX rounding: OFF"; btn.classList.toggle("on", calcRoundUseFx); }
  calcCompute(); calcUpdateDisplay();
}

// -- Core calculation --
function calcCompute() {
  const effArr = calcRows.map(r => calcEffOdds(parseFloat(r.odds), parseFloat(r.comm)||0, r.usePoly, r.cat));
  if (!effArr.every(o => o !== null && o > 1)) { calcResult = null; return; }

  const invSum = effArr.reduce((s, o) => s + 1/o, 0);
  const margin = invSum;
  const fixIdx = calcRows.findIndex(r => r.isFixed);
  let target = fixIdx >= 0
    ? (parseFloat(calcRows[fixIdx].fixedStake)||0) * effArr[fixIdx] / (calcRows[fixIdx].currency==="BRL" && calcUsdcBrl ? calcUsdcBrl : 1)
    : 100 / invSum;

  let stakesUSD = effArr.map(o => target / o);

  if (calcRoundValue > 0) {
    stakesUSD = stakesUSD.map((s, i) => {
      const row = calcRows[i];
      if (calcRoundUseFx && row.currency === "BRL" && calcUsdcBrl) {
        return Math.ceil(s * calcUsdcBrl / calcRoundValue) * calcRoundValue / calcUsdcBrl;
      }
      return Math.ceil(s / calcRoundValue) * calcRoundValue;
    });
  }

  const totalUSD    = stakesUSD.reduce((a,b)=>a+b,0);
  const returnsUSD  = stakesUSD.map((s,i)=>s*effArr[i]);
  const profitsUSD  = returnsUSD.map(r=>r-totalUSD);
  const minProfit   = Math.min(...profitsUSD);
  const roi         = totalUSD ? (minProfit / totalUSD) * 100 : 0;

  calcResult = { margin, isSurebet: margin < 1, effArr, stakesUSD, totalUSD, returnsUSD, profitsUSD, minProfit, roi };
}

// -- Build table --
function calcBuildTable() {
  let h = `<tr>
    <th style="width:28px" class="c-ctr-col">#</th>
    <th>Odds</th>
    <th class="c-num-col">Prob %</th>`;
  if (calcShowComm) h += `<th>Commission %</th><th class="c-num-col">Adj. Odds</th>`;
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

  const catOpts = CAT_KEYS.map(k => `<option value="${k}">${k}</option>`).join("");

  document.getElementById("calc-tbody").innerHTML = calcRows.map((row, idx) => {
    const cur = row.currency;
    const catSelect = CAT_KEYS.map(k => `<option value="${k}"${row.cat===k?" selected":""}>${k}</option>`).join("");

    let commCols = "";
    if (calcShowComm) commCols = `
      <td><input type="number" min="0" max="100" step="0.01" value="${row.comm}" style="width:70px;text-align:center" oninput="calcOnCommInput(${row.id},this.value)"></td>
      <td class="c-num-col" id="calc-ao-${row.id}">\u2014</td>`;

    return `
    <tr>
      <td class="c-ctr-col" style="font:600 11px/1 var(--mono);color:var(--text3)">${idx+1}</td>
      <td><input type="number" min="1.001" step="0.01" value="${row.odds}" style="width:88px;text-align:center" oninput="calcOnOddsInput(${row.id},this.value)"></td>
      <td class="c-num-col" id="calc-prob-${row.id}" style="font-size:12px">\u2014</td>
      ${commCols}
      <td class="c-poly-td c-ctr-col"><input type="checkbox" ${row.usePoly?"checked":""} onchange="calcOnPolyChange(${row.id},this.checked)"></td>
      <td class="c-poly-td"><select id="calc-catsel-${row.id}" ${row.usePoly?"":"disabled"} onchange="calcOnCatChange(${row.id},this.value)">${catSelect}</select></td>
      <td id="calc-fee-${row.id}" class="c-poly-td c-num-col"><span style="color:var(--text3)">\u2014</span></td>
      <td class="c-ctr-col">
        <button class="c-cur-btn" id="calc-curbtn-${row.id}" onclick="calcToggleCur(${row.id})">${cur==="USD"?"$ USD":"R$ BRL"}</button>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:4px">
          <span id="calc-cursym-${row.id}" style="font:400 11px/1 var(--mono);color:var(--text3)">${cCurrSym(cur)}</span>
          <input type="number" id="calc-stake-${row.id}" class="${row.isFixed?"c-stake-fixed":""}" style="width:92px;text-align:right" oninput="calcOnStakeInput(${row.id},this.value)" value="${row.isFixed?row.fixedStake:""}">
        </div>
      </td>
      <td class="c-ctr-col">
        <button class="c-fix-btn ${row.isFixed?"c-fix-on":""}" onclick="calcToggleFix(${row.id})" title="${row.isFixed?"Desfixar":"Fixar stake"}">${row.isFixed?"\uD83D\uDD12":"\uD83D\uDD13"}</button>
      </td>
      <td id="calc-profit-${row.id}" class="c-num-col">\u2014</td>
    </tr>`;
  }).join("");

  calcUpdateDisplay();
}

// -- Update display --
function calcUpdateDisplay() {
  if (!calcResult) {
    document.getElementById("calc-tfoot").innerHTML = "";
    document.getElementById("calc-cards").innerHTML = "";
    return;
  }

  calcRows.forEach((row, i) => {
    const raw = parseFloat(row.odds) || 0;

    const probEl = document.getElementById(`calc-prob-${row.id}`);
    if (probEl) probEl.textContent = raw > 1 ? (100 / raw).toFixed(1) + "%" : "\u2014";

    if (calcShowComm) {
      const ao = document.getElementById(`calc-ao-${row.id}`);
      if (ao) ao.textContent = raw > 1 ? (raw * (1 - (parseFloat(row.comm)||0)/100) + (parseFloat(row.comm)||0)/100).toFixed(4) : "\u2014";
    }

    const feeEl = document.getElementById(`calc-fee-${row.id}`);
    if (feeEl) {
      const fp = row.usePoly ? calcTakerFeePct(raw, parseFloat(row.comm)||0, row.cat) : 0;
      feeEl.innerHTML = fp > 0 ? `<span class="c-fee-badge">${fp.toFixed(3)}%</span>` : `<span style="color:var(--text3)">\u2014</span>`;
    }

    const stakeEl = document.getElementById(`calc-stake-${row.id}`);
    if (stakeEl && !row.isFixed && document.activeElement !== stakeEl) {
      const v = cToDisplay(calcResult.stakesUSD[i], row.currency);
      stakeEl.value = v !== null ? cf2(v) : "";
    }

    const profEl = document.getElementById(`calc-profit-${row.id}`);
    if (profEl) {
      const pUSD = calcResult.profitsUSD[i];
      const disp = cToDisplay(pUSD, row.currency);
      const sign = pUSD >= 0 ? "+" : "";
      const cls  = pUSD >= -0.005 ? "c-pos" : "c-neg";
      const main = disp !== null ? `${sign}${cCurrSym(row.currency)}${Math.abs(disp).toFixed(2)}` : `${sign}$${Math.abs(pUSD).toFixed(2)}`;
      const sub  = row.currency === "BRL" && calcUsdcBrl ? `<div class="c-dim">${sign}$${cf2(Math.abs(pUSD))}</div>` : "";
      profEl.innerHTML = `<span class="${cls}">${main}</span>${sub}`;
    }
  });

  // Footer
  const commCols = calcShowComm ? 2 : 0;
  const colsBeforeStake = 7 + commCols;
  document.getElementById("calc-tfoot").innerHTML = `
    <tr>
      <td colspan="${colsBeforeStake}" style="text-align:right;color:var(--text2);font:500 12px/1 var(--sans)">Total stake (USD):</td>
      <td><div style="display:flex;align-items:center;gap:4px"><span style="color:var(--text3);font-family:var(--mono);font-size:11px">$</span><input readonly value="${cf2(calcResult.totalUSD)}" style="width:92px;text-align:right;font-weight:700"></div></td>
      <td></td>
      <td class="c-num-col"><span class="c-pos">+$${cf2(calcResult.minProfit)}</span>${calcUsdcBrl?`<div class="c-dim">+R$${(calcResult.minProfit*calcUsdcBrl).toFixed(2)}</div>`:""}</td>
    </tr>`;

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

  const warn = document.getElementById("calc-brl-warn");
  if (warn) warn.style.display = (calcRows.some(r=>r.currency==="BRL") && !calcUsdcBrl) ? "" : "none";
}

// -- Input handlers --
function calcOnOddsInput(id, val) { calcRows.find(r=>r.id===id).odds = val; calcCompute(); calcUpdateDisplay(); }
function calcOnCommInput(id, val) { calcRows.find(r=>r.id===id).comm = val; calcCompute(); calcUpdateDisplay(); }
function calcOnPolyChange(id, checked) {
  calcRows.find(r=>r.id===id).usePoly = checked;
  const sel = document.getElementById(`calc-catsel-${id}`);
  if (sel) sel.disabled = !checked;
  calcCompute(); calcUpdateDisplay();
}
function calcOnCatChange(id, val) { calcRows.find(r=>r.id===id).cat = val; calcCompute(); calcUpdateDisplay(); }
function calcOnStakeInput(id, val) {
  calcRows.forEach(r => { if (r.id !== id) { r.isFixed = false; r.fixedStake = ""; } });
  const row = calcRows.find(r=>r.id===id);
  row.isFixed = true;
  row.fixedStake = val;
  calcCompute(); calcUpdateDisplay();
}
function calcToggleCur(id) {
  const row = calcRows.find(r=>r.id===id);
  const oldCur = row.currency;
  row.currency = oldCur === "USD" ? "BRL" : "USD";
  if (row.isFixed && row.fixedStake && calcUsdcBrl) {
    const usd = oldCur === "USD" ? parseFloat(row.fixedStake) : parseFloat(row.fixedStake) / calcUsdcBrl;
    row.fixedStake = cf2(row.currency === "USD" ? usd : usd * calcUsdcBrl);
  }
  calcCompute(); calcBuildTable();
}
function calcToggleFix(id) {
  const row = calcRows.find(r=>r.id===id);
  if (row.isFixed) {
    row.isFixed = false; row.fixedStake = "";
  } else {
    calcRows.forEach(r => { r.isFixed = false; r.fixedStake = ""; });
    row.isFixed = true;
    const idx = calcRows.indexOf(row);
    const usd = calcResult ? calcResult.stakesUSD[idx] : 0;
    row.fixedStake = cf2(cToDisplay(usd, row.currency) ?? usd);
  }
  calcCompute(); calcBuildTable();
}

// -- Utilities --
function calcCopyStakes() {
  if (!calcResult) return alert("Nada para copiar");
  let txt = "Surebet Stakes\n\n";
  calcRows.forEach((r,i) => {
    const usd = calcResult.stakesUSD[i];
    txt += `Outcome ${i+1}: $${cf2(usd)} USD`;
    if (r.currency === "BRL" && calcUsdcBrl) txt += `  /  R$${cf2(usd*calcUsdcBrl)} BRL`;
    txt += "\n";
  });
  txt += `\nTotal USD: $${cf2(calcResult.totalUSD)}\nMin Profit: +$${cf2(calcResult.minProfit)}`;
  navigator.clipboard.writeText(txt).then(() => {
    const btn = document.getElementById("calc-copy-btn");
    if (btn) { const orig = btn.textContent; btn.textContent = "\u2713 Copiado!"; setTimeout(() => btn.textContent = orig, 1800); }
  });
}

function calcLoadExample() {
  calcNumOut = 3;
  calcRows = [
    {id:1, odds:"2.12", comm:"0", usePoly:false, cat:"Sports", currency:"USD", isFixed:false, fixedStake:""},
    {id:2, odds:"3.55", comm:"0", usePoly:false, cat:"Sports", currency:"USD", isFixed:false, fixedStake:""},
    {id:3, odds:"4.10", comm:"0", usePoly:false, cat:"Sports", currency:"USD", isFixed:false, fixedStake:""}
  ];
  calcNextId = 4;
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle("on", b.textContent == "3"));
  calcCompute(); calcBuildTable();
}

function calcResetAll() {
  calcNumOut = 2;
  calcRows = [makeCalcRow(1), makeCalcRow(2)];
  calcNextId = 3;
  calcRoundValue = 0;
  calcRoundUseFx = false;
  document.querySelectorAll('#calc-outcome-btns .c-btn').forEach(b => b.classList.toggle("on", b.textContent == "2"));
  document.getElementById("calc-round-off")?.classList.add("on");
  ["calc-round-1","calc-round-5","calc-round-10"].forEach(id => document.getElementById(id)?.classList.remove("on"));
  const fxBtn = document.getElementById("calc-round-fx-btn");
  if (fxBtn) { fxBtn.textContent = "FX rounding: OFF"; fxBtn.classList.remove("on"); }
  calcShowComm = true;
  const commBtn = document.getElementById("calc-show-comm-btn");
  if (commBtn) { commBtn.textContent = "Hide commissions"; commBtn.classList.add("on"); }
  calcCompute(); calcBuildTable();
}

// -- Render --
function renderCalculator() {
  // Reset state
  calcRows = [makeCalcRow(1), makeCalcRow(2)];
  calcNextId = 3;
  calcNumOut = 2;
  calcShowComm = true;
  calcRoundValue = 0;
  calcRoundUseFx = false;
  calcResult = null;

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
        <button class="c-theme-btn" id="calc-theme-btn" onclick="calcToggleTheme()">${calcDarkMode ? "\u2728 Light" : "\uD83C\uDF19 Dark"}</button>
        <div class="c-ticker">
          <div class="c-ticker-top">
            <span><span class="c-dot c-dot-load" id="calc-status-dot"></span>USDC / BRL</span>
            <button class="c-refresh-btn" onclick="calcFetchRate()" title="Atualizar">\u21BA</button>
          </div>
          <div id="calc-ticker-body"><div class="c-ticker-load">Buscando cotação\u2026</div></div>
          <div class="c-ticker-note">\u21BB atualiza a cada 5s</div>
        </div>
      </div>
    </div>

    <div class="c-controls">
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Outcomes</span>
        <div id="calc-outcome-btns" style="display:flex;gap:5px">
          ${[2,3,4,5,6].map(n => `<button class="c-btn ${n===2?'on':''}" onclick="calcSetOutcomes(${n})">${n}</button>`).join('')}
        </div>
      </div>
      <div class="c-ctrl-sep"></div>
      <button class="c-btn on" id="calc-show-comm-btn" onclick="calcToggleShowComm()">Hide commissions</button>
      <div class="c-ctrl-sep"></div>
      <div class="c-ctrl-group">
        <span class="c-ctrl-label">Round stakes</span>
        <button class="c-btn on" id="calc-round-off" onclick="calcSetRound(0)">Off</button>
        <button class="c-btn" id="calc-round-1" onclick="calcSetRound(1)">$1</button>
        <button class="c-btn" id="calc-round-5" onclick="calcSetRound(5)">$5</button>
        <button class="c-btn" id="calc-round-10" onclick="calcSetRound(10)">$10</button>
      </div>
      <div class="c-ctrl-sep"></div>
      <button class="c-btn" id="calc-round-fx-btn" onclick="calcToggleRoundFx()">FX rounding: OFF</button>
      <div id="calc-brl-warn" style="display:none" class="c-warn-bar">\u26A0 Linhas em BRL precisam da cotação ao vivo</div>
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
      <button class="c-btn c-primary" onclick="calcCopyStakes()" id="calc-copy-btn">\uD83D\uDCCB Copiar stakes</button>
      <button class="c-btn" onclick="calcLoadExample()">Exemplo sports 3-way</button>
      <button class="c-btn" onclick="calcResetAll()">Resetar tudo</button>
    </div>

    <div class="c-legend">
      <strong>Polymarket taker fee (a partir de 30/03/2026):</strong><br>
      <code>eff_rate = feeRate \u00D7 (p \u00D7 (1\u2212p))^exponent</code> onde p = 1/odds.<br>
      Rounding usa Math.ceil (para cima). FX rounding converte \u2192 arredonda em BRL \u2192 converte de volta.
    </div>

  </div>`;

  // Start rate fetching
  calcFetchRate();
  calcRateInterval = setInterval(calcFetchRate, 5000);

  // Build initial table
  calcCompute();
  calcBuildTable();
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

// ===== GROUP =====
async function renderGroup() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Grupo</h1>
        <p class="page-description">Resultados de todos os membros</p>
      </div>
    </div>
    <div id="group-total" class="stat-card" style="margin-bottom:20px"></div>
    <div class="group-card" id="group-table"></div>
  `;
  try {
    const data = await api('/api/dashboard/group');
    document.getElementById('group-total').innerHTML = `
      <div class="stat-label">Lucro Total do Grupo</div>
      <div class="stat-value ${profitClass(data.groupTotal)}">${formatBRL(data.groupTotal)}</div>
      <div class="stat-sub">${data.members.length} membro(s)</div>
    `;
    if (!data.members.length) {
      document.getElementById('group-table').innerHTML = `<div class="empty-state"><div class="empty-state-text">Nenhum membro encontrado</div></div>`;
      return;
    }
    document.getElementById('group-table').innerHTML = `
      <table>
        <thead><tr><th>Membro</th><th>Hoje</th><th>Semana</th><th>Mês</th><th>Total</th><th>Operações</th></tr></thead>
        <tbody>
          ${data.members.map(m => `<tr>
            <td><strong>${escapeHtml(m.display_name)}</strong></td>
            <td class="${profitClass(m.today_profit)}">${formatBRL(m.today_profit)}</td>
            <td class="${profitClass(m.week_profit)}">${formatBRL(m.week_profit)}</td>
            <td class="${profitClass(m.month_profit)}">${formatBRL(m.month_profit)}</td>
            <td class="${profitClass(m.total_profit)}"><strong>${formatBRL(m.total_profit)}</strong></td>
            <td>${m.total_ops}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  } catch (err) { toast(err.message, 'error'); }
}

// ===== WATCHER =====
let watcherPollTimer = null;
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
  if (watcherPaused || !currentUser) return;
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
}

function startBgPolling() {
  if (bgWatcherTimer) clearInterval(bgWatcherTimer);
  bgWatcherTimer = setInterval(bgPoll, 30000);
  // Initial poll
  bgPoll();
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

  // Start more frequent polling while on watcher page
  watcherPollTimer = setInterval(() => {
    if (!watcherPaused) bgPoll();
  }, 15000);
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
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">Carregando...</div>';

  try {
    const data = await api('/api/watcher/alerts?limit=50');
    // Mark as seen
    if (data.alerts.length > 0) {
      const unseenIds = data.alerts.filter(a => !a.seen).map(a => a.id);
      if (unseenIds.length > 0) {
        await api('/api/watcher/alerts/seen', { method: 'POST', body: { ids: unseenIds } });
        unseenAlertCount = Math.max(0, unseenAlertCount - unseenIds.length);
        updateBadge();
      }
    }

    if (!data.alerts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👁️</div>
          <div class="empty-state-text">Nenhum alerta ainda</div>
          <div class="empty-state-sub">Adicione wallets na aba "Wallets" e os alertas aparecerão aqui quando houver atividade</div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-ghost btn-sm" onclick="clearAllAlerts()">Limpar tudo</button>
      </div>
      <div class="alert-feed">
        ${data.alerts.map(a => renderAlertCard(a)).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px">${err.message}</div>`;
  }
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
    await api('/api/watcher/alerts/seen', { method: 'POST', body: { ids: 'all' } });
    unseenAlertCount = 0;
    updateBadge();
    renderWatcherAlerts();
  } catch (err) { toast(err.message, 'error'); }
}

// ===== INIT =====
checkAuth();

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

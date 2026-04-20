// ===== FINANÇAS =====

let financesOperators = [];
let financesSummary = null;
let financesSettings = { default_payment_day: 5, notify_operator_payment: true, dash_include_operators: false };
let financesAvailableAccounts = [];
let financesPayments = [];
let financesROI = null;
let financesAccountPerf = null;
let financesTags = [];
let financesFilterOperator = '';
let financesFilterStatus = '';
let financesFilterTag = '';
let financesViewMonth = null; // YYYY-MM, null=current

function financesPaymentTypeLabel(t) {
  return { monthly: 'Mensal', weekly: 'Semanal', one_time: 'Único' }[t] || t;
}
function financesStatusLabel(s) {
  return { pending: 'Pendente', paid: 'Pago', skipped: 'Ignorado' }[s] || s;
}
function financesStatusBadge(s) {
  const colors = {
    pending: 'background:rgba(245,158,11,0.15);color:var(--warning)',
    paid: 'background:rgba(34,197,94,0.15);color:var(--success)',
    skipped: 'background:rgba(107,114,128,0.15);color:var(--text-muted)',
  };
  return `<span style="${colors[s] || ''};padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600">${financesStatusLabel(s)}</span>`;
}
function financesWeekdayLabel(d) {
  return ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][d] || '';
}

async function renderFinances() {
  const mc = document.getElementById('main-content');
  mc.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Finanças</h1>
        <p class="page-description">Gerencie operadores das contas Bet365 e seus pagamentos</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="openFinancesSettings()">Configurações</button>
        <button class="btn btn-ghost" onclick="exportFinancesCsv()">Exportar CSV</button>
        <button class="btn btn-primary" onclick="openOperatorModal(null)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Adicionar operador
        </button>
      </div>
    </div>

    <div class="stats-grid" id="finances-stats" style="margin-bottom:20px"></div>

    <div class="chart-container" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <h3 class="chart-title" style="margin:0">Operadores</h3>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select class="form-select" id="finances-filter-tag" style="padding:6px 10px;max-width:180px">
            <option value="">Todas as tags</option>
          </select>
          <div id="finances-month-picker" style="display:flex;gap:8px;align-items:center">
            <label style="font-size:13px;color:var(--text-muted)">Mês:</label>
            <input type="month" class="form-input" id="finances-month-input" style="padding:6px 10px;max-width:180px">
          </div>
        </div>
      </div>
      <div id="finances-operators-list">${skeletonRows(4, 6)}</div>
    </div>

    <div class="chart-container" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <h3 class="chart-title" style="margin:0">ROI por operador</h3>
        <span style="font-size:12px;color:var(--text-muted)">Lucro atribuído às contas do operador − custo no mês selecionado</span>
      </div>
      <div id="finances-roi-list">${skeletonRows(3, 5)}</div>
    </div>

    <div class="chart-container" style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <h3 class="chart-title" style="margin:0">Performance por conta</h3>
        <span style="font-size:12px;color:var(--text-muted)">Lucro/volume/ROI por conta Bet365 no mês (ignora pendentes)</span>
      </div>
      <div id="finances-account-perf">${skeletonRows(4, 5)}</div>
    </div>

    <div class="chart-container">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px">
        <h3 class="chart-title" style="margin:0">Histórico de Pagamentos</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select class="form-select" id="finances-filter-operator" style="max-width:200px"></select>
          <select class="form-select" id="finances-filter-status" style="max-width:160px">
            <option value="">Todos status</option>
            <option value="pending">Pendente</option>
            <option value="paid">Pago</option>
            <option value="skipped">Ignorado</option>
          </select>
        </div>
      </div>
      <div id="finances-payments-list">${skeletonRows(5, 6)}</div>
    </div>
  `;

  // Init month picker
  const today = new Date();
  const curMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  financesViewMonth = financesViewMonth || curMonth;
  const monthInp = document.getElementById('finances-month-input');
  if (monthInp) {
    monthInp.value = financesViewMonth;
    monthInp.addEventListener('change', async () => {
      financesViewMonth = monthInp.value || curMonth;
      await loadFinancesData();
      renderFinancesUI();
    });
  }
  document.getElementById('finances-filter-operator').addEventListener('change', (e) => {
    financesFilterOperator = e.target.value;
    renderFinancesPaymentsList();
  });
  document.getElementById('finances-filter-status').addEventListener('change', (e) => {
    financesFilterStatus = e.target.value;
    loadFinancesPayments().then(renderFinancesPaymentsList);
  });
  const tagFilter = document.getElementById('finances-filter-tag');
  if (tagFilter) {
    tagFilter.addEventListener('change', async (e) => {
      financesFilterTag = e.target.value;
      await loadFinancesOperators();
      renderFinancesOperatorsList();
      renderFinancesOperatorFilter();
    });
  }

  await loadFinancesData();
  renderFinancesUI();
}

async function loadFinancesData() {
  try {
    const tagParam = financesFilterTag ? `?tag=${encodeURIComponent(financesFilterTag)}` : '';
    const month = financesViewMonth || '';
    const monthStart = month ? `${month}-01` : '';
    let monthEnd = '';
    if (month) {
      const [yy, mm] = month.split('-').map(Number);
      const lastDay = new Date(yy, mm, 0).getDate();
      monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;
    }
    const perfQs = monthStart ? `?from=${monthStart}&to=${monthEnd}` : '';
    const [operators, summary, settings, tags, roi, accPerf] = await Promise.all([
      api('/api/finances/operators' + tagParam),
      api(`/api/finances/summary?month=${month}`),
      api('/api/finances/settings'),
      api('/api/finances/tags'),
      api(`/api/finances/roi?month=${month}`),
      api(`/api/accounts/performance${perfQs}`),
    ]);
    financesOperators = operators || [];
    financesSummary = summary || null;
    financesSettings = settings || financesSettings;
    financesTags = Array.isArray(tags) ? tags : [];
    financesROI = roi || null;
    financesAccountPerf = accPerf || null;
    await loadFinancesPayments();
  } catch (err) { toast(err.message, 'error'); }
}

async function loadFinancesOperators() {
  try {
    const tagParam = financesFilterTag ? `?tag=${encodeURIComponent(financesFilterTag)}` : '';
    financesOperators = await api('/api/finances/operators' + tagParam) || [];
  } catch (err) { toast(err.message, 'error'); }
}

async function loadFinancesPayments() {
  try {
    const params = new URLSearchParams();
    if (financesFilterStatus) params.set('status', financesFilterStatus);
    const qs = params.toString() ? '?' + params.toString() : '';
    financesPayments = await api('/api/finances/payments' + qs);
  } catch (err) { toast(err.message, 'error'); }
}

function renderFinancesUI() {
  renderFinancesStats();
  renderFinancesTagFilter();
  renderFinancesOperatorsList();
  renderFinancesOperatorFilter();
  renderFinancesROIList();
  renderFinancesAccountPerfList();
  renderFinancesPaymentsList();
}

function renderFinancesAccountPerfList() {
  const container = document.getElementById('finances-account-perf');
  if (!container) return;
  const accounts = (financesAccountPerf?.accounts || []).filter(a => a.op_count > 0);
  if (!accounts.length) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px">Sem operações liquidadas no período.</div>`;
    return;
  }
  container.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
            <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--border)">Conta</th>
            <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border)">Ops</th>
            <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border)">Volume</th>
            <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border)">Lucro</th>
            <th style="text-align:right;padding:8px 12px;border-bottom:1px solid var(--border)">ROI</th>
          </tr>
        </thead>
        <tbody>
          ${accounts.map(a => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid var(--border)">
                ${escapeHtml(a.account_name)}${a.hidden ? ' <span style="font-size:10px;color:var(--text-muted)">(oculta)</span>' : ''}
              </td>
              <td style="padding:8px 12px;text-align:right;border-bottom:1px solid var(--border);font-family:var(--mono)">${a.op_count}</td>
              <td style="padding:8px 12px;text-align:right;border-bottom:1px solid var(--border);font-family:var(--mono)">${formatBRL(a.volume)}</td>
              <td class="${profitClass(a.attributed_profit)}" style="padding:8px 12px;text-align:right;border-bottom:1px solid var(--border);font-family:var(--mono);font-weight:600">${formatBRL(a.attributed_profit)}</td>
              <td class="${profitClass(a.roi_pct)}" style="padding:8px 12px;text-align:right;border-bottom:1px solid var(--border);font-family:var(--mono)">${a.roi_pct.toFixed(2)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderFinancesTagFilter() {
  const el = document.getElementById('finances-filter-tag');
  if (!el) return;
  el.innerHTML = `<option value="">Todas as tags</option>` +
    financesTags.map(t => `<option value="${escapeHtml(t)}" ${t === financesFilterTag ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
}

function renderFinancesStats() {
  const el = document.getElementById('finances-stats');
  if (!el || !financesSummary) return;
  const s = financesSummary;
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Operadores</div>
      <div class="stat-value">${s.operators_active}</div>
      <div class="stat-sub">${s.operators_total - s.operators_active > 0 ? `${s.operators_total - s.operators_active} inativo(s)` : 'ativos'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Custo médio mensal</div>
      <div class="stat-value">${formatBRL(s.avg_monthly_cost)}</div>
      <div class="stat-sub">Estimativa (mensais + semanais × 4,33)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Pago em ${s.month}</div>
      <div class="stat-value">${formatBRL(s.paid_in_month)}</div>
      <div class="stat-sub">${s.pending_in_month > 0 ? `Pendente: ${formatBRL(s.pending_in_month)}` : 'Sem pendências no mês'}${s.tips_in_month > 0 ? ` · Gorjetas: ${formatBRL(s.tips_in_month)}` : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lucro líquido ${s.month}</div>
      <div class="stat-value ${profitClass(s.net_profit)}">${formatBRL(s.net_profit)}</div>
      <div class="stat-sub">Ops ${formatBRL(s.operations_profit)} + Giros ${formatBRL(s.giros_profit)} − Operadores ${formatBRL(s.paid_in_month)}</div>
    </div>
  `;
  const badge = document.getElementById('finances-badge');
  if (badge) {
    if (s.overdue_count > 0) {
      badge.textContent = s.overdue_count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

function renderFinancesOperatorsList() {
  const container = document.getElementById('finances-operators-list');
  if (!container) return;
  if (!financesOperators.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">&#128188;</div>
      <div class="empty-state-text">Nenhum operador cadastrado</div>
      <div class="empty-state-sub">Clique em "Adicionar operador" para começar</div>
    </div>`;
    return;
  }
  container.innerHTML = financesOperators.map(op => financesOperatorCardHtml(op)).join('');
}

function financesOperatorCardHtml(op) {
  const accounts = op.accounts || [];
  const accountsHtml = accounts.length
    ? accounts.map(a => `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--surface-hover,rgba(255,255,255,0.06));border:1px solid var(--border)">${escapeHtml(a.name)}${a.hidden ? ' (oculta)' : ''}</span>`).join(' ')
    : `<span style="color:var(--text-muted);font-size:12px">Nenhuma conta linkada</span>`;

  const payInfo = op.payment_type === 'weekly' && op.custom_payment_day != null
    ? ` · ${financesWeekdayLabel(op.custom_payment_day)}`
    : (op.payment_type === 'monthly' && op.custom_payment_day ? ` · dia ${op.custom_payment_day}` : '');

  const cp = op.current_payment;
  let paymentBlock = '';
  if (op.payment_type === 'one_time' && !cp) {
    paymentBlock = `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span style="font-size:13px;color:var(--text-muted)">Sem pagamento registrado</span>
        <button class="btn btn-primary btn-sm" onclick="openPaymentModal(${op.id}, null)">Registrar pagamento</button>
      </div>`;
  } else if (cp) {
    const total = Number(cp.amount || 0) + Number(cp.tip || 0);
    const isOverdue = cp.status === 'pending' && cp.due_date && cp.due_date < brtTodayStr();
    const dueLabel = cp.due_date ? `Venc. ${formatDate(cp.due_date)}` : (cp.period || '');
    const overdueTag = isOverdue ? ` <span style="color:var(--danger);font-weight:600;font-size:11px">⚠ ATRASADO</span>` : '';
    paymentBlock = `
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            ${financesStatusBadge(cp.status || 'pending')}
            <span style="color:var(--text-muted)">${dueLabel}</span>
            ${overdueTag}
          </div>
          <div style="font-size:14px;margin-top:4px">
            <b>${formatBRL(total)}</b>
            ${Number(cp.tip) > 0 ? `<span style="color:var(--text-muted);font-size:12px"> (base ${formatBRL(cp.amount)} + gorjeta ${formatBRL(cp.tip)})</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${cp.status !== 'paid'
            ? `<button class="btn btn-primary btn-sm" onclick="quickMarkPaid(${op.id}, '${cp.period}')">Marcar como pago</button>`
            : ''}
          <button class="btn btn-ghost btn-sm" onclick="openPaymentModal(${op.id}, '${cp.period}')">${cp.id ? 'Editar' : 'Registrar'}</button>
        </div>
      </div>`;
  }

  const tagsHtml = (op.tags && op.tags.length)
    ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
         ${op.tags.map(t => `<span class="tag-badge" style="cursor:pointer" onclick="applyFinancesTagFilter('${escapeHtml(t)}')">${escapeHtml(t)}</span>`).join('')}
       </div>`
    : '';

  return `
    <div class="giro-card" style="${op.active ? '' : 'opacity:0.6'}">
      <div class="giro-card-head">
        <div>
          <div class="giro-title">${escapeHtml(op.name)}${!op.active ? ' <span style="font-size:11px;color:var(--text-muted)">(inativo)</span>' : ''}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
            ${financesPaymentTypeLabel(op.payment_type)} · ${formatBRL(op.payment_value)}${payInfo}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="openOperatorHistory(${op.id})">Histórico</button>
          <button class="btn btn-ghost btn-sm" onclick="openOperatorAudit(${op.id})">Auditoria</button>
          <button class="btn btn-ghost btn-sm" onclick="openOperatorModal(${op.id})">Editar</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteOperator(${op.id})" style="color:var(--danger)">Excluir</button>
        </div>
      </div>
      ${tagsHtml}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <span style="font-size:12px;color:var(--text-muted)">Contas:</span>
        ${accountsHtml}
      </div>
      ${op.pix_key ? `<div style="margin-top:8px;font-size:12px"><span style="color:var(--text-muted)">PIX:</span> <code style="font-family:var(--font-mono);cursor:pointer" onclick='copyToClipboard(${JSON.stringify(op.pix_key)})' title="Clique para copiar">${escapeHtml(op.pix_key)}</code></div>` : ''}
      ${op.notes ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted);white-space:pre-wrap">${escapeHtml(op.notes)}</div>` : ''}
      ${paymentBlock}
    </div>
  `;
}

async function applyFinancesTagFilter(tag) {
  financesFilterTag = tag;
  const el = document.getElementById('finances-filter-tag');
  if (el) el.value = tag;
  await loadFinancesOperators();
  renderFinancesOperatorsList();
  renderFinancesOperatorFilter();
}

function brtTodayStr() {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return now.toISOString().split('T')[0];
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('Falha ao copiar', 'error'));
}

function renderFinancesOperatorFilter() {
  const el = document.getElementById('finances-filter-operator');
  if (!el) return;
  const current = el.value || financesFilterOperator;
  el.innerHTML = `<option value="">Todos operadores</option>` +
    financesOperators.map(o => `<option value="${o.id}" ${String(o.id) === String(current) ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
}

function renderFinancesPaymentsList() {
  const container = document.getElementById('finances-payments-list');
  if (!container) return;
  let rows = financesPayments.slice();
  if (financesFilterOperator) rows = rows.filter(r => String(r.operator_id) === String(financesFilterOperator));
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">Nenhum pagamento registrado</div></div>`;
    return;
  }
  container.innerHTML = `
    <div style="overflow-x:auto">
    <table class="table" style="width:100%">
      <thead>
        <tr>
          <th>Operador</th>
          <th>Tipo</th>
          <th>Período</th>
          <th>Vencimento</th>
          <th>Valor</th>
          <th>Gorjeta</th>
          <th>Total</th>
          <th>Status</th>
          <th>Pago em</th>
          <th>Comp.</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const total = Number(r.amount || 0) + Number(r.tip || 0);
          return `
            <tr>
              <td>${escapeHtml(r.operator_name)}</td>
              <td>${financesPaymentTypeLabel(r.payment_type)}</td>
              <td>${escapeHtml(r.period)}</td>
              <td>${r.due_date ? formatDate(r.due_date) : '-'}</td>
              <td>${formatBRL(r.amount)}</td>
              <td>${formatBRL(r.tip)}</td>
              <td><b>${formatBRL(total)}</b></td>
              <td>${financesStatusBadge(r.status)}</td>
              <td>${r.paid_at ? formatDate(r.paid_at) : '-'}</td>
              <td>${r.has_receipt ? `<button class="btn btn-ghost btn-sm" onclick="viewReceipt(${r.id})">Ver</button>` : '-'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="openPaymentModal(${r.operator_id}, '${r.period}')">Editar</button>
                <button class="btn btn-ghost btn-sm" onclick="deletePayment(${r.id})" style="color:var(--danger)">×</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderFinancesROIList() {
  const container = document.getElementById('finances-roi-list');
  if (!container) return;
  const roi = financesROI;
  if (!roi || !roi.operators || !roi.operators.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-text">Sem dados de ROI para o mês selecionado</div></div>`;
    return;
  }
  const totalProfit = roi.operators.reduce((a, b) => a + (Number(b.attributed_profit) || 0), 0);
  const totalCost = roi.operators.reduce((a, b) => a + (Number(b.paid) || 0) + (Number(b.pending) || 0), 0);
  const totalNet = totalProfit - totalCost;
  container.innerHTML = `
    <div style="overflow-x:auto">
    <table class="table" style="width:100%">
      <thead>
        <tr>
          <th>Operador</th>
          <th>Tipo</th>
          <th>Ops</th>
          <th>Lucro atribuído</th>
          <th>Pago</th>
          <th>Pendente</th>
          <th>Líquido</th>
          <th>ROI</th>
        </tr>
      </thead>
      <tbody>
        ${roi.operators.map(r => `
          <tr>
            <td>${escapeHtml(r.operator_name)}</td>
            <td>${financesPaymentTypeLabel(r.payment_type)}</td>
            <td>${r.op_count || 0}</td>
            <td class="${profitClass(r.attributed_profit)}">${formatBRL(r.attributed_profit)}</td>
            <td>${formatBRL(r.paid)}</td>
            <td>${Number(r.pending) > 0 ? `<span style="color:var(--warning)">${formatBRL(r.pending)}</span>` : formatBRL(r.pending)}</td>
            <td class="${profitClass(r.net)}"><b>${formatBRL(r.net)}</b></td>
            <td>${r.roi_pct == null ? '-' : `<span class="${profitClass(r.roi_pct)}">${r.roi_pct.toFixed(1)}%</span>`}</td>
          </tr>
        `).join('')}
        <tr style="border-top:2px solid var(--border);font-weight:600">
          <td colspan="3">Total (${roi.month})</td>
          <td class="${profitClass(totalProfit)}">${formatBRL(totalProfit)}</td>
          <td colspan="2">${formatBRL(totalCost)}</td>
          <td class="${profitClass(totalNet)}"><b>${formatBRL(totalNet)}</b></td>
          <td>${totalCost > 0 ? `<span class="${profitClass(totalNet)}">${(totalNet / totalCost * 100).toFixed(1)}%</span>` : '-'}</td>
        </tr>
      </tbody>
    </table>
    </div>
  `;
}

// ----- Operator audit log -----

async function openOperatorAudit(operatorId) {
  const op = financesOperators.find(o => o.id === operatorId);
  if (!op) { toast('Operador não encontrado', 'error'); return; }
  let rows = [];
  try { rows = await api(`/api/finances/operators/${operatorId}/audit`); }
  catch (err) { toast(err.message, 'error'); return; }

  const actionLabel = (entity, action) => {
    const labels = {
      'operator:created': 'Operador criado',
      'operator:updated': 'Operador editado',
      'operator:deleted': 'Operador excluído',
      'payment:created': 'Pagamento criado',
      'payment:updated': 'Pagamento editado',
      'payment:deleted': 'Pagamento excluído',
      'payment:auto_created': 'Pagamento gerado automaticamente',
    };
    return labels[`${entity}:${action}`] || `${entity} · ${action}`;
  };

  const formatDetails = (d) => {
    if (!d) return '';
    if (typeof d === 'string') return `<span style="color:var(--text-muted);font-size:12px">${escapeHtml(d)}</span>`;
    const parts = [];
    if (d.before && d.after) {
      for (const k of Object.keys(d.after)) {
        parts.push(`<div><code>${escapeHtml(k)}</code>: <s style="color:var(--text-muted)">${escapeHtml(String(d.before[k] ?? '—'))}</s> → <b>${escapeHtml(String(d.after[k] ?? '—'))}</b></div>`);
      }
    }
    if (d.accounts) {
      parts.push(`<div><code>contas</code>: ${(d.accounts.before || []).join(', ') || '—'} → <b>${(d.accounts.after || []).join(', ') || '—'}</b></div>`);
    }
    if (d.tags) {
      parts.push(`<div><code>tags</code>: ${(d.tags.before || []).join(', ') || '—'} → <b>${(d.tags.after || []).join(', ') || '—'}</b></div>`);
    }
    if (d.status_from && d.status_to) {
      parts.push(`<div>status: <b>${escapeHtml(d.status_from)}</b> → <b>${escapeHtml(d.status_to)}</b></div>`);
    }
    if (d.period) parts.push(`<div>período: <b>${escapeHtml(d.period)}</b>${d.due_date ? ` · venc. ${escapeHtml(d.due_date)}` : ''}${d.amount != null ? ` · ${formatBRL(d.amount)}` : ''}</div>`);
    if (d.receipt_uploaded) parts.push(`<div style="color:var(--success);font-size:12px">Comprovante anexado</div>`);
    if (d.receipt_cleared) parts.push(`<div style="color:var(--warning);font-size:12px">Comprovante removido</div>`);
    if (!parts.length) parts.push(`<code style="font-size:11px;color:var(--text-muted)">${escapeHtml(JSON.stringify(d))}</code>`);
    return parts.join('');
  };

  const body = rows.length
    ? rows.map(r => `
        <tr>
          <td style="white-space:nowrap;font-size:12px;color:var(--text-muted)">${formatDateTime(r.created_at)}</td>
          <td>${escapeHtml(actionLabel(r.entity, r.action))}</td>
          <td>${formatDetails(r.details)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-muted)">Sem registros de auditoria</td></tr>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'op-audit-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:780px">
      <div class="modal-header">
        <h3 class="modal-title">Auditoria — ${escapeHtml(op.name)}</h3>
        <button class="modal-close" onclick="closeOperatorAudit()">&times;</button>
      </div>
      <div style="overflow-x:auto;max-height:70vh">
      <table class="table" style="width:100%">
        <thead><tr><th style="width:160px">Quando</th><th style="width:180px">Ação</th><th>Detalhes</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px">Mostrando últimos 200 registros.</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeOperatorAudit() {
  const el = document.getElementById('op-audit-modal');
  if (el) el.remove();
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const s = String(iso).replace('T', ' ').replace('Z', '').slice(0, 19);
  return s;
}

// ----- Operator modal -----

async function openOperatorModal(operatorId) {
  const isEdit = !!operatorId;
  let op = null;
  if (isEdit) {
    op = financesOperators.find(o => o.id === operatorId);
    if (!op) { toast('Operador não encontrado', 'error'); return; }
  }
  try {
    const qs = isEdit ? `?for_operator=${operatorId}` : '';
    financesAvailableAccounts = await api('/api/finances/available-accounts' + qs);
  } catch (err) { toast(err.message, 'error'); return; }

  const linkedIds = isEdit ? new Set((op.accounts || []).map(a => a.id)) : new Set();
  const accountsHtml = financesAvailableAccounts.map(a => {
    const checked = linkedIds.has(a.id);
    const disabled = !a.assignable && !checked;
    const note = (a.linked_operator_id && a.linked_operator_id !== operatorId) ? ` (${a.linked_operator_name})` : '';
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;${disabled ? 'opacity:0.5' : ''}">
      <input type="checkbox" class="op-account-cb" value="${a.id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span>${escapeHtml(a.name)}${note ? `<span style="color:var(--text-muted);font-size:11px">${escapeHtml(note)}</span>` : ''}</span>
    </label>`;
  }).join('');

  const ptype = op?.payment_type || 'monthly';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'operator-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <h3 class="modal-title">${isEdit ? 'Editar operador' : 'Novo operador'}</h3>
        <button class="modal-close" onclick="closeOperatorModal()">&times;</button>
      </div>
      <form id="operator-form">
        <div class="form-group">
          <label class="form-label">Nome</label>
          <input type="text" class="form-input" id="op-name" value="${escapeHtml(op?.name || '')}" required maxlength="120">
        </div>
        <div class="form-group">
          <label class="form-label">Contas vinculadas</label>
          <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px 12px">
            ${accountsHtml || '<div style="color:var(--text-muted);font-size:13px;padding:6px 0">Nenhuma conta disponível. Cadastre contas nas Configurações.</div>'}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Contas já vinculadas a outro operador ficam desabilitadas.</div>
        </div>
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Tipo de pagamento</label>
            <select class="form-select" id="op-ptype" onchange="onOpPaymentTypeChange()">
              <option value="monthly" ${ptype === 'monthly' ? 'selected' : ''}>Mensal</option>
              <option value="weekly" ${ptype === 'weekly' ? 'selected' : ''}>Semanal</option>
              <option value="one_time" ${ptype === 'one_time' ? 'selected' : ''}>Único (one-time)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Valor (R$)</label>
            <input type="number" step="0.01" min="0" class="form-input" id="op-value" value="${op?.payment_value ?? ''}" placeholder="0,00">
          </div>
          <div class="form-group" id="op-customday-wrap">
            <label class="form-label" id="op-customday-label">Dia do pagamento (padrão: ${financesSettings.default_payment_day})</label>
            <input type="number" min="1" max="31" class="form-input" id="op-customday-num" value="${(ptype !== 'weekly' && op?.custom_payment_day != null) ? op.custom_payment_day : ''}" placeholder="Deixe em branco para padrão">
            <select class="form-select" id="op-customday-dow" style="display:none">
              ${[0,1,2,3,4,5,6].map(d => `<option value="${d}" ${op?.payment_type === 'weekly' && Number(op?.custom_payment_day) === d ? 'selected' : ''}>${financesWeekdayLabel(d)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Chave PIX (opcional)</label>
            <input type="text" class="form-input" id="op-pix" value="${escapeHtml(op?.pix_key || '')}" placeholder="CPF, email, telefone ou chave aleatória" maxlength="140">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Tags (opcional)</label>
          <div class="tags-input-wrap" id="op-tags-input"></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Ex.: família, time A, confiável. Pressione Enter para adicionar.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Notas</label>
          <textarea class="form-textarea" id="op-notes" rows="3" maxlength="2000" placeholder="Observações sobre o operador">${escapeHtml(op?.notes || '')}</textarea>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="op-active" ${op?.active ? 'checked' : ''}>
            <span>Ativo</span>
          </label>
        </div>` : ''}
        <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px">
          <button type="button" class="btn btn-ghost" onclick="closeOperatorModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  onOpPaymentTypeChange();
  // Swap global tag catalog for operator tags while this modal is open.
  const savedTags = allKnownTags;
  allKnownTags = financesTags;
  initTagInput('op-tags-input', op?.tags || []);
  overlay.addEventListener('remove', () => { allKnownTags = savedTags; });
  document.getElementById('operator-form').addEventListener('submit', (e) => submitOperator(e, operatorId, savedTags));
}

function onOpPaymentTypeChange() {
  const type = document.getElementById('op-ptype').value;
  const wrap = document.getElementById('op-customday-wrap');
  const label = document.getElementById('op-customday-label');
  const numInp = document.getElementById('op-customday-num');
  const dowSel = document.getElementById('op-customday-dow');
  if (type === 'one_time') {
    wrap.style.display = 'none';
  } else if (type === 'weekly') {
    wrap.style.display = '';
    label.textContent = 'Dia da semana';
    numInp.style.display = 'none';
    dowSel.style.display = '';
  } else {
    wrap.style.display = '';
    label.textContent = `Dia do mês (padrão: ${financesSettings.default_payment_day})`;
    numInp.style.display = '';
    dowSel.style.display = 'none';
  }
}

function closeOperatorModal() {
  const el = document.getElementById('operator-modal');
  if (el) el.remove();
}

async function submitOperator(e, operatorId, savedTagCatalog) {
  e.preventDefault();
  const name = document.getElementById('op-name').value.trim();
  const payment_type = document.getElementById('op-ptype').value;
  const payment_value = Number(document.getElementById('op-value').value) || 0;
  let custom_payment_day = null;
  if (payment_type === 'weekly') {
    custom_payment_day = Number(document.getElementById('op-customday-dow').value);
  } else if (payment_type === 'monthly') {
    const v = document.getElementById('op-customday-num').value;
    custom_payment_day = v === '' ? null : Number(v);
  }
  const pix_key = document.getElementById('op-pix').value.trim() || null;
  const notes = document.getElementById('op-notes').value.trim() || null;
  const account_ids = [...document.querySelectorAll('.op-account-cb:checked')].map(cb => Number(cb.value));
  const tags = getTagsFromInput('op-tags-input');
  const activeCb = document.getElementById('op-active');
  const active = activeCb ? (activeCb.checked ? 1 : 0) : 1;

  const body = { name, payment_type, payment_value, custom_payment_day, pix_key, notes, account_ids, tags };
  if (operatorId) body.active = active;

  try {
    if (operatorId) {
      await api('/api/finances/operators/' + operatorId, { method: 'PUT', body });
      toast('Operador atualizado');
    } else {
      await api('/api/finances/operators', { method: 'POST', body });
      toast('Operador adicionado');
    }
    if (savedTagCatalog !== undefined) allKnownTags = savedTagCatalog;
    closeOperatorModal();
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteOperator(id) {
  const op = financesOperators.find(o => o.id === id);
  if (!op) return;
  if (!confirm(`Excluir operador "${op.name}"? Todos os pagamentos vinculados serão removidos.`)) return;
  try {
    await api('/api/finances/operators/' + id, { method: 'DELETE' });
    toast('Operador excluído');
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

// ----- Payment modal -----

async function openPaymentModal(operatorId, period) {
  const op = financesOperators.find(o => o.id === operatorId);
  if (!op) { toast('Operador não encontrado', 'error'); return; }

  // Try to load existing payment for (op, period)
  let payment = null;
  if (period) {
    try {
      const all = await api(`/api/finances/payments?operator_id=${operatorId}`);
      payment = all.find(p => p.period === period) || null;
      if (payment && payment.id) {
        // full payment (with receipt)
        payment = await api('/api/finances/payments/' + payment.id);
      }
    } catch (err) { /* fall through */ }
  }

  // Derive default period + due_date if none provided (one_time path)
  let defaultPeriod = period;
  let defaultDue = payment?.due_date || '';
  if (!defaultPeriod) {
    if (op.payment_type === 'one_time') {
      defaultPeriod = brtTodayStr();
      defaultDue = brtTodayStr();
    } else if (op.current_payment) {
      defaultPeriod = op.current_payment.period;
      defaultDue = op.current_payment.due_date || '';
    }
  } else if (!defaultDue && op.current_payment && op.current_payment.period === period) {
    defaultDue = op.current_payment.due_date || '';
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'payment-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <h3 class="modal-title">${payment?.id ? 'Editar pagamento' : 'Registrar pagamento'} — ${escapeHtml(op.name)}</h3>
        <button class="modal-close" onclick="closePaymentModal()">&times;</button>
      </div>
      <form id="payment-form">
        <input type="hidden" id="pay-operator-id" value="${op.id}">
        <input type="hidden" id="pay-id" value="${payment?.id || ''}">
        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Período ${op.payment_type === 'monthly' ? '(YYYY-MM)' : '(YYYY-MM-DD)'}</label>
            <input type="text" class="form-input" id="pay-period" value="${defaultPeriod || ''}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Vencimento</label>
            <input type="date" class="form-input" id="pay-due" value="${defaultDue || ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Valor base (R$)</label>
            <input type="number" step="0.01" min="0" class="form-input" id="pay-amount" value="${payment?.amount ?? op.payment_value}">
          </div>
          <div class="form-group">
            <label class="form-label">Gorjeta (R$)</label>
            <input type="number" step="0.01" min="0" class="form-input" id="pay-tip" value="${payment?.tip ?? 0}">
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <select class="form-select" id="pay-status">
              <option value="pending" ${(payment?.status || 'pending') === 'pending' ? 'selected' : ''}>Pendente</option>
              <option value="paid" ${payment?.status === 'paid' ? 'selected' : ''}>Pago</option>
              <option value="skipped" ${payment?.status === 'skipped' ? 'selected' : ''}>Ignorado</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Data do pagamento</label>
            <input type="datetime-local" class="form-input" id="pay-paid-at" value="${payment?.paid_at ? payment.paid_at.replace(' ', 'T').slice(0, 16) : ''}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Comprovante (imagem ou PDF, máx. 5MB)</label>
          <input type="file" class="form-input" id="pay-receipt" accept="image/*,application/pdf">
          ${payment?.has_receipt ? `
            <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:13px">
              <span style="color:var(--success)">✓ Comprovante salvo${payment.receipt_name ? `: ${escapeHtml(payment.receipt_name)}` : ''}</span>
              <button type="button" class="btn btn-ghost btn-sm" onclick="viewReceiptData(${payment.id || 'null'})">Ver</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="clearReceiptField()" style="color:var(--danger)">Remover</button>
            </div>
            <input type="hidden" id="pay-receipt-keep" value="1">
          ` : ''}
        </div>
        <div class="form-group">
          <label class="form-label">Notas</label>
          <textarea class="form-textarea" id="pay-notes" rows="2" maxlength="2000">${escapeHtml(payment?.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:12px;justify-content:space-between;margin-top:16px">
          <div>
            ${payment?.id ? `<button type="button" class="btn btn-ghost" onclick="deletePayment(${payment.id}, true)" style="color:var(--danger)">Excluir</button>` : ''}
          </div>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-ghost" onclick="closePaymentModal()">Cancelar</button>
            <button type="submit" class="btn btn-primary">Salvar</button>
          </div>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('payment-form').addEventListener('submit', submitPayment);
}

function closePaymentModal() {
  const el = document.getElementById('payment-modal');
  if (el) el.remove();
}

function clearReceiptField() {
  const keep = document.getElementById('pay-receipt-keep');
  if (keep) keep.value = '0';
  toast('Comprovante será removido ao salvar');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submitPayment(e) {
  e.preventDefault();
  const operator_id = Number(document.getElementById('pay-operator-id').value);
  const period = document.getElementById('pay-period').value.trim();
  const due_date = document.getElementById('pay-due').value || null;
  const amount = Number(document.getElementById('pay-amount').value) || 0;
  const tip = Number(document.getElementById('pay-tip').value) || 0;
  const status = document.getElementById('pay-status').value;
  const paidAtRaw = document.getElementById('pay-paid-at').value;
  const paid_at = paidAtRaw ? paidAtRaw.replace('T', ' ') + ':00' : null;
  const notes = document.getElementById('pay-notes').value.trim() || null;

  const file = document.getElementById('pay-receipt').files[0];
  const keep = document.getElementById('pay-receipt-keep');
  let receipt_data;
  let receipt_name;
  if (file) {
    if (file.size > 5 * 1024 * 1024) { toast('Comprovante muito grande (máx. 5MB)', 'error'); return; }
    try { receipt_data = await fileToDataUrl(file); receipt_name = file.name; }
    catch { toast('Falha ao ler o arquivo', 'error'); return; }
  } else if (keep && keep.value === '0') {
    receipt_data = null;
    receipt_name = null;
  }

  const body = { operator_id, period, due_date, amount, tip, status, paid_at, notes };
  if (receipt_data !== undefined) { body.receipt_data = receipt_data; body.receipt_name = receipt_name; }

  try {
    await api('/api/finances/payments', { method: 'POST', body });
    toast('Pagamento salvo');
    closePaymentModal();
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

async function quickMarkPaid(operatorId, period) {
  const op = financesOperators.find(o => o.id === operatorId);
  if (!op) return;
  const amount = op.payment_value;
  try {
    await api('/api/finances/payments', {
      method: 'POST',
      body: {
        operator_id: operatorId, period,
        amount, tip: 0, status: 'paid',
        paid_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        due_date: op.current_payment?.due_date || null,
      },
    });
    toast('Marcado como pago');
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

async function deletePayment(id, fromModal) {
  if (!confirm('Excluir este pagamento?')) return;
  try {
    await api('/api/finances/payments/' + id, { method: 'DELETE' });
    toast('Pagamento excluído');
    if (fromModal) closePaymentModal();
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

async function viewReceipt(paymentId) {
  try {
    const csrf = readCookie('csrf_token');
    const res = await fetch('/api/finances/payments/' + paymentId + '/receipt', {
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });
    if (!res.ok) throw new Error('Falha ao carregar comprovante');
    const ctype = res.headers.get('Content-Type') || '';
    if (ctype.includes('application/json')) {
      const r = await res.json();
      openReceiptViewer(r.receipt_data, r.receipt_name, /^data:application\/pdf/.test(r.receipt_data));
      return;
    }
    // Binary BLOB → object URL (revoked when viewer closes).
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disp = res.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    const name = m ? decodeURIComponent(m[1]) : 'comprovante';
    openReceiptViewer(url, name, blob.type === 'application/pdf', url /* revoke */);
  } catch (err) { toast(err.message, 'error'); }
}

async function viewReceiptData(paymentId) {
  if (!paymentId) return;
  await viewReceipt(paymentId);
}

function openReceiptViewer(src, name, isPdf, revokeUrl) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'receipt-viewer';
  overlay.dataset.revokeUrl = revokeUrl || '';
  overlay.innerHTML = `
    <div class="modal" style="max-width:700px">
      <div class="modal-header">
        <h3 class="modal-title">Comprovante${name ? ` — ${escapeHtml(name)}` : ''}</h3>
        <button class="modal-close" onclick="closeReceiptViewer()">&times;</button>
      </div>
      <div style="text-align:center">
        ${isPdf
          ? `<iframe src="${src}" style="width:100%;height:70vh;border:1px solid var(--border);border-radius:8px"></iframe>`
          : `<img src="${src}" style="max-width:100%;max-height:70vh;border-radius:8px">`}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <a href="${src}" download="${escapeHtml(name || 'comprovante')}" class="btn btn-ghost btn-sm">Baixar</a>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeReceiptViewer() {
  const el = document.getElementById('receipt-viewer');
  if (!el) return;
  const url = el.dataset.revokeUrl;
  if (url) { try { URL.revokeObjectURL(url); } catch {} }
  el.remove();
}

// ----- Operator payment history -----

async function openOperatorHistory(operatorId) {
  const op = financesOperators.find(o => o.id === operatorId);
  if (!op) return;
  let payments = [];
  try { payments = await api(`/api/finances/payments?operator_id=${operatorId}`); }
  catch (err) { toast(err.message, 'error'); return; }

  const rows = payments.map(p => {
    const total = Number(p.amount || 0) + Number(p.tip || 0);
    return `<tr>
      <td>${escapeHtml(p.period)}</td>
      <td>${p.due_date ? formatDate(p.due_date) : '-'}</td>
      <td>${formatBRL(total)}</td>
      <td>${financesStatusBadge(p.status)}</td>
      <td>${p.paid_at ? formatDate(p.paid_at) : '-'}</td>
      <td>${p.has_receipt ? `<button class="btn btn-ghost btn-sm" onclick="viewReceipt(${p.id})">Ver</button>` : '-'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="closeOperatorHistory();openPaymentModal(${operatorId}, '${p.period}')">Editar</button></td>
    </tr>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'op-history-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-header">
        <h3 class="modal-title">Histórico — ${escapeHtml(op.name)}</h3>
        <button class="modal-close" onclick="closeOperatorHistory()">&times;</button>
      </div>
      <div style="overflow-x:auto">
      <table class="table" style="width:100%">
        <thead><tr><th>Período</th><th>Vencimento</th><th>Total</th><th>Status</th><th>Pago em</th><th>Comp.</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">Nenhum pagamento registrado</td></tr>'}</tbody>
      </table>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="closeOperatorHistory();openPaymentModal(${operatorId}, null)">+ Novo pagamento</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeOperatorHistory() {
  const el = document.getElementById('op-history-modal');
  if (el) el.remove();
}

// ----- Settings modal -----

function openFinancesSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'finances-settings-modal';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <h3 class="modal-title">Configurações — Finanças</h3>
        <button class="modal-close" onclick="closeFinancesSettings()">&times;</button>
      </div>
      <form id="finances-settings-form">
        <div class="form-group">
          <label class="form-label">Dia padrão de pagamento (mensal)</label>
          <input type="number" min="1" max="31" class="form-input" id="fs-default-day" value="${financesSettings.default_payment_day}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Operadores mensais sem dia personalizado usarão este dia.</div>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="fs-notify" ${financesSettings.notify_operator_payment ? 'checked' : ''}>
            <span>Receber notificação no dia do pagamento</span>
          </label>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="fs-dash" ${financesSettings.dash_include_operators ? 'checked' : ''}>
            <span>Exibir custo dos operadores no Dashboard</span>
          </label>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Adiciona um card resumindo operadores ativos, custo mensal e pendências.</div>
        </div>
        <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px">
          <button type="button" class="btn btn-ghost" onclick="closeFinancesSettings()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('finances-settings-form').addEventListener('submit', saveFinancesSettings);
}

function closeFinancesSettings() {
  const el = document.getElementById('finances-settings-modal');
  if (el) el.remove();
}

async function saveFinancesSettings(e) {
  e.preventDefault();
  const day = Number(document.getElementById('fs-default-day').value) || 5;
  const notify = document.getElementById('fs-notify').checked;
  const dashInclude = document.getElementById('fs-dash').checked;
  try {
    await api('/api/finances/settings', {
      method: 'PUT',
      body: { default_payment_day: day, notify_operator_payment: notify, dash_include_operators: dashInclude },
    });
    financesSettings = { default_payment_day: day, notify_operator_payment: notify, dash_include_operators: dashInclude };
    closeFinancesSettings();
    toast('Configurações salvas');
    await loadFinancesData();
    renderFinancesUI();
  } catch (err) { toast(err.message, 'error'); }
}

async function exportFinancesCsv() {
  try {
    const csrf = readCookie('csrf_token');
    const res = await fetch('/api/finances/export.csv', {
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });
    if (!res.ok) throw new Error('Falha no export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financas-${brtTodayStr()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast(err.message, 'error'); }
}


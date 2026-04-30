const MAX_IMPORT_ROWS = 1000;

function normalizeKey(key) {
  return String(key || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function getValueFactory(row) {
  const byKey = new Map();
  for (const [key, value] of Object.entries(row)) {
    byKey.set(normalizeKey(key), value);
  }
  return (...names) => {
    for (const name of names) {
      const key = normalizeKey(name);
      if (byKey.has(key)) return byKey.get(key);
    }
    return undefined;
  };
}

function parseBRNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let raw = String(value).trim();
  if (!raw) return null;

  let negative = false;
  if (/^\(.*\)$/.test(raw)) negative = true;
  if (raw.includes('-')) negative = true;

  raw = raw
    .replace(/\((.*)\)/, '$1')
    .replace(/[^\d.,]/g, '');

  if (!raw || !/\d/.test(raw)) return null;

  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let normalized = raw;

  if (hasComma && hasDot) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function parseSheetDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = cleanText(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;

  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!br) return null;
  const day = Number(br[1]);
  const month = Number(br[2]);
  const year = Number(br[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeBookmaker(value) {
  const raw = cleanText(value);
  const key = normalizeKey(raw).replace(/\s+/g, '');
  if (key === '365' || key === 'BET365') return { raw, kind: 'bet365', label: 'Bet365' };
  if (key === 'POLY' || key === 'POLYMARKET') return { raw, kind: 'poly', label: 'Poly' };
  return { raw, kind: 'other', label: raw };
}

function normalizeCurrency(value) {
  const raw = normalizeKey(value).replace(/\s+/g, '');
  if (raw === 'USD' || raw === 'USDC') return 'USD';
  if (raw === 'BRL' || raw === 'R$') return 'BRL';
  return raw || '';
}

function parseWinningLeg(value) {
  const raw = normalizeKey(value);
  if (!raw) return null;
  const match = raw.match(/APOSTA\s*(\d+)/) || raw.match(/^(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isSettledStatus(value) {
  const raw = normalizeKey(value);
  return raw.includes('RESOLVID');
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.rows)) {
    return payload.rows;
  }
  throw new Error('Envie um JSON com um array de linhas ou um objeto { rows: [...] }.');
}

function readLeg(get, index, errors) {
  const bookmakerRaw = cleanText(get(`CASA ${index}`));
  const odd = parseBRNumber(get(`ODD ${index}`));
  const currency = normalizeCurrency(get(`MOEDA ${index}`));
  const exchangeRate = parseBRNumber(get(`USDR$ ${index}`, `USD R$ ${index}`, `USDRS ${index}`));
  const stake = parseBRNumber(get(`STAKE ${index}`));
  const retorno = parseBRNumber(get(`RETORNO ${index}`));

  const populated = !!bookmakerRaw || odd != null || stake != null || retorno != null;
  if (!populated) return null;

  if (!bookmakerRaw) errors.push(`CASA ${index} obrigatoria quando a aposta ${index} tem valores.`);

  const bookmaker = normalizeBookmaker(bookmakerRaw);
  return {
    index,
    bookmaker: bookmaker.label,
    bookmaker_raw: bookmaker.raw,
    bookmaker_kind: bookmaker.kind,
    currency,
    odd: odd || 0,
    stake: stake || 0,
    exchange_rate: exchangeRate || null,
    retorno: retorno || 0,
  };
}

function makeBaseOperation({ type, game, eventDate, result, profit, notes }) {
  return {
    type,
    game,
    event_date: eventDate,
    stake_bet365: 0,
    odd_bet365: 0,
    stake_poly_usd: 0,
    odd_poly: 0,
    exchange_rate: 1,
    result,
    profit,
    notes: notes || null,
    account_ids: [],
    tags: [],
    uses_freebet: false,
    freebet_account_ids: [],
    extra_bets: null,
  };
}

function twoSideResult(settled, winningLegIndex, legs, errors) {
  if (!settled) return 'pending';
  if (!winningLegIndex) {
    errors.push('BATEU deve indicar a aposta vencedora, por exemplo "APOSTA 1".');
    return 'pending';
  }
  const winner = legs.find(leg => leg.index === winningLegIndex);
  if (!winner) {
    errors.push(`BATEU aponta para APOSTA ${winningLegIndex}, mas essa aposta nao existe na linha.`);
    return 'pending';
  }
  if (winner.bookmaker_kind === 'poly') return 'poly_won';
  if (winner.bookmaker_kind === 'bet365') return 'bet365_won';
  errors.push('Linhas com Poly devem ter BATEU apontando para uma aposta 365 ou Poly.');
  return 'pending';
}

function mapRowToOperation(row, rowNumber) {
  const errors = [];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { row_number: rowNumber, ok: false, errors: ['Cada linha deve ser um objeto JSON.'] };
  }

  const get = getValueFactory(row);
  const game = cleanText(get('JOGO'));
  const eventDateRaw = get('DATA');
  const eventDate = parseSheetDate(eventDateRaw);
  const notes = cleanText(get('OBSERVACOES'));
  const profit = parseBRNumber(get('LUCRO (R$)', 'LUCRO R$', 'LUCRO')) || 0;
  const settled = isSettledStatus(get('STATUS'));
  const winningLegIndex = parseWinningLeg(get('BATEU'));

  if (!game) errors.push('JOGO obrigatorio.');
  if (eventDateRaw != null && cleanText(eventDateRaw) && !eventDate) {
    errors.push('DATA deve estar no formato DD/MM/AAAA ou AAAA-MM-DD.');
  }

  const legs = [];
  for (let i = 1; i <= 4; i++) {
    const leg = readLeg(get, i, errors);
    if (leg) legs.push(leg);
  }
  if (!legs.length) errors.push('Informe pelo menos uma aposta preenchida.');

  const hasPoly = legs.some(leg => leg.bookmaker_kind === 'poly');
  const hasBet365 = legs.some(leg => leg.bookmaker_kind === 'bet365');
  const polyLegs = legs.filter(leg => leg.bookmaker_kind === 'poly');
  const bet365Legs = legs.filter(leg => leg.bookmaker_kind === 'bet365');

  if (polyLegs.length > 1) errors.push('A importacao aceita no maximo uma aposta Poly por linha.');

  if (errors.length) {
    return { row_number: rowNumber, ok: false, errors };
  }

  let operation;
  if (legs.length === 1) {
    const leg = legs[0];
    operation = makeBaseOperation({
      type: 'punter',
      game,
      eventDate,
      result: settled ? (profit >= 0 ? 'won' : 'lost') : 'pending',
      profit,
      notes,
    });
    operation.extra_bets = [{ stake: leg.stake, odd: leg.odd, bookmaker: leg.bookmaker }];
  } else if (hasPoly && hasBet365) {
    const mainBet365 = bet365Legs[0];
    const poly = polyLegs[0];
    const result = twoSideResult(settled, winningLegIndex, legs, errors);
    if (errors.length) return { row_number: rowNumber, ok: false, errors };

    operation = makeBaseOperation({
      type: bet365Legs.length > 1 ? 'aumentada25' : 'arbitragem',
      game,
      eventDate,
      result,
      profit,
      notes,
    });
    operation.stake_bet365 = mainBet365.stake;
    operation.odd_bet365 = mainBet365.odd;
    operation.stake_poly_usd = poly.stake;
    operation.odd_poly = poly.odd;
    operation.exchange_rate = poly.exchange_rate || 5.0;
    const additionalLegs = legs.filter(leg => leg !== mainBet365 && leg !== poly);
    if (additionalLegs.length) {
      operation.extra_bets = additionalLegs.map(leg => ({
        stake: leg.stake,
        odd: leg.odd,
        ...(leg.bookmaker_kind === 'other' ? { bookmaker: leg.bookmaker } : {}),
        uses_freebet: 0,
      }));
    }
  } else {
    operation = makeBaseOperation({
      type: 'arbitragem_br',
      game,
      eventDate,
      result: settled ? (profit >= 0 ? 'won' : 'lost') : 'pending',
      profit,
      notes,
    });
    operation.extra_bets = legs.map(leg => ({
      stake: leg.stake,
      odd: leg.odd,
      bookmaker: leg.bookmaker,
    }));
  }

  return {
    row_number: rowNumber,
    ok: true,
    errors: [],
    operation,
    summary: {
      game: operation.game,
      type: operation.type,
      event_date: operation.event_date,
      result: operation.result,
      profit: operation.profit,
      legs: legs.map(leg => ({
        index: leg.index,
        bookmaker: leg.bookmaker,
        odd: leg.odd,
        stake: leg.stake,
        currency: leg.currency,
      })),
    },
  };
}

function buildPreview(payload) {
  let rows;
  try {
    rows = extractRows(payload);
  } catch (err) {
    return {
      ok: false,
      total: 0,
      valid_count: 0,
      invalid_count: 1,
      rows: [{ row_number: null, ok: false, errors: [err.message] }],
    };
  }

  if (!rows.length) {
    return {
      ok: false,
      total: 0,
      valid_count: 0,
      invalid_count: 1,
      rows: [{ row_number: null, ok: false, errors: ['Nenhuma linha encontrada no JSON.'] }],
    };
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      total: rows.length,
      valid_count: 0,
      invalid_count: rows.length,
      rows: [{ row_number: null, ok: false, errors: [`Importe no maximo ${MAX_IMPORT_ROWS} linhas por arquivo.`] }],
    };
  }

  const mapped = rows.map((row, index) => mapRowToOperation(row, index + 2));
  const validCount = mapped.filter(row => row.ok).length;
  const invalidCount = mapped.length - validCount;
  return {
    ok: invalidCount === 0,
    total: mapped.length,
    valid_count: validCount,
    invalid_count: invalidCount,
    rows: mapped,
  };
}

module.exports = {
  buildPreview,
  parseBRNumber,
  parseSheetDate,
};

// Small input-validation helpers. The goal isn't a schema framework — it's
// to reject obviously-bad input at the boundary without per-route cruft.

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

function str(val, { min = 0, max = 1024, trim = true, name = 'campo' } = {}) {
  if (val === undefined || val === null) {
    if (min === 0) return '';
    throw new ValidationError(`${name} é obrigatório`);
  }
  if (typeof val !== 'string') throw new ValidationError(`${name} deve ser texto`);
  const v = trim ? val.trim() : val;
  if (v.length < min) throw new ValidationError(`${name} muito curto (mínimo ${min})`);
  if (v.length > max) throw new ValidationError(`${name} muito longo (máximo ${max})`);
  return v;
}

function username(val) {
  const v = str(val, { min: 3, max: 32, name: 'Usuário' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(v)) {
    throw new ValidationError('Usuário deve conter apenas letras, números, _, . ou -');
  }
  return v;
}

function password(val) {
  // Don't trim — users might legitimately start/end a password with a space.
  if (typeof val !== 'string') throw new ValidationError('Senha inválida');
  if (val.length < 6) throw new ValidationError('Senha deve ter ao menos 6 caracteres');
  if (val.length > 256) throw new ValidationError('Senha muito longa');
  return val;
}

function num(val, { min = -Infinity, max = Infinity, name = 'valor' } = {}) {
  const n = typeof val === 'string' ? Number(val) : val;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(`${name} deve ser um número`);
  }
  if (n < min) throw new ValidationError(`${name} menor que o mínimo (${min})`);
  if (n > max) throw new ValidationError(`${name} maior que o máximo (${max})`);
  return n;
}

function int(val, opts = {}) {
  const n = num(val, opts);
  if (!Number.isInteger(n)) throw new ValidationError(`${opts.name || 'valor'} deve ser inteiro`);
  return n;
}

function oneOf(val, allowed, { name = 'valor' } = {}) {
  if (!allowed.includes(val)) {
    throw new ValidationError(`${name} inválido`);
  }
  return val;
}

// Express error handler helper — wraps a route so thrown ValidationError
// becomes a 400 instead of a 500.
function handle(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  };
}

module.exports = {
  ValidationError,
  str, username, password, num, int, oneOf, handle,
};

// Batch-fetch helpers that turn `for (const row of rows) await db.all(...)`
// patterns (N+1 roundtrips) into a single IN(...) query + in-memory group-by.
//
// On Turso each extra roundtrip is ~50–100ms; a list of 100 rows with two
// attachments used to be ~200 roundtrips. These helpers collapse that to 2.

const db = require('../db/database');

// Produces a "?, ?, ?, ..." placeholder string of length N for use in SQL `IN`.
function placeholders(n) {
  if (n <= 0) return '';
  return new Array(n).fill('?').join(',');
}

/**
 * Run a SELECT whose result is a parent→child relation, and attach the
 * grouped children to each parent row in-place.
 *
 * @param {Array<object>} parents    Rows to attach into.
 * @param {object}  opts
 * @param {string}  opts.parentKey   Name of the id field on parents.
 * @param {string}  opts.sql         Parameterized SQL with a single IN(?…) spot
 *                                   marked with `{{IN}}`. The query MUST select
 *                                   the foreign-key column that points back to
 *                                   the parent and that FK must be named
 *                                   `{opts.foreignKey}` in the SELECT output.
 * @param {string}  opts.foreignKey  Name of the FK column in the SELECT output.
 * @param {string}  opts.attachAs    Property name to set on each parent row.
 * @param {Array<any>} [opts.extraParams]  Params to prepend before the IN list.
 * @param {(row: object) => any} [opts.map] Optional mapper applied to every child row.
 * @returns {Promise<void>}
 */
async function attachMany(parents, {
  parentKey = 'id',
  sql,
  foreignKey,
  attachAs,
  extraParams = [],
  map,
}) {
  // Initialize empty arrays so callers never hit `undefined` on rows with no children.
  for (const p of parents) p[attachAs] = [];
  if (!parents.length) return;

  const ids = parents.map(p => p[parentKey]).filter(v => v != null);
  if (!ids.length) return;

  const filledSql = sql.replace('{{IN}}', placeholders(ids.length));
  const rows = await db.all(filledSql, ...extraParams, ...ids);

  const byParent = new Map();
  for (const r of rows) {
    const key = r[foreignKey];
    let list = byParent.get(key);
    if (!list) { list = []; byParent.set(key, list); }
    list.push(map ? map(r) : r);
  }
  for (const p of parents) {
    const list = byParent.get(p[parentKey]);
    if (list) p[attachAs] = list;
  }
}

/**
 * Same as attachMany but for scalar-list children (e.g., tags: ['a','b']).
 * Reads `opts.valueKey` from each row and produces a string[] per parent.
 */
async function attachScalars(parents, {
  parentKey = 'id',
  sql,
  foreignKey,
  valueKey,
  attachAs,
  extraParams = [],
}) {
  return attachMany(parents, {
    parentKey, sql, foreignKey, attachAs, extraParams,
    map: (r) => r[valueKey],
  });
}

module.exports = { attachMany, attachScalars, placeholders };

export const MAX_BYTES = 4_000_000;
const statuses = new Set(['New', 'To Run', 'To Pull', 'Sent to Moulder']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRow = (row) => isObject(row)
  && typeof row.key === 'string' && typeof row.fingerprint === 'string'
  && typeof row.order === 'string' && typeof row.number === 'string'
  && typeof row.description === 'string' && typeof row.species === 'string'
  && Number.isFinite(row.qty) && Number.isFinite(row.days)
  && Array.isArray(row.notes) && row.notes.every(note => typeof note === 'string')
  && Array.isArray(row.issues) && row.issues.every(issue => typeof issue === 'string');

export function validateTracker(data) {
  if (!isObject(data) || data.format !== 'keystone-moulding-tracker' || data.version !== 1
    || !isObject(data.records) || !Array.isArray(data.history)
    || (data.archivedRecords !== undefined && !isObject(data.archivedRecords))
    || (data.reports !== undefined && !Array.isArray(data.reports))
    || data.history.some(entry => !isObject(entry))
    || data.reports?.some(report => !isObject(report))
    || (data.snapshot && (!Array.isArray(data.snapshot.rows) || !data.snapshot.rows.every(isRow)))
    || Object.entries(data.records).some(([key, row]) => !isRow(row) || key !== row.key || !statuses.has(row.status))) {
    throw new Error('Unsupported or incomplete moulding tracking data.');
  }
  return data;
}

export function splitState(data, size = 100_000) {
  const json = JSON.stringify(data);
  if (new TextEncoder().encode(json).length > MAX_BYTES) {
    throw new Error('Tracking data exceeds the 4 MB storage limit for this version.');
  }
  const chunks = [];
  for (let index = 0; index < json.length;) {
    let end = Math.min(index + size, json.length);
    const last = json.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(json.slice(index, end));
    index = end;
  }
  return chunks;
}

export async function readState(db) {
  let results;
  try {
    ({ results } = await db.prepare(
      `SELECT r.revision, c.position, c.body
       FROM tracker_revision AS r
       JOIN tracker_chunks AS c ON c.revision = r.revision
       WHERE r.id = 1 ORDER BY c.position`
    ).all());
  } catch (error) {
    if (/no such table: (?:tracker_revision|tracker_chunks)\b/i.test(error.message)) return null;
    throw error;
  }
  if (!results.length) return null;
  if (results.some((row, index) => row.position !== index)) throw new Error('Stored data is incomplete.');
  return { revision: results[0].revision, data: JSON.parse(results.map(row => row.body).join('')) };
}

export async function initializeState(db, data, email) {
  const chunks = splitState(validateTracker(data));
  const statements = [
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      write_id TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tracker_chunks (
      revision INTEGER NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      body TEXT NOT NULL,
      PRIMARY KEY (revision, position)
    )`),
    // The unique revision row makes a second import fail and roll back.
    db.prepare(`INSERT INTO tracker_revision (id, revision, write_id, updated_by, updated_at)
                VALUES (1, 1, 'initial-import', ?, ?)`).bind(email, new Date().toISOString()),
    ...chunks.map((body, position) =>
      db.prepare('INSERT INTO tracker_chunks (revision, position, body) VALUES (1, ?, ?)').bind(position, body)
    )
  ];
  await db.batch(statements);
}

function stampAudit(data, previous, email, timestamp) {
  for (const field of ['history', 'reports']) {
    const existing = previous[field] ?? [];
    const incoming = data[field] ?? [];
    if (incoming.length < existing.length
      || existing.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(incoming[index]))) {
      throw new Error('Existing history and run reports cannot be edited.');
    }
  }

  for (const entry of data.history.slice(previous.history.length)) {
    entry.recordedBy = email;
    entry.at = timestamp;
    if (entry.current && entry.status) {
      entry.current.markedAt = timestamp;
      entry.current.markedBy = email;
      const row = Object.hasOwn(data.records, entry.key) && data.records[entry.key];
      if (row) {
        row.markedAt = timestamp;
        row.markedBy = email;
      }
    }
  }
  for (const report of (data.reports ?? []).slice(previous.reports?.length ?? 0)) {
    report.sentBy = email;
    report.sentAt = timestamp;
  }
  if (data.snapshot?.importedAt && data.snapshot.importedAt !== previous.snapshot?.importedAt) {
    data.snapshot.importedBy = email;
  }
  data.savedAt = timestamp;
}

export function prepareUpdate(data, previous, email) {
  validateTracker(data);
  const timestamp = new Date().toISOString();
  stampAudit(data, previous, email, timestamp);
  return { timestamp, chunks: splitState(data) };
}

export async function writeState(db, revision, update, email, archive) {
  const writeId = crypto.randomUUID();
  const next = revision + 1;
  // The write ID ties every statement to the update that won the revision check.
  const batch = [
    db.prepare(
      `UPDATE tracker_revision
       SET revision = ?, write_id = ?, updated_by = ?, updated_at = ?
       WHERE id = 1 AND revision = ?`
    ).bind(next, writeId, email, update.timestamp, revision)
  ];
  for (const [position, chunk] of update.chunks.entries()) {
    batch.push(db.prepare(
      `INSERT INTO tracker_chunks (revision, position, body)
       SELECT ?, ?, ? WHERE EXISTS
       (SELECT 1 FROM tracker_revision WHERE id = 1 AND write_id = ?)`
    ).bind(next, position, chunk, writeId));
  }
  batch.push(db.prepare(
    `DELETE FROM tracker_chunks WHERE revision = ?
     AND EXISTS (SELECT 1 FROM tracker_revision WHERE id = 1 AND write_id = ?)`
  ).bind(revision, writeId));
  if (archive) {
    batch.push(db.prepare(`CREATE TABLE IF NOT EXISTS tracker_batches (
      id TEXT NOT NULL, position INTEGER NOT NULL, started_at TEXT NOT NULL,
      saved_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (id, position)
    )`));
    for (const [position, body] of archive.chunks.entries()) {
      batch.push(db.prepare(
        `INSERT INTO tracker_batches (id, position, started_at, saved_at, body)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS
         (SELECT 1 FROM tracker_revision WHERE id = 1 AND write_id = ?)`
      ).bind(archive.id, position, archive.startedAt, archive.savedAt, body, writeId));
    }
  }
  const [result] = await db.batch(batch);
  return result.meta.changes === 1;
}

export async function readBatches(db, id) {
  let results;
  try {
    const query = id
      ? db.prepare(`SELECT id, position, started_at AS startedAt, saved_at AS savedAt, body
                    FROM tracker_batches WHERE id = ? ORDER BY position`).bind(id)
      : db.prepare(`SELECT id, started_at AS startedAt, saved_at AS savedAt
                    FROM tracker_batches WHERE position = 0 ORDER BY saved_at DESC`);
    ({ results } = await query.all());
  } catch (error) {
    if (/no such table: tracker_batches\b/i.test(error.message)) return id ? null : [];
    throw error;
  }
  if (!id) return results;
  if (!results.length) return null;
  if (results.some((row, index) => row.position !== index)) throw new Error('Saved batch is incomplete.');
  const { id: batchId, startedAt, savedAt } = results[0];
  return { id: batchId, startedAt, savedAt, data: JSON.parse(results.map(row => row.body).join('')) };
}

export function startBatch(data) {
  const timestamp = new Date().toISOString();
  const priorScheduled = { ...data.priorScheduled };
  for (const row of [...Object.values(data.archivedRecords ?? {}), ...Object.values(data.records)]) {
    if (!['To Pull', 'To Run', 'Sent to Moulder'].includes(row.status)) continue;
    const key = row.order + '|' + row.number;
    const markedAt = Number.isFinite(Date.parse(row.markedAt)) ? new Date(row.markedAt).toISOString() : timestamp;
    if (!priorScheduled[key] || priorScheduled[key][1] <= markedAt) priorScheduled[key] = [row.status, markedAt];
  }
  const { priorScheduled: _prior, ...saved } = data;
  const archive = {
    id: data.activeBatch?.id ?? crypto.randomUUID(),
    startedAt: data.activeBatch?.startedAt ?? data.snapshot?.importedAt ?? timestamp,
    savedAt: timestamp,
    chunks: splitState(saved, 250_000)
  };
  const next = {
    ...data, activeBatch: { id: crypto.randomUUID(), startedAt: timestamp }, priorScheduled,
    records: {}, archivedRecords: {}, snapshot: null, history: [], reports: [],
    pendingRunReport: null, savedAt: timestamp
  };
  return { data: next, update: { timestamp, chunks: splitState(next, 250_000) }, archive };
}


import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MAX_BYTES, initializeState, prepareUpdate, readBatchHistory, readState, startBatch, validateTracker, writeState } from './state.mjs';

const signingKeys = new Map();

async function authenticate(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN?.toLowerCase();
  const audience = env.ACCESS_AUD;
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)
    || team.startsWith('replace_with_') || !audience || audience.startsWith('REPLACE_WITH_')) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const issuer = `https://${team}`;
  if (!signingKeys.has(issuer)) {
    signingKeys.set(issuer, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)));
  }
  try {
    const { payload } = await jwtVerify(token, signingKeys.get(issuer), {
      issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email']
    });
    return typeof payload.email === 'string' && payload.email.includes('@') ? payload.email : null;
  } catch {
    return null;
  }
}

function response(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function canInitialize(env, email) {
  return env.TRACKER_SETUP_EMAIL?.trim().toLowerCase() === email.toLowerCase();
}

function sameOriginJson(request, url) {
  return request.headers.get('Origin') === url.origin
    && request.headers.get('Content-Type')?.split(';')[0] === 'application/json';
}

async function batchesRequest(request, env, email, url) {
  const id = url.pathname.startsWith('/api/batches/') ? url.pathname.slice('/api/batches/'.length) : null;
  if (id !== null && !/^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|legacy-\d{4}-\d{2}-\d{2})$/i.test(id)) {
    return response({ error: 'Batch not found.' }, 404);
  }
  if (request.method === 'GET') {
    const result = await readBatchHistory(env.DB, id);
    if (!id) return response({ batches: result });
    return result ? response(result) : response({ error: 'Batch not found.' }, 404);
  }
  if (request.method === 'DELETE') {
    if (!id) return response({ error: 'Choose a saved batch to delete.' }, 400);
    if (!sameOriginJson(request, url)) return response({ error: 'Expected a same-origin JSON request.' }, 403);
    if (Number(request.headers.get('Content-Length')) > 4096) return response({ error: 'Invalid delete request.' }, 400);
    let input;
    try {
      input = await request.json();
      if (!Number.isSafeInteger(input?.revision) || input.revision < 1) throw new Error();
    } catch {
      return response({ error: 'Invalid delete request.' }, 400);
    }
    let current = await readState(env.DB);
    if (!current) return response({ error: 'The tracker database needs its initial import.' }, 503);
    current = await scanArchivedBatchLocks(env.DB, current, email);
    if (input.revision !== current.revision) {
      return response({ error: 'The tracker changed. Refresh batch history and try again.' }, 409);
    }
    if (id.startsWith('legacy-')) {
      if (!await readBatchHistory(env.DB, id)) return response({ error: 'Batch not found.' }, 404);
      const data = structuredClone(current.data);
      data.deletedBatchIds = [...new Set([...(data.deletedBatchIds ?? []), id])];
      const update = prepareUpdate(data, current.data, email);
      return await writeState(env.DB, current.revision, update, email)
        ? response({ deleted: true, id, revision: current.revision + 1, data, email })
        : response({ error: 'The tracker changed. Refresh batch history and try again.' }, 409);
    }
    const result = await env.DB.prepare('DELETE FROM tracker_batches WHERE id = ?').bind(id).run();
    if (!result.meta.changes) return response({ error: 'Batch not found.' }, 404);
    return response({ deleted: true, id });
  }
  if (id || request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!sameOriginJson(request, url)) return response({ error: 'Expected a same-origin JSON request.' }, 403);
  let input;
  try {
    input = await request.json();
    if (!Number.isSafeInteger(input?.revision)) throw new Error();
  } catch {
    return response({ error: 'Invalid batch request.' }, 400);
  }
  const current = await readState(env.DB);
  if (!current) return response({ error: 'Import tracking data before starting a batch.' }, 503);
  const conflict = () => response({ error: 'The current batch changed. Refresh the tracker before starting a new batch.' }, 409);
  if (input.revision !== current.revision) return conflict();
  if (!current.data.snapshot && !Object.keys(current.data.records).length) {
    return response({ error: 'The current batch has no schedule to save.' }, 400);
  }
  const { data, update, archive } = startBatch(current.data);
  return await writeState(env.DB, current.revision, update, email, archive)
    ? response({ revision: current.revision + 1, data, email }, 201)
    : conflict();
}

async function overridesRequest(request, env, email, url) {
  if (!canInitialize(env, email)) return response({ error: 'Moulding admin access is required.' }, 403);
  if (request.method !== 'GET' && request.method !== 'PUT') return response({ error: 'Method not allowed.' }, 405);
  if (request.method === 'PUT' && !sameOriginJson(request, url)) {
    return response({ error: 'Expected a same-origin JSON request.' }, 403);
  }
  const current = await readState(env.DB);
  if (!current) return response({ error: 'Import the tracking history before adding overrides.' }, 503);
  const overrides = current.data.mouldingOverrides ?? {};
  if (request.method === 'GET') return response({ revision: current.revision, overrides });

  let input;
  try {
    if (Number(request.headers.get('Content-Length')) > 4096) throw new Error();
    const body = await request.text();
    if (body.length > 4096) throw new Error();
    input = JSON.parse(body);
  } catch {
    return response({ error: 'Invalid moulding override.' }, 400);
  }
  const { revision, number, widthInches, sticksPerPass } = input ?? {};
  if (typeof number !== 'string' || !/^\d{4}$/.test(number)
    || (widthInches !== null && !(Number.isFinite(widthInches) && widthInches > 0))
    || (sticksPerPass !== null && !(Number.isSafeInteger(sticksPerPass) && sticksPerPass >= 1))) {
    return response({ error: 'Enter a four-digit moulding number, a positive width, and a whole number of sticks.' }, 400);
  }
  const conflict = () => response({ error: 'Tracking changed. Review the latest overrides and try again.' }, 409);
  if (revision !== current.revision) return conflict();

  const next = { ...overrides };
  if (widthInches === null && (sticksPerPass === null || sticksPerPass === 1)) delete next[number];
  else next[number] = { widthInches, sticksPerPass: sticksPerPass === 1 ? null : sticksPerPass };
  const data = { ...current.data, mouldingOverrides: next };
  const update = prepareUpdate(data, current.data, email);
  return await writeState(env.DB, current.revision, update, email)
    ? response({ revision: current.revision + 1, overrides: next })
    : conflict();
}

async function setupRequest(request, env, email, url) {
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
  if (!canInitialize(env, email) || !sameOriginJson(request, url)) {
    return response({ error: 'The configured setup account is required.' }, 403);
  }
  const alreadyInitialized = () => response({ error: 'The tracker already has data. Refresh to load it.' }, 409);
  if (await readState(env.DB)) return alreadyInitialized();
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) {
    return response({ error: 'Tracking import is too large.' }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return response({ error: 'Tracking import is too large.' }, 413);
  let data;
  try {
    data = validateTracker(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return response({ error: 'Choose a supported Moulding Tracking JSON file.' }, 400);
  }
  try {
    await initializeState(env.DB, data, email);
  } catch (error) {
    if (await readState(env.DB)) return alreadyInitialized();
    throw error;
  }
  return response({ revision: 1, data, email }, 201);
}

async function stateRequest(request, env, email, url) {
  if (request.method === 'GET') {
    let current = await readState(env.DB);
    if (!current) return response({ needsSetup: true, canInitialize: canInitialize(env, email), email });
    current = await scanArchivedBatchLocks(env.DB, current, email);
    return response({ ...current, email });
  }
  if (request.method !== 'PUT') return response({ error: 'Method not allowed.' }, 405);
  if (!sameOriginJson(request, url)) {
    return response({ error: 'Expected a same-origin JSON request.' }, 403);
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) {
    return response({ error: 'Tracking update is too large.' }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return response({ error: 'Tracking update is too large.' }, 413);
  let input;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
    if (!Number.isSafeInteger(input?.revision) || input.revision < 1) throw new Error();
  } catch {
    return response({ error: 'Invalid tracking update.' }, 400);
  }

  const current = await readState(env.DB);
  if (!current) return response({ error: 'The tracker database needs its initial import.' }, 503);
  const conflict = () => response({ error: 'Someone updated tracking first. Review the refreshed list and try again.' }, 409);
  if (input.revision !== current.revision) return conflict();
  let update;
  try {
    if (input.data && typeof input.data === 'object') {
      for (const field of ['mouldingOverrides', 'activeBatch', 'priorScheduledArchiveScanAt']) {
        if (Object.hasOwn(current.data, field)) input.data[field] = current.data[field];
        else delete input.data[field];
      }
      input.data.priorScheduled = {
        ...(current.data.priorScheduled ?? {}),
        ...(input.data.priorScheduled ?? {})
      };
    }
    update = prepareUpdate(input.data, current.data, email);
  } catch (error) {
    return response({ error: error.message }, 400);
  }
  const written = await writeState(env.DB, current.revision, update, email);
  return written ? response({ revision: current.revision + 1, data: input.data, email }) : conflict();
}

function mergeBatchLocks(current, batch) {
  const prior = current.priorScheduled;
  const add = (row, status, at) => {
    if (!row || typeof row.order !== 'string' || typeof row.number !== 'string') return;
    if (!['To Run', 'To Pull', 'Sent to Moulder', 'Already Run'].includes(status)) return;
    const key = row.order + '|' + row.number;
    if (!prior[key]) prior[key] = [status, at ?? batch.savedAt ?? new Date().toISOString()];
  };
  const data = batch.data;
  for (const row of [...Object.values(data.archivedRecords ?? {}), ...Object.values(data.records ?? {})]) {
    add(row, row.status, row.markedAt);
  }
  for (const entry of data.history ?? []) {
    for (const row of [entry.previous, entry.current]) add(row, row?.status ?? entry.status, entry.at);
  }
  for (const report of data.reports ?? []) {
    for (const row of report.rows ?? []) add(row, 'Sent to Moulder', report.sentAt);
  }
  for (const row of data.snapshot?.rows ?? []) {
    if (row.alreadyRun) add(row, 'Already Run', data.snapshot.importedAt ?? batch.savedAt);
  }
}

async function scanArchivedBatchLocks(db, current, email) {
  if (current.data.priorScheduledArchiveScanAt) return current;
  const data = structuredClone(current.data);
  data.priorScheduled ??= {};
  const batches = await readBatchHistory(db);
  for (const summary of batches) {
    const batch = await readBatchHistory(db, summary.id);
    if (batch?.data) mergeBatchLocks(data, batch);
  }
  data.priorScheduledArchiveScanAt = new Date().toISOString();
  const update = prepareUpdate(data, current.data, email);
  if (await writeState(db, current.revision, update, email)) {
    return { revision: current.revision + 1, data };
  }
  return await readState(db) ?? current;
}

export default {
  async fetch(request, env) {
    const email = await authenticate(request, env);
    if (!email) return new Response('Keystone sign-in required.', {
      status: 403, headers: { 'Cache-Control': 'no-store' }
    });

    const url = new URL(request.url);
    try {
      const assetPath = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
      if (/^\/admin(?:\.html)?\/?$/i.test(assetPath) && !canInitialize(env, email)) {
        return new Response('Moulding admin access is required.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/admin/overrides') return await overridesRequest(request, env, email, url);
      if (url.pathname === '/api/batches' || url.pathname.startsWith('/api/batches/')) return await batchesRequest(request, env, email, url);
      if (url.pathname === '/api/state') return await stateRequest(request, env, email, url);
      if (url.pathname === '/api/setup') return await setupRequest(request, env, email, url);
      if (url.pathname.startsWith('/api/')) return response({ error: 'Not found.' }, 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return response({ error: 'Method not allowed.' }, 405);
      }
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, { status: asset.status, headers });
    } catch (error) {
      console.error('Tracker request failed', error.name);
      return response({ error: 'Tracking service unavailable. Try again.' }, 503);
    }
  }
};




import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MAX_BYTES, initializeState, prepareUpdate, readState, validateTracker, writeState } from './state.mjs';

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
    const current = await readState(env.DB);
    return current ? response({ ...current, email }) : response({ needsSetup: true, canInitialize: canInitialize(env, email), email });
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
    update = prepareUpdate(input.data, current.data, email);
  } catch (error) {
    return response({ error: error.message }, 400);
  }
  const written = await writeState(env.DB, current.revision, update, email);
  return written ? response({ revision: current.revision + 1, data: input.data, email }) : conflict();
}

export default {
  async fetch(request, env) {
    const email = await authenticate(request, env);
    if (!email) return new Response('Keystone sign-in required.', {
      status: 403, headers: { 'Cache-Control': 'no-store' }
    });

    const url = new URL(request.url);
    try {
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

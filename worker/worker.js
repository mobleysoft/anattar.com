// anattar.com's own dedicated Worker: serves the real MVP (alert-ranking
// dashboard, ../mvp) instead of falling through to mobley-venture-fleet-a's
// generic placeholder. Pattern reused from the mhslp-staging asset-worker
// scaffold (mhslp-staging/ventures/bignice.cc/worker.js) - adds basic
// security headers and sane cache-control on top of static asset serving.

function securedHeaders(source, additions = {}) {
  const headers = new Headers(source);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('X-Venture', 'anattar.com');
  for (const [name, value] of Object.entries(additions)) headers.set(name, value);
  return headers;
}

function cacheControl(url, response) {
  const type = response.headers.get('Content-Type') || '';
  const documentLike = url.pathname.endsWith('/')
    || url.pathname.endsWith('.html')
    || type.includes('text/html');
  return documentLike ? 'no-cache' : 'public, max-age=3600';
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securedHeaders({}, { 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Real lead capture for the MVP dashboard -- ventures.json's own
// insight.next_step says the real next step is a named compliance-officer
// customer, not more building. Before this, the live dashboard had no way
// for an interested visitor to leave contact info. KV binding is dedicated
// to this venture (see wrangler.toml), not shared infra.
async function handleInterest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: 'a valid email is required' }, 400);
  }
  const institution = String(body?.institution || '').trim().slice(0, 200);
  const record = { email, institution, submitted_at: new Date().toISOString() };
  await env.LEADS.put(`lead:${email}`, JSON.stringify(record));
  return jsonResponse({ ok: true }, 201);
}

// Real gap found in the 2026-09-26 depth audit: handleInterest() above has
// written real lead submissions to env.LEADS since it was added, but there
// was never a read path -- the only way to see who submitted interest was a
// raw `wrangler kv key list`/`get` CLI call against the namespace ID by
// hand, no repeatable admin view. Same write-only-KV gap already found and
// fixed on alhena.cc's self_reflection_log (2026-09-22); reuses that exact
// fail-closed pattern rather than inventing new auth: a query-param secret,
// identical 404 whether unset or wrong, so this route can never become an
// accidental open read of real submitter emails just because it exists --
// it only starts working once a human deliberately runs
// `wrangler secret put ANATTAR_ADMIN_SECRET`.
async function handleLeadsAdmin(request, env) {
  const url = new URL(request.url);
  const configuredSecret = env.ANATTAR_ADMIN_SECRET;
  const providedSecret = url.searchParams.get('secret') || '';
  if (!configuredSecret || providedSecret !== configuredSecret) {
    return jsonResponse({ error: 'Not found' }, 404);
  }
  const list = await env.LEADS.list({ prefix: 'lead:' });
  const leads = await Promise.all(
    list.keys.map(async (k) => JSON.parse(await env.LEADS.get(k.name)))
  );
  return jsonResponse({ count: leads.length, leads });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/interest') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed\n', {
          status: 405,
          headers: securedHeaders({ Allow: 'POST' })
        });
      }
      return handleInterest(request, env);
    }

    if (url.pathname === '/api/leads' && request.method === 'GET') {
      return handleLeadsAdmin(request, env);
    }

    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: securedHeaders(asset.headers, {
        'Cache-Control': cacheControl(url, asset)
      })
    });
  }
};

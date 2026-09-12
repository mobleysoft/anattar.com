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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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

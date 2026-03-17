// filename: relay/worker.js
const ALLOW_HOSTS = [
  // Edit this list as you like. Add sites you want to fetch.
  'en.wikipedia.org',
  'developer.mozilla.org',
  'qlik.dev',
  'help.qlik.com',
  'raw.githubusercontent.com',
  'githubusercontent.com',
  'github.com',
  'registry.npmjs.org',
  'nodejs.org',
  'react.dev',
  'vitejs.dev',
  'docs.python.org',
  'go.dev',
];

const MAX_BYTES = 2 * 1024 * 1024; // 2MB cap

function isAllowed(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== 'https:') return false;
    return ALLOW_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// very basic HTML -> text
function htmlToText(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  html = html.replace(/<(\/)?(p|div|section|article|header|footer|main|h[1-6]|li|ul|ol|pre|br)[^>]*>/gi, '\n');
  const text = html.replace(/<[^>]+>/g, ' ')
                   .replace(/\r/g, '')
                   .replace(/\n{3,}/g, '\n\n')
                   .replace(/[ \t]{2,}/g, ' ')
                   .trim();
  return text;
}

async function fetchCapped(url, init) {
  const resp = await fetch(url, { redirect: 'follow', cf: { cacheEverything: false }, ...init });
  const reader = resp.body?.getReader();
  if (!reader) return new Response('Upstream had no body', { status: 502 });
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      return new Response('Upstream response too large', { status: 413 });
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.byteLength; }
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const target = url.searchParams.get('url');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const cors = { 'Access-Control-Allow-Origin': '*' };

    if (!target) {
      return new Response('Missing ?url=', { status: 400, headers: cors });
    }
    if (!isAllowed(target)) {
      return new Response('Domain not allowed or non-HTTPS URL', { status: 403, headers: cors });
    }

    try {
      if (path.endsWith('/raw')) {
        const upstream = await fetchCapped(target, { headers: { 'User-Agent': 'RileyRaccoon/1.0' } });
        const h = new Headers(upstream.headers);
        h.set('Access-Control-Allow-Origin', '*');
        return new Response(await upstream.arrayBuffer(), {
          status: upstream.status,
          headers: h,
        });
      }

      if (path.endsWith('/text')) {
        const upstream = await fetchCapped(target, { headers: { 'User-Agent': 'RileyRaccoon/1.0', 'Accept': 'text/html,*/*;q=0.8' } });
        const ct = upstream.headers.get('content-type') || '';
        const raw = await upstream.text();
        const body = ct.includes('html') ? htmlToText(raw) : raw;
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
        });
      }

      return new Response(
        'Use /raw?url=https://... or /text?url=https://...\nAllowed hosts: ' + ALLOW_HOSTS.join(', '),
        { status: 200, headers: cors }
      );
    } catch (e) {
      return new Response('Fetch error: ' + String(e?.message || e), { status: 502, headers: cors });
    }
  }
};

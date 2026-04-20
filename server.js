// ══════════════════════════════════════════════════════════════════════════
// Emperia Geo-Proxy Relay Server · Node.js · Railway/Render/Fly.io
// ══════════════════════════════════════════════════════════════════════════
//
// DEPLOY TO RAILWAY (free):
//   1. railway.app → New Project → Deploy from GitHub
//      OR: railway.app → New Project → Empty → upload this folder
//   2. Set environment variables in Railway dashboard:
//        OXYLABS_USER = emperia13_Dd6B4      (Web Unblocker username)
//        OXYLABS_PASS = s+OUbNZ_tV34d        (Web Unblocker password)
//        RELAY_SECRET = any-random-string     (protect the relay endpoint)
//   3. Railway gives you a URL like: https://emperia-relay.up.railway.app
//   4. Put this URL in CF Worker env: RELAY_URL
//
// ENDPOINTS:
//   GET /health
//   GET /check?url=https://emperiacasino.com&geo=AT&device=desktop&secret=...
// ══════════════════════════════════════════════════════════════════════════

import express    from 'express';
import fetch      from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const app  = express();
const PORT = process.env.PORT || 3000;

const OXYLABS_USER  = process.env.OXYLABS_USER  || '';
const OXYLABS_PASS  = process.env.OXYLABS_PASS  || '';
const RELAY_SECRET  = process.env.RELAY_SECRET  || '';
const PROXY_HOST    = 'unblock.oxylabs.io:60000';
const MAX_REDIRECTS = 6;
const TIMEOUT_MS    = 20000;

const UAS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mobile:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// ── Auth middleware ───────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  if (RELAY_SECRET && req.query.secret !== RELAY_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok:   true,
    proxy: PROXY_HOST,
    credentials: { user: !!OXYLABS_USER, pass: !!OXYLABS_PASS, secret: !!RELAY_SECRET },
  });
});

// ── Main check endpoint ───────────────────────────────────────────────────
app.get('/check', requireSecret, async (req, res) => {
  const { url, geo, device = 'desktop', lang = 'en' } = req.query;

  if (!url || !geo) {
    return res.status(400).json({ ok: false, error: 'Missing: url, geo' });
  }

  if (!OXYLABS_USER || !OXYLABS_PASS) {
    return res.status(500).json({ ok: false, error: 'OXYLABS_USER / OXYLABS_PASS not set' });
  }

  // Country-specific username: username-country-at → Oxylabs selects residential IP from that country
  const geoUser  = `${OXYLABS_USER}-country-${geo.toLowerCase()}`;
  const proxyUrl = `https://${encodeURIComponent(geoUser)}:${encodeURIComponent(OXYLABS_PASS)}@${PROXY_HOST}`;
  const agent    = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const ua       = UAS[device] || UAS.desktop;

  const chain  = [];
  let current  = url;
  let lastStatus = null;
  let lastHeaders = {};
  const started = Date.now();

  try {
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response;
      try {
        response = await fetch(current, {
          agent,
          redirect: 'manual',         // don't auto-follow — we trace each hop
          signal:   controller.signal,
          headers: {
            'User-Agent':      ua,
            'Accept-Language': `${lang};q=1.0,en;q=0.9`,
            'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
            'Cache-Control':   'no-cache',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      const status   = response.status;
      const location = response.headers.get('location') || null;

      // Collect useful response headers
      const hdrs = {};
      for (const k of ['content-type','server','cf-ray','cf-cache-status','content-language','x-geo-country','location']) {
        const v = response.headers.get(k);
        if (v) hdrs[k] = v;
      }

      // Resolve relative Location to absolute URL
      let resolvedLocation = null;
      if (location) {
        try { resolvedLocation = new URL(location, current).href; }
        catch { resolvedLocation = location; }
      }

      chain.push({ url: current, status, location: resolvedLocation, headers: hdrs });
      lastStatus  = status;
      lastHeaders = hdrs;

      // Follow redirect or stop
      if (status >= 300 && status < 400 && resolvedLocation) {
        current = resolvedLocation;
      } else {
        break;
      }
    }

    return res.json({
      ok:            true,
      input:         { url, geo, device, lang, proxyUser: geoUser },
      finalUrl:      current,
      finalStatus:   lastStatus,
      redirectChain: chain,
      redirectCount: chain.length - 1,
      loadTime:      Date.now() - started,
      finalHeaders:  lastHeaders,
      error:         null,
    });

  } catch (e) {
    const isTimeout = e.name === 'AbortError' || String(e.message).includes('abort');
    return res.json({
      ok:            false,
      input:         { url, geo, device, lang },
      finalUrl:      url,
      finalStatus:   null,
      redirectChain: chain,
      redirectCount: 0,
      loadTime:      Date.now() - started,
      finalHeaders:  {},
      error:         isTimeout ? 'TIMEOUT' : String(e.message || 'ERROR').slice(0, 200),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Geo relay running on :${PORT}`);
  console.log(`Proxy: ${PROXY_HOST}`);
  console.log(`Credentials: user=${!!OXYLABS_USER} pass=${!!OXYLABS_PASS}`);
});

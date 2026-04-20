// ══════════════════════════════════════════════════════════════════════════
// Emperia Geo-Proxy Relay Server v3 · Node.js · Render Frankfurt
// Direct fetch (no proxy) — relay is in Frankfurt DE, MaxMind sees DE
// Works for grey GEO (AT/IT/LT/PL etc.) and blocked (FR/GR/GB)
// ══════════════════════════════════════════════════════════════════════════

import express from 'express';

const app  = express();
const PORT = process.env.PORT || 3000;
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const MAX_REDIRECTS = 6;
const TIMEOUT_MS    = 15000;

const UAS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mobile:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function requireSecret(req, res, next) {
  if (RELAY_SECRET && req.query.secret !== RELAY_SECRET)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, version: 'v3', mode: 'direct-fetch', relay: 'Frankfurt DE' });
});

app.get('/myip', async (req, res) => {
  try {
    const r = await fetch('https://ip.oxylabs.io/location');
    res.json({ ok: true, relay_ip: await r.json() });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/check', requireSecret, async (req, res) => {
  const { url, geo, device = 'desktop', lang = 'en' } = req.query;
  if (!url || !geo) return res.status(400).json({ ok: false, error: 'Missing: url, geo' });

  const ua      = UAS[device] || UAS.desktop;
  const chain   = [];
  let current   = url;
  let lastStatus = null;
  let lastHeaders = {};
  const started = Date.now();

  try {
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      let response;
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: ctrl.signal,
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

      const hdrs = {};
      for (const k of ['content-type','server','cf-ray','cf-cache-status','content-language','x-geo-country','location']) {
        const v = response.headers.get(k);
        if (v) hdrs[k] = v;
      }

      let resolvedLocation = null;
      if (location) {
        try { resolvedLocation = new URL(location, current).href; }
        catch { resolvedLocation = location; }
      }

      chain.push({ url: current, status, location: resolvedLocation, headers: hdrs });
      lastStatus  = status;
      lastHeaders = hdrs;

      if (status >= 300 && status < 400 && resolvedLocation) {
        current = resolvedLocation;
      } else {
        break;
      }
    }

    return res.json({
      ok: true, finalUrl: current, finalStatus: lastStatus,
      redirectChain: chain, redirectCount: chain.length - 1,
      loadTime: Date.now() - started, finalHeaders: lastHeaders, error: null,
    });

  } catch(e) {
    return res.json({
      ok: false, finalUrl: url, finalStatus: null,
      redirectChain: chain, redirectCount: 0,
      loadTime: Date.now() - started, finalHeaders: {},
      error: e.name === 'AbortError' ? 'TIMEOUT' : String(e.message || 'ERROR').slice(0, 200),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Geo relay v3 (direct) on :${PORT} — Frankfurt DE`);
});

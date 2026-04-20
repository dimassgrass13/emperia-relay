// ══════════════════════════════════════════════════════════════════════════
// Emperia Geo-Proxy Relay Server v2 · Node.js · Render.com
// Uses Oxylabs Web Unblocker REST API with headless browser
// ══════════════════════════════════════════════════════════════════════════

import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const OXYLABS_USER = process.env.OXYLABS_USER || '';
const OXYLABS_PASS = process.env.OXYLABS_PASS || '';
const RELAY_SECRET = process.env.RELAY_SECRET || '';

const OXYLABS_API  = 'https://realtime.oxylabs.io/v1/queries';
const TIMEOUT_MS   = 30000;

const UAS = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  mobile:  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

const GEO_LOCATION = {
  AT:'Austria',  CY:'Cyprus',  DK:'Denmark',  IT:'Italy',
  LT:'Lithuania',NO:'Norway',  PL:'Poland',   PT:'Portugal',
  LV:'Latvia',   HU:'Hungary', CH:'Switzerland',DE:'Germany',
  SE:'Sweden',   GB:'United Kingdom',FR:'France',GR:'Greece',
};

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  if (RELAY_SECRET && req.query.secret !== RELAY_SECRET)
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── Health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: 'v2',
    api: OXYLABS_API,
    credentials: { user: !!OXYLABS_USER, pass: !!OXYLABS_PASS, secret: !!RELAY_SECRET },
  });
});

// ── Check endpoint ────────────────────────────────────────────────────────
app.get('/check', requireSecret, async (req, res) => {
  const { url, geo, device = 'desktop', lang = 'en' } = req.query;
  if (!url || !geo) return res.status(400).json({ ok: false, error: 'Missing: url, geo' });
  if (!OXYLABS_USER || !OXYLABS_PASS)
    return res.status(500).json({ ok: false, error: 'Credentials not set' });

  const geoLocation = GEO_LOCATION[geo.toUpperCase()];
  if (!geoLocation)
    return res.status(400).json({ ok: false, error: `Unknown GEO: ${geo}` });

  const ua      = UAS[device] || UAS.desktop;
  const auth    = Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString('base64');
  const started = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let oxyResp;
    try {
      oxyResp = await fetch(OXYLABS_API, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          source:          'universal',
          url,
          geo_location:    geoLocation,
          render:          'html',       // headless browser — bypasses bot detection
          follow_redirect: false,        // get first hop only — no redirect loops
          parse:           false,
          custom_request_headers: [
            { key: 'User-Agent',      value: ua },
            { key: 'Accept-Language', value: `${lang};q=1.0,en;q=0.9` },
            { key: 'Accept',          value: 'text/html,application/xhtml+xml,*/*;q=0.8' },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!oxyResp.ok) {
      const body = await oxyResp.text().catch(() => '');
      return res.json({ ok: false, error: `Oxylabs ${oxyResp.status}: ${body.slice(0, 200)}` });
    }

    const data   = await oxyResp.json();
    const result = data?.results?.[0];
    if (!result) return res.json({ ok: false, error: 'Oxylabs: empty results' });

    const firstStatus = result.status_code ?? 200;

    // Normalize headers
    const rawHdrs = result.headers || {};
    const headers = Array.isArray(rawHdrs)
      ? Object.fromEntries(rawHdrs.map(h => [h.name.toLowerCase(), h.value]))
      : Object.fromEntries(Object.entries(rawHdrs).map(([k,v]) => [k.toLowerCase(), v]));

    const locationRaw = headers['location'] || null;
    let locationResolved = null;
    if (locationRaw) {
      try { locationResolved = new URL(locationRaw, url).href; }
      catch { locationResolved = locationRaw; }
    }

    const isRedirect  = firstStatus >= 300 && firstStatus < 400;
    const finalUrl    = (isRedirect && locationResolved) ? locationResolved : (result.url || url);
    const finalStatus = firstStatus;

    const displayHdrs = {};
    for (const k of ['content-type','server','cf-ray','cf-cache-status','content-language','x-geo-country','location']) {
      if (headers[k]) displayHdrs[k] = headers[k];
    }

    const chain = [{
      url, status: firstStatus,
      location: locationResolved,
      headers:  displayHdrs,
      note: isRedirect ? 'First hop (headless browser via Oxylabs Web Unblocker)' : undefined,
    }];

    return res.json({
      ok:            true,
      finalUrl,
      finalStatus,
      redirectChain: chain,
      redirectCount: isRedirect ? 1 : 0,
      loadTime:      Date.now() - started,
      finalHeaders:  displayHdrs,
      error:         null,
    });

  } catch(e) {
    const isTimeout = e.name === 'AbortError';
    return res.json({
      ok:            false,
      finalUrl:      url,
      finalStatus:   null,
      redirectChain: [],
      redirectCount: 0,
      loadTime:      Date.now() - started,
      finalHeaders:  {},
      error:         isTimeout ? 'TIMEOUT' : String(e.message || 'ERROR').slice(0, 200),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Geo relay v2 running on :${PORT}`);
  console.log(`API: ${OXYLABS_API}`);
  console.log(`Credentials: user=${!!OXYLABS_USER} pass=${!!OXYLABS_PASS}`);
});

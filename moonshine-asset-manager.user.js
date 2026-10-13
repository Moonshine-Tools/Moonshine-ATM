// ==UserScript==
// @name         Moonshine Asset Manager
// @namespace    moonshine-asset-manager
// @version      2.8.0
// @description  Learns every Torn stock's behaviour, tests itself on unseen data, recommends portfolio rotations, and gives you one-tap Withdraw / Deposit. You always press Torn's own Buy/Sell button.
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      tornsy.com
// @connect      api.torn.com
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Moonshine-Tools/Moonshine-Asset-Manager/main/moonshine-asset-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Moonshine-Tools/Moonshine-Asset-Manager/main/moonshine-asset-manager.user.js
// @run-at       document-end
// ==/UserScript==

/*
 * WHAT THIS DOES
 *  - Collects prices: official Torn API every minute while Torn is open (raw
 *    snapshots kept 90 days, rolled into hourly history forever), plus years of
 *    hourly history from tornsy.com (public, no key). Stored on your phone.
 *  - Learns each stock's "personality": how far it is from its normal price
 *    (in its own standard deviations) and what historically happened next.
 *    The ranges come from the data, not fixed rules. Each stock's own history
 *    is blended with market-wide history when it has few examples.
 *  - Tests itself: trains on the first 70% of history and tests on the last
 *    30% against buy-and-hold, momentum and simple mean reversion, across
 *    several settings. If it doesn't pass, it shows NO ACTION.
 *  - Recommends one SELL A -> BUY B rotation at a time, sized by evidence, net
 *    of the 0.1% fee, never selling shares that hold a benefit block.
 *  - Withdraw / Deposit use the same rankings: withdraw sells the stock with the
 *    weakest outlook, deposit buys the strongest (falls back to simple rules
 *    while the model is still learning).
 *  - Logs every recommendation and checks what actually happened.
 *
 * RULES COMPLIANCE
 *  - Never presses Torn's Buy, Sell, Confirm or Yes buttons and never sends a
 *    trade request. It only opens the stock's panel and types the share count.
 *  - Torn API use is read-only.
 */

(function () {
  'use strict';
  // =====================================================================
  //  CORE ANALYTICS (pure functions, no browser APIs — unit-testable)
  // =====================================================================
  const Core = (() => {
    const HOUR = 3600;
    const FEE = 0.001;
    const SPAN = 168;          // EMA span in hours (7 days) for "normal price"
    const WARMUP = SPAN * 2;   // hours before z-scores are trusted
    const QS = [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95]; // z-bin edges (learned quantiles)
    const SHRINK_K = 10;       // effective samples needed before a stock's own data outweighs the pooled market
    const POOL_DEP = 4;
    const VAL_VER = 2;         // bump when pass/fail rules change        // stocks move together, so pooled samples count for less

    // rows: [{t (unix sec, hour-aligned), c (close)}] sorted by t
    function dense(rows) {
      if (!rows || rows.length < 2) return null;
      const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
      const n = Math.round((t1 - t0) / HOUR) + 1;
      const lp = new Float64Array(n);
      let j = 0, last = Math.log(rows[0].c);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * HOUR;
        while (j < rows.length && rows[j].t <= t) { if (rows[j].c > 0) last = Math.log(rows[j].c); j++; }
        lp[i] = last;
      }
      return { t0, n, lp };
    }

    // Causal features: z at i uses only lp[0..i].
    function features(lp) {
      const a = 2 / (SPAN + 1), n = lp.length;
      const z = new Float64Array(n).fill(NaN);
      const vol = new Float64Array(n).fill(NaN);
      let m = lp[0], v = 0, vr = 0;
      for (let i = 1; i < n; i++) {
        const d = lp[i] - m;
        if (i >= WARMUP && v > 0) z[i] = d / Math.sqrt(v);
        const r = lp[i] - lp[i - 1];
        vr = (1 - a) * vr + a * r * r;
        if (i >= SPAN) vol[i] = Math.sqrt(vr);
        v = (1 - a) * v + a * d * d;
        m = (1 - a) * m + a * lp[i];
      }
      return { z, vol };
    }

    function prepare(rowsBySid) {
      const S = {};
      for (const [sid, rows] of Object.entries(rowsBySid)) {
        const d = dense(rows);
        if (!d || d.n < WARMUP + 48) continue;
        Object.assign(d, features(d.lp));
        S[sid] = d;
      }
      return S;
    }

    const idxAt = (s, t) => { const i = Math.round((t - s.t0) / HOUR); return i >= 0 && i < s.n ? i : -1; };

    function binOf(z, edges) { let b = 0; while (b < edges.length && z > edges[b]) b++; return b; }

    function quantiles(vals, qs) {
      const s = Float64Array.from(vals).sort();
      return qs.map((q) => s[Math.floor(q * (s.length - 1))]);
    }

    const newBin = () => ({ n: 0, s: 0, ss: 0, w: 0 });

    // Learn E[forward log return | z-bin] per stock and pooled.
    // Only uses samples whose forward window ends before tCut (no leakage).
    function fit(S, horizons, tCut = Infinity) {
      const zs = [];
      for (const s of Object.values(S)) {
        for (let i = WARMUP; i < s.n; i += 6) {
          if (s.t0 + i * HOUR >= tCut) break;
          if (Number.isFinite(s.z[i])) zs.push(s.z[i]);
        }
      }
      if (zs.length < 200) return null;
      const edges = quantiles(zs, QS);
      const stats = {};
      for (const h of horizons) {
        const pooled = Array.from({ length: QS.length + 1 }, newBin);
        const per = {};
        for (const [sid, s] of Object.entries(S)) {
          const bins = Array.from({ length: QS.length + 1 }, newBin);
          for (let i = WARMUP; i + h < s.n; i++) {
            if (s.t0 + (i + h) * HOUR >= tCut) break;
            const z = s.z[i];
            if (!Number.isFinite(z)) continue;
            const r = s.lp[i + h] - s.lp[i];
            const b = binOf(z, edges);
            for (const x of [bins[b], pooled[b]]) { x.n++; x.s += r; x.ss += r * r; if (r > 0) x.w++; }
          }
          per[sid] = bins;
        }
        stats[h] = { pooled, per };
      }
      return { edges, horizons, stats, tCut };
    }

    function binStats(x, h, dep = 1) {
      if (!x || x.n < 2) return null;
      const mean = x.s / x.n;
      const varr = Math.max(1e-10, x.ss / x.n - mean * mean);
      const neff = Math.max(1, x.n / h / dep);
      return { mean, var: varr, neff, se: Math.sqrt(varr / neff), win: x.w / x.n, n: x.n };
    }

    // Shrunk prediction: stock's own bin history blended toward the pooled bin.
    function predict(model, sid, z, h) {
      if (!model || !Number.isFinite(z)) return null;
      const b = binOf(z, model.edges);
      const st = model.stats[h];
      const p = binStats(st.pooled[b], h, POOL_DEP);
      const s = binStats(st.per[sid] && st.per[sid][b], h);
      if (!p) return null;
      const w = s ? s.neff / (s.neff + SHRINK_K) : 0;
      const mean = w * (s ? s.mean : 0) + (1 - w) * p.mean;
      const se = Math.sqrt((w * (s ? s.se : 0)) ** 2 + ((1 - w) * p.se) ** 2);
      return {
        mean, se, bin: b, w,
        lo: b === 0 ? -Infinity : model.edges[b - 1], hi: b === model.edges.length ? Infinity : model.edges[b],
        win: s ? s.win : p.win, nStock: s ? s.n : 0, neffStock: s ? s.neff : 0, nPool: p.n,
      };
    }

    function range(S) {
      let a = Infinity, b = -Infinity;
      for (const s of Object.values(S)) { a = Math.min(a, s.t0); b = Math.max(b, s.t0 + (s.n - 1) * HOUR); }
      return [a, b];
    }

    // Out-of-sample information coefficient: does the model rank stocks correctly?
    function evaluateIC(S, model, h, tStart, tEnd) {
      const ics = [];
      for (let t = tStart; t + h * HOUR <= tEnd; t += h * HOUR) {
        const P = [], R = [];
        for (const [sid, s] of Object.entries(S)) {
          const i = idxAt(s, t);
          if (i < 0 || i + h >= s.n) continue;
          const p = predict(model, sid, s.z[i], h);
          if (!p) continue;
          P.push(p.mean); R.push(s.lp[i + h] - s.lp[i]);
        }
        if (P.length < 5) continue;
        const c = corr(P, R);
        if (Number.isFinite(c)) ics.push(c);
      }
      if (ics.length < 3) return { n: ics.length, mean: NaN, t: NaN };
      const m = ics.reduce((a, b) => a + b, 0) / ics.length;
      const sd = Math.sqrt(ics.reduce((a, b) => a + (b - m) ** 2, 0) / (ics.length - 1)) || 1e-9;
      return { n: ics.length, mean: m, t: (m / sd) * Math.sqrt(ics.length) };
    }

    function corr(a, b) {
      const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
      return sab / Math.sqrt(saa * sbb);
    }

    // Portfolio backtest from tStart to tEnd, daily decisions, fees on every sale.
    // strategy: 'bh' | 'mom' | 'mr' | 'model'
    function backtest(S, model, o) {
      const { strategy, tStart, tEnd, K = 5, minEdge = 0.0025, h = 24 } = o;
      const step = Math.min(h, 24) * HOUR;
      const sids = Object.keys(S);
      const price = (sid, t) => { const s = S[sid]; let i = idxAt(s, t); if (i < 0) i = t < s.t0 ? -1 : s.n - 1; return i < 0 ? NaN : Math.exp(s.lp[i]); };
      const avail = (t) => sids.filter((sid) => { const s = S[sid], i = idxAt(s, t); return i >= SPAN && i < s.n - 1 && (strategy !== 'model' || Number.isFinite(s.z[i])); });
      const score = (sid, t) => {
        const s = S[sid], i = idxAt(s, t);
        if (strategy === 'mom') return s.lp[i] - s.lp[i - SPAN];
        if (strategy === 'mr') return -(s.lp[i] - s.lp[i - SPAN]);
        if (strategy === 'model') { const p = predict(model, sid, s.z[i], h); return p ? p.mean : NaN; }
        return 0;
      };
      let units = {}, fees = 0, trades = 0, peak = 1, maxDD = 0, value = 1;
      const val = (t) => Object.entries(units).reduce((a, [sid, u]) => a + (Number.isFinite(price(sid, t)) ? u * price(sid, t) : 0), 0);
      // initial allocation
      const a0 = avail(tStart);
      if (a0.length < K) return null;
      const pick0 = strategy === 'bh' ? a0 : a0.map((sid) => [sid, score(sid, tStart)]).filter((x) => Number.isFinite(x[1])).sort((a, b) => b[1] - a[1]).slice(0, K).map((x) => x[0]);
      for (const sid of pick0) units[sid] = (1 / pick0.length) / price(sid, tStart);
      let days = 0, held = 0;
      for (let t = tStart + step; t <= tEnd; t += step) {
        value = val(t);
        peak = Math.max(peak, value); maxDD = Math.max(maxDD, 1 - value / peak);
        if (strategy === 'bh') continue;
        const av = avail(t);
        const sc = {}; for (const sid of av) sc[sid] = score(sid, t);
        const ranked = av.filter((s) => Number.isFinite(sc[s])).sort((a, b) => sc[b] - sc[a]);
        const top = new Set(ranked.slice(0, K));
        for (const sid of Object.keys(units)) {
          if (top.has(sid) || !Number.isFinite(sc[sid])) continue;
          const cand = ranked.find((c) => !units[c]);
          if (!cand) break;
          const edge = strategy === 'model' ? sc[cand] - sc[sid] : Infinity;
          if (edge <= FEE + minEdge) continue;
          const v = units[sid] * price(sid, t);
          fees += v * FEE; trades++;
          delete units[sid];
          units[cand] = (v * (1 - FEE)) / price(cand, t);
        }
        days++; held += Object.keys(units).length;
      }
      return { ret: value - 1, maxDD, trades, fees, days };
    }

    // Full validation: 70% train / 30% out-of-sample test.
    function validate(S, horizons = [6, 24, 168]) {
      const [a, b] = range(S);
      const span = (b - a) / HOUR;
      if (span < WARMUP + 24 * 60) return { ok: false, reason: `Need about ${Math.ceil((WARMUP + 24 * 60) / 24)} days of history; have ${Math.floor(span / 24)}.` };
      const tCut = a + Math.floor((a + (b - a) * 0.7 - a) / HOUR) * HOUR;
      const model = fit(S, horizons, tCut);
      if (!model) return { ok: false, reason: 'Not enough data to fit the model.' };
      const res = { tCut, tEnd: b, testDays: Math.round((b - tCut) / 86400), horizons: {} };
      for (const h of horizons) {
        const ic = evaluateIC(S, model, h, tCut, b - h * HOUR);
        const bt = {};
        for (const st of ['bh', 'mom', 'mr', 'model']) bt[st] = backtest(S, model, { strategy: st, tStart: tCut, tEnd: b, h });
        let robust = 0, tried = 0;
        for (const K of [3, 5, 8]) for (const me of [0.001, 0.0025, 0.005]) {
          const r = backtest(S, model, { strategy: 'model', tStart: tCut, tEnd: b, h, K, minEdge: me });
          if (r && bt.bh) { tried++; if (r.ret > bt.bh.ret) robust++; }
        }
        const beatsBH = bt.model && bt.bh && bt.model.ret > bt.bh.ret;
        // Pass: real ranking skill (t > 1.5), beats buy-and-hold after fees, and
        // still beats it in at least 5 of 9 different settings (not a lucky fluke).
        const passed = Number.isFinite(ic.t) && ic.t > 1.5 && beatsBH && tried > 0 && robust / tried >= 5 / 9;
        res.horizons[h] = { ic, bt, robust, tried, passed };
      }
      const best = horizons.map((h) => [h, res.horizons[h]]).sort((x, y) => (y[1].passed - x[1].passed) || ((y[1].ic.t || -99) - (x[1].ic.t || -99)))[0];
      res.h = best[0];
      res.ok = best[1].passed;
      res.reason = res.ok ? '' : 'The model did not beat buy-and-hold reliably on data it had not seen.';
      res.ver = VAL_VER;
      return res;
    }

    // Market regime: current average volatility vs its own history.
    function regime(S) {
      const [a, b] = range(S);
      const series = [];
      for (let t = a + SPAN * HOUR; t <= b; t += 24 * HOUR) {
        let sum = 0, k = 0, zsum = 0, zk = 0;
        for (const s of Object.values(S)) {
          const i = idxAt(s, t); if (i < 0) continue;
          if (Number.isFinite(s.vol[i])) { sum += s.vol[i]; k++; }
          if (Number.isFinite(s.z[i])) { zsum += s.z[i]; zk++; }
        }
        if (k) series.push({ v: sum / k, z: zk ? zsum / zk : 0 });
      }
      if (series.length < 10) return null;
      const cur = series[series.length - 1];
      const pct = series.filter((x) => x.v <= cur.v).length / series.length;
      const label = pct > 0.85 ? 'high volatility' : pct < 0.15 ? 'low volatility' : 'normal volatility';
      const broad = cur.z < -1 ? ', broad decline' : cur.z > 1 ? ', broad rally' : '';
      return { pct, label: label + broad, avgZ: cur.z };
    }

    // ---- live decisions ------------------------------------------------
    function protectedShares(benefit, owned) {
      const req = benefit && Number(benefit.requirement);
      if (!req) return 0;
      if (String(benefit.type).toLowerCase() === 'passive') return owned >= req ? req : 0;
      let total = 0, k = 0;
      while (k < 30 && total + req * 2 ** k <= owned) { total += req * 2 ** k; k++; }
      return total;
    }
    function nextBlockTarget(benefit, owned) {
      const req = benefit && Number(benefit.requirement);
      if (!req) return null;
      if (String(benefit.type).toLowerCase() === 'passive') return owned >= req ? null : req;
      let total = 0, k = 0;
      while (k < 30 && total + req * 2 ** k <= owned) { total += req * 2 ** k; k++; }
      return total + req * 2 ** k;
    }

    // Best single SELL A -> BUY B rotation, or null.
    // stocks: {sid:{price, owned, spare, pred:{mean,se}, allowed}}
    function bestRotation(stocks, o) {
      const { totalValue, minEdge = 0.0025, tMin = 1.2, maxWeight = 0.4, minTrade = 250000 } = o;
      let best = null;
      for (const [a, A] of Object.entries(stocks)) {
        if (!A.allowed || A.spare <= 0 || !A.pred) continue;
        const spareVal = A.spare * A.price;
        for (const [b, B] of Object.entries(stocks)) {
          if (a === b || !B.allowed || !B.pred) continue;
          const adv = B.pred.mean - A.pred.mean - FEE;
          const se = Math.sqrt(A.pred.se ** 2 + B.pred.se ** 2) || 1e-9;
          const t = adv / se;
          if (adv <= minEdge || t <= tMin) continue;
          const frac = Math.min(1, Math.max(0.15, (t - tMin) / 3));
          const room = maxWeight * totalValue - B.owned * B.price;
          const amount = Math.min(frac * spareVal, room);
          if (amount < minTrade) continue;
          const gain = adv * amount;
          if (!best || gain > best.gain) best = { sell: a, buy: b, amount, adv, t, se, gain, sellShares: Math.min(A.spare, Math.ceil(amount / A.price)) };
        }
      }
      return best;
    }

    return { VAL_VER, HOUR, FEE, SPAN, WARMUP, dense, features, prepare, fit, predict, binOf, evaluateIC, backtest, validate, regime, protectedShares, nextBlockTarget, bestRotation, idxAt, range };
  })();

  if (typeof window === 'undefined') { if (typeof module !== 'undefined') module.exports = Core; return; }
  if (window.__tmmLoaded) return;
  window.__tmmLoaded = true;

  // =====================================================================
  //  CONFIG & SMALL HELPERS
  // =====================================================================
  const PDA_KEY = '###PDA-APIKEY###'; // Torn PDA fills this in
  const STOCK_URL = 'https://www.torn.com/page.php?sid=stocks';
  const LS = 'tmm_';
  const MODEL_VERSION = 'zbin-ensemble v1';

  // ---- Updates --------------------------------------------------------
  // To publish an update: change the @version line at the top AND this
  // number to the same new value, then push the file to GitHub.
  const SCRIPT_VERSION = '2.8.0';
  const UPDATE_URL = 'https://raw.githubusercontent.com/Moonshine-Tools/Moonshine-Asset-Manager/main/moonshine-asset-manager.user.js';
  const REPO_PAGE = UPDATE_URL.replace(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/.*$/, 'https://github.com/$1/$2/commits/$3');
  const updateConfigured = () => !/YOUR-GITHUB-NAME|YOUR-REPO/.test(UPDATE_URL);
  const FEE = Core.FEE;

  const DEFAULTS = {
    apiKey: '',
    keepOnHand: 0,
    bufferPct: 0.25,
    parkStock: '',
    exclude: '',
    depositOwnedOnly: false,
    factionVault: true,
    churchMax: 500,
    autoOpen: true,
    historyDays: 730,
    minEdgePct: 0.25,
    evidenceT: 1.2,
    maxWeightPct: 20,
    minTrade: 250000,
    showUnvalidated: false,
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const SETTINGS_VER = 4;
  let settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  if ((settings.ver || 1) < SETTINGS_VER) {
    // v2: trade more often for smaller gains. Reset the trade thresholds once.
    if ((settings.ver || 1) < 2) for (const k of ['minEdgePct', 'evidenceT', 'minTrade']) settings[k] = DEFAULTS[k];
    // v3: the church is a last resort, so its default limit drops to $500.
    if ((settings.ver || 1) < 3 && settings.churchMax === 100000) settings.churchMax = DEFAULTS.churchMax;
    // v4: spread money over at least five stocks so there's more to rotate between.
    if ((settings.ver || 1) < 4 && settings.maxWeightPct === 40) settings.maxWeightPct = DEFAULTS.maxWeightPct;
    settings.ver = SETTINGS_VER;
    try { localStorage.setItem(LS + 'settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  const saveSettings = () => store.set('settings', settings);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const pct = (logR, d = 2) => { const x = Math.expm1(logR) * 100; return (x >= 0 ? '+' : '') + x.toFixed(d) + '%'; };
  const pctPlain = (x, d = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const excluded = () => settings.exclude.toUpperCase().split(/[\s,]+/).filter(Boolean);
  const onStockPage = () => /sid=stocks/i.test(location.href);
  const hourStart = (sec) => sec - (sec % 3600);
  const hLabel = (h) => (h === 24 ? '1-day' : h === 168 ? '7-day' : h === 6 ? '6-hour' : `${h}-hour`);
  const short = (n) => n >= 1e9 ? +(n / 1e9).toFixed(2) + 'b' : n >= 1e6 ? +(n / 1e6).toFixed(2) + 'm' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n);

  function parseAmount(str) {
    if (str == null) return NaN;
    const s = String(str).trim().toLowerCase().replace(/[$,\s]/g, '');
    const m = s.match(/^(\d*\.?\d+)([kmb]?)$/);
    if (!m) return NaN;
    return Math.round(parseFloat(m[1]) * { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]]);
  }

  async function waitFor(fn, timeout = 5000, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  // =====================================================================
  //  NETWORK
  // =====================================================================
  function apiKey() { return PDA_KEY.includes('#') ? settings.apiKey.trim() : PDA_KEY; }

  async function api(path) {
    const key = apiKey();
    if (!key) throw new Error('No API key. Open Market → Settings and add a Limited Access key.');
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://api.torn.com/${path}${sep}key=${encodeURIComponent(key)}&comment=MarketMgr`);
    if (!res.ok) throw new Error(`Torn API returned HTTP ${res.status}.`);
    const j = await res.json();
    if (j.error) throw new Error(`Torn API error: ${j.error.error || j.error.code}`);
    return j;
  }

  // Cross-origin GET for tornsy.com (public historical stock data).
  async function httpGetText(url) {
    if (typeof PDA_httpGet === 'function') {
      const r = await PDA_httpGet(url, {});
      if (typeof r === 'string') return r;
      if (r && r.responseText != null) return r.responseText;
      if (r && typeof r.text === 'function') return String(await r.text());
      return (r && r.body) || '';
    }
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((res, rej) => GM_xmlhttpRequest({
        method: 'GET', url, timeout: 20000,
        onload: (r) => res(r.responseText || ''),
        onerror: () => rej(new Error('Network error')), ontimeout: () => rej(new Error('Timeout')),
      }));
    }
    const r = await fetch(url);
    return r.text();
  }
  async function httpGetJSON(url) { return JSON.parse(await httpGetText(url)); }

  // ---- update check -----------------------------------------------------
  const cmpVer = (a, b) => {
    const x = String(a).split('.').map((n) => parseInt(n, 10) || 0), y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
    return 0;
  };
  const updateInfo = () => {
    const u = store.get('update', null);
    return u && cmpVer(u.latest, SCRIPT_VERSION) > 0 ? u : null;
  };
  // Reads only the @version line of the file on GitHub. Checks at most every 6 hours.
  async function checkForUpdate(force = false) {
    if (!updateConfigured()) return null;
    const u = store.get('update', null);
    if (!force && u && Date.now() - u.checked < 6 * 3600000) return updateInfo();
    try {
      const txt = await httpGetText(UPDATE_URL + '?t=' + Date.now());
      const m = txt.match(/@version\s+([\d.]+)/);
      if (m) store.set('update', { latest: m[1], checked: Date.now() });
    } catch (e) { store.set('update', Object.assign({}, u || {}, { checked: Date.now(), err: String(e.message || e) })); }
    return updateInfo();
  }
  const inTornPDA = () => !PDA_KEY.includes('#') || typeof PDA_httpGet === 'function' || !!window.flutter_inappwebview;
  function installUpdate() {
    if (!inTornPDA()) {
      // Tampermonkey / Violentmonkey offer to install any link ending in .user.js.
      location.href = UPDATE_URL;
      return;
    }
    // Torn PDA updates remote scripts from its own script manager.
    const u = updateInfo();
    const s = openSheet(`
      <h3>Update in Torn PDA</h3>
      <div class="tmm-sub">${u ? `Version ${esc(u.latest)} is ready (you have ${SCRIPT_VERSION}).` : 'Torn PDA installs updates from its script manager.'}</div>
      <ol class="tmm-why">
        <li>Open Torn PDA's menu (top left) → <b>Settings</b> → <b>Advanced Browser Settings</b> → <b>Manage scripts</b>.</li>
        <li>Tap the <b>check for updates</b> button at the top. A green bar says <b>"1 script update available"</b>.</li>
        <li>Tap <b>REVIEW</b>, tick Moonshine Asset Manager and apply.</li>
        <li>Reload this page.</li>
      </ol>
      <div class="tmm-sub">If there's no update bar, the script was pasted in rather than added from its link. Delete it and add it again with <b>+</b> → <b>Remote</b>, using the link below. Your settings and price history are kept.</div>
      <div class="tmm-row"><button class="tmm-act" id="tmm-cpl">Copy script link</button><button class="tmm-plain" id="tmm-x">Close</button></div>`);
    $('#tmm-cpl', s).onclick = () => { try { navigator.clipboard.writeText(UPDATE_URL); $('#tmm-cpl', s).textContent = 'Copied'; } catch (e) { /* ignore */ } };
    $('#tmm-x', s).onclick = closeSheet;
  }

  // =====================================================================
  //  DATABASE (IndexedDB, on your phone)
  // =====================================================================
  const DB = (() => {
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open('torn_market_mgr', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('hourly', { keyPath: 'sid' });          // per stock: {sid, acr, t:[], c:[]}
          d.createObjectStore('minute', { keyPath: 't' });           // raw: {t, p:{sid:price}}
          d.createObjectStore('meta', { keyPath: 'k' });
          d.createObjectStore('decisions', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('executions', { keyPath: 'id', autoIncrement: true });
          d.createObjectStore('snapshots', { keyPath: 't' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    async function tx(name, mode, fn) {
      const d = await open();
      const t = d.transaction(name, mode);
      const out = fn(t.objectStore(name));
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      return out instanceof Promise ? out : out;
    }
    return {
      get: (n, k) => tx(n, 'readonly', (s) => p(s.get(k))),
      put: (n, v) => tx(n, 'readwrite', (s) => p(s.put(v))),
      add: (n, v) => tx(n, 'readwrite', (s) => p(s.add(v))),
      all: (n, range) => tx(n, 'readonly', (s) => p(s.getAll(range))),
      count: (n) => tx(n, 'readonly', (s) => p(s.count())),
      delBelow: (n, k) => tx(n, 'readwrite', (s) => p(s.delete(IDBKeyRange.upperBound(k, true)))),
      clear: (n) => tx(n, 'readwrite', (s) => p(s.clear())),
      async meta(k, d = null) { const r = await this.get('meta', k); return r ? r.v : d; },
      setMeta(k, v) { return this.put('meta', { k, v }); },
    };
  })();

  function mergeSeries(rec, points) {
    const m = new Map();
    for (let i = 0; i < rec.t.length; i++) m.set(rec.t[i], rec.c[i]);
    for (const [t, c] of points) if (c > 0) m.set(t, c);
    const ts = Array.from(m.keys()).sort((a, b) => a - b);
    rec.t = ts; rec.c = ts.map((t) => m.get(t));
    return rec;
  }

  // =====================================================================
  //  TORN DATA
  // =====================================================================
  let marketMem = null;
  async function getMarket(maxAgeSec = 60) {
    const cached = marketMem || store.get('market', null);
    if (cached && Date.now() - cached.t < maxAgeSec * 1000) return (marketMem = cached);
    const j = await api('torn/?selections=stocks');
    const stocks = {};
    for (const [id, s] of Object.entries(j.stocks || {})) {
      stocks[id] = { id: String(s.stock_id || id), acr: s.acronym, name: s.name, price: Number(s.current_price), cap: Number(s.market_cap) || 0, benefit: s.benefit || null };
    }
    marketMem = { t: Date.now(), stocks };
    store.set('market', marketMem);
    return marketMem;
  }

  let userMem = null;
  async function getUser(maxAgeSec = 20) {
    if (userMem && Date.now() - userMem.t < maxAgeSec * 1000) return userMem;
    const j = await api('user/?selections=stocks,money,profile');
    const owned = {};
    const us = j.stocks && typeof j.stocks === 'object' ? j.stocks : {};
    const cost = {};
    for (const [id, s] of Object.entries(us)) {
      const n = Number(s.total_shares ?? s.shares) || 0;
      const sid = String(s.stock_id || id);
      if (n > 0) owned[sid] = n;
      // Average price paid, from the purchase records Torn keeps for each stock.
      let sh = 0, paid = 0;
      for (const tx of Object.values(s.transactions || {})) {
        const q = Number(tx.shares) || 0, pr = Number(tx.bought_price) || 0;
        if (q > 0 && pr > 0) { sh += q; paid += q * pr; }
      }
      if (sh > 0) cost[sid] = paid / sh;
    }
    userMem = {
      t: Date.now(), owned, cost, cash: Number(j.money_onhand) || 0,
      factionId: Number(j.faction && j.faction.faction_id) || 0,
      state: String((j.status && j.status.state) || 'Okay'),
    };
    return userMem;
  }

  // =====================================================================
  //  DATA COLLECTOR (runs while any Torn page is open)
  // =====================================================================
  const TAB = Math.random().toString(36).slice(2);
  function isLeader() {
    const l = store.get('leader', null);
    if (!l || l.id === TAB || Date.now() - l.ts > 90000) { store.set('leader', { id: TAB, ts: Date.now() }); return true; }
    return false;
  }

  const sync = { running: false, status: '' };

  async function collectTick() {
    if (!apiKey() || document.visibilityState === 'hidden' || !isLeader()) return;
    try {
      const m = await getMarket(55);
      const t = Math.floor(m.t / 60000) * 60;
      const p = {}; for (const s of Object.values(m.stocks)) p[s.id] = s.price;
      await DB.put('minute', { t, p });
      await foldMinutes();
      const lastUser = await DB.meta('lastUserSnap', 0);
      if (Date.now() - lastUser > 5 * 60000) {
        const u = await getUser(60);
        await snapshot(m, u);
        await DB.setMeta('lastUserSnap', Date.now());
        updateBadges();
      }
      const lastSync = await DB.meta('lastTornsy', 0);
      if (!sync.running && Date.now() - lastSync > 60 * 60000) syncHistory().catch(() => {});
      const lastPrune = await DB.meta('lastPrune', 0);
      if (Date.now() - lastPrune > 86400000) {
        await DB.delBelow('minute', Math.floor(Date.now() / 1000) - 90 * 86400);
        await DB.setMeta('lastPrune', Date.now());
      }
    } catch (e) { /* retry next minute */ }
  }

  // Roll raw minute prices up into hourly closes (keeps raw minutes for 90 days).
  async function foldMinutes() {
    const nowH = hourStart(Math.floor(Date.now() / 1000));
    const last = await DB.meta('foldedTo', 0);
    if (last >= nowH) return;
    const rows = await DB.all('minute', IDBKeyRange.bound(Math.max(last, nowH - 7 * 86400), nowH, false, true));
    const closes = {};
    for (const r of rows) {
      const h = hourStart(r.t);
      for (const [sid, price] of Object.entries(r.p)) (closes[sid] = closes[sid] || {})[h] = price;
    }
    const market = marketMem || store.get('market', null);
    for (const [sid, byH] of Object.entries(closes)) {
      const rec = (await DB.get('hourly', sid)) || { sid, acr: market && market.stocks[sid] ? market.stocks[sid].acr : '', t: [], c: [] };
      mergeSeries(rec, Object.entries(byH).map(([h, c]) => [Number(h), c]));
      await DB.put('hourly', rec);
    }
    await DB.setMeta('foldedTo', nowH);
    if (A) A.dirty = true;
  }

  async function snapshot(m, u) {
    let val = u.cash;
    const holdings = {};
    for (const [sid, n] of Object.entries(u.owned)) {
      const s = m.stocks[sid]; if (!s) continue;
      val += n * s.price; holdings[sid] = n;
    }
    await DB.put('snapshots', { t: hourStart(Math.floor(Date.now() / 1000)), cash: u.cash, holdings, value: val });
  }

  // Download hourly history from tornsy.com: newest first, then older pages.
  async function syncHistory(force = false) {
    if (sync.running) return;
    sync.running = true;
    try {
      const m = await getMarket(600);
      const prog = (await DB.meta('syncProg', {})) || {};
      const minT = Math.floor(Date.now() / 1000) - settings.historyDays * 86400;
      const ids = Object.keys(m.stocks);
      let round = 0;
      while (round++ < 40) {
        let work = false;
        for (let k = 0; k < ids.length; k++) {
          if (document.visibilityState === 'hidden' && !force) return;
          const sid = ids[k], s = m.stocks[sid];
          const st = prog[sid] || (prog[sid] = {});
          const rec = (await DB.get('hourly', sid)) || { sid, acr: s.acr, t: [], c: [] };
          rec.acr = s.acr;
          const base = `https://tornsy.com/api/${s.acr.toLowerCase()}?interval=h1&limit=2000`;
          const nowSec = Math.floor(Date.now() / 1000);
          let pts = [];
          try {
            if (!st.newest || nowSec - st.newest > 3600) {
              const url = st.newest ? `${base}&from=${st.newest}` : base;
              const j = await httpGetJSON(url);
              pts = (j.data || []).map((r) => [Number(r[0]), Number(r[4])]);
              if (pts.length) {
                st.newest = Math.max(st.newest || 0, pts[pts.length - 1][0]);
                st.oldest = Math.min(st.oldest || Infinity, pts[0][0]);
              }
              await sleep(1100);
            }
            if (!st.done && st.oldest && st.oldest > minT) {
              const j = await httpGetJSON(`${base}&to=${st.oldest}`);
              const older = (j.data || []).map((r) => [Number(r[0]), Number(r[4])]);
              if (!older.length) st.done = true;
              else { st.oldest = older[0][0]; pts = pts.concat(older); if (st.oldest <= minT) st.done = true; }
              work = work || !st.done;
              await sleep(1100);
            } else if (st.oldest && st.oldest <= minT) st.done = true;
          } catch (e) { st.err = String(e.message || e); await sleep(3000); }
          if (pts.length) { mergeSeries(rec, pts); await DB.put('hourly', rec); }
          await DB.setMeta('syncProg', prog);
          const doneN = ids.filter((i) => prog[i] && prog[i].done).length;
          sync.status = `${doneN} of ${ids.length} stocks fully downloaded`;
        }
        if (!work) break;
      }
      await DB.setMeta('lastTornsy', Date.now());
      if (A) A.dirty = true;
    } finally { sync.running = false; }
  }

  // =====================================================================
  //  ANALYSIS
  // =====================================================================
  let A = null, analyzing = null;

  async function analyze(force = false) {
    if (A && !force && !A.dirty && Date.now() - A.t < 10 * 60000) return A;
    if (analyzing) return analyzing;
    analyzing = (async () => {
      const recs = await DB.all('hourly');
      let market = null;
      try { market = await getMarket(90); } catch (e) { market = marketMem || store.get('market', null); }
      const rowsBySid = {};
      const liveH = market ? hourStart(Math.floor(market.t / 1000)) : 0;
      for (const rec of recs) {
        const rows = rec.t.map((t, i) => ({ t, c: rec.c[i] }));
        const live = market && market.stocks[rec.sid];
        if (live && rows.length) {
          if (rows[rows.length - 1].t < liveH) rows.push({ t: liveH, c: live.price });
          else if (rows[rows.length - 1].t === liveH) rows[rows.length - 1].c = live.price;
        }
        rowsBySid[rec.sid] = rows;
      }
      await yieldUI();
      const S = Core.prepare(rowsBySid);
      const nS = Object.keys(S).length;
      await yieldUI();
      let val = await DB.meta('validation', null);
      if (nS >= 5 && (!val || force || val.ver !== Core.VAL_VER || Date.now() - val.at > 6 * 3600000 || val.nStocks !== nS)) {
        val = Core.validate(S);
        val.at = Date.now(); val.nStocks = nS;
        await DB.setMeta('validation', val);
      }
      await yieldUI();
      const model = nS >= 5 ? Core.fit(S, [6, 24, 168]) : null;
      const h = val && val.h ? val.h : 24;
      const preds = {};
      for (const [sid, s] of Object.entries(S)) {
        const i = s.n - 1, z = s.z[i];
        let below = 0, tot = 0;
        for (let j = Core.WARMUP; j < s.n; j += 6) if (Number.isFinite(s.z[j])) { tot++; if (s.z[j] <= z) below++; }
        preds[sid] = { z, pctile: tot ? below / tot : NaN, pred: model ? Core.predict(model, sid, z, h) : null, lastT: s.t0 + i * 3600 };
      }
      const out = {
        t: Date.now(), S, val, model, h, preds, market,
        regime: nS >= 5 ? Core.regime(S) : null,
        hyp: nS >= 5 ? hypotheses(S, val) : null,
        validated: !!(val && val.ok),
        nStocks: nS, hours: recs.reduce((a, r) => a + r.t.length, 0),
        oldest: recs.reduce((a, r) => (r.t.length ? Math.min(a, r.t[0]) : a), Infinity),
      };
      await updateOutcomes(out);
      A = out;
      return A;
    })();
    try { return await analyzing; } finally { analyzing = null; }
  }

  // Tests the user's own hypotheses against the data.
  function hypotheses(S, val) {
    const daily = [];
    for (const s of Object.values(S)) for (let i = 24; i < s.n; i += 24) daily.push(s.lp[i] - s.lp[i - 24]);
    const n = daily.length;
    const m = daily.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    const tDrift = (m / sd) * Math.sqrt(n / 4); // /4: stocks are correlated
    const out = [];
    out.push(tDrift > 2
      ? `Upward drift: confirmed. Stocks gained about ${pctPlain(Math.expm1(m * 365))} a year on average (t = ${tDrift.toFixed(1)}).`
      : `Upward drift: not proven. Average yearly change ${pctPlain(Math.expm1(m * 365))}, which is within the noise (t = ${tDrift.toFixed(1)}).`);
    if (val && val.horizons) {
      for (const [h, r] of Object.entries(val.horizons)) {
        const ic = r.ic;
        if (!Number.isFinite(ic.t)) continue;
        out.push(ic.t > 2
          ? `${hLabel(+h)} horizon: stocks that were far from their normal price did move back, on data the model had not seen (t = ${ic.t.toFixed(1)}).`
          : ic.t < -2
            ? `${hLabel(+h)} horizon: the opposite happened. Moves tended to continue (momentum), not reverse (t = ${ic.t.toFixed(1)}).`
            : `${hLabel(+h)} horizon: no reliable mean reversion or momentum found (t = ${ic.t.toFixed(1)}).`);
        if (r.bt && r.bt.mom && r.bt.bh) out.push(`${hLabel(+h)}: momentum strategy ${pctPlain(r.bt.mom.ret)} vs buy-and-hold ${pctPlain(r.bt.bh.ret)} on the test period.`);
      }
    }
    return out;
  }

  // Track what actually happened after each recommendation.
  async function updateOutcomes(an) {
    const decs = await DB.all('decisions');
    const nowS = Math.floor(Date.now() / 1000);
    for (const d of decs) {
      if (d.outcome || !d.h || nowS < d.ts + d.h * 3600) continue;
      const a = an.S[d.sell], b = an.S[d.buy];
      if (!a || !b) continue;
      const ia = Core.idxAt(a, hourStart(d.ts)), ib = Core.idxAt(b, hourStart(d.ts));
      if (ia < 0 || ib < 0 || ia + d.h >= a.n || ib + d.h >= b.n) continue;
      const realized = (b.lp[ib + d.h] - b.lp[ib]) - (a.lp[ia + d.h] - a.lp[ia]) - FEE;
      d.outcome = { realized, at: nowS };
      await DB.put('decisions', d);
    }
  }

  // Build the live decision inputs from analysis + your holdings.
  function liveStocks(an, user) {
    const out = {};
    const ex = excluded();
    for (const s of Object.values(an.market ? an.market.stocks : {})) {
      const owned = user.owned[s.id] || 0;
      const p = an.preds[s.id];
      const price = domPrice(s.id) || s.price;
      const cost = user.cost ? user.cost[s.id] : null;
      out[s.id] = {
        s, price, owned, cost: cost || null,
        profit: cost ? (price * (1 - FEE)) / cost - 1 : null, // after the 0.1% fee
        spare: owned - Core.protectedShares(s.benefit, owned),
        pred: p && p.pred, z: p ? p.z : NaN, pctile: p ? p.pctile : NaN,
        allowed: !ex.includes(s.acr),
      };
    }
    return out;
  }

  function findOpportunity(an, user, cash) {
    const L = liveStocks(an, user);
    let total = cash;
    for (const x of Object.values(L)) total += x.owned * x.price;
    const rot = Core.bestRotation(L, {
      totalValue: total, minEdge: settings.minEdgePct / 100, tMin: settings.evidenceT,
      maxWeight: settings.maxWeightPct / 100, minTrade: settings.minTrade,
    });
    return { rot, L, total };
  }

  function evidence(rot, L) {
    const n = Math.min(L[rot.sell].pred.neffStock || 0, L[rot.buy].pred.neffStock || 0);
    if (rot.t > 3 && n >= 20) return 'Strong';
    if (rot.t > 2) return 'Moderate';
    return 'Light';
  }

  function whyLines(an, rot, L) {
    const A_ = L[rot.sell], B_ = L[rot.buy];
    const lines = [];
    const desc = (x) => {
      const dir = x.z >= 0 ? 'above' : 'below';
      const pc = Number.isFinite(x.pctile) ? `, ${ordinal(Math.round(x.pctile * 100))} percentile of its history` : '';
      return `${x.s.acr} is ${Math.abs(x.z).toFixed(1)} standard deviations ${dir} its 7-day normal price${pc}.`;
    };
    const hist = (x) => {
      const p = x.pred;
      const src = p.nStock > 50 ? `${num(p.nStock)} hourly samples of ${x.s.acr}` : `mostly market-wide data (${x.s.acr} has few similar moments)`;
      return `When ${x.s.acr} was in this range before, its next ${hLabel(an.h)} change averaged ${pct(p.mean)}, rising ${Math.round(p.win * 100)}% of the time (${src}).`;
    };
    lines.push(desc(B_), hist(B_), desc(A_), hist(A_));
    lines.push(`Difference after the 0.1% selling fee: ${pct(rot.adv)} over ${hLabel(an.h)}s, about ${rot.t.toFixed(1)}× its uncertainty.`);
    lines.push('Only spare shares above your benefit blocks are sold.');
    const v = an.val && an.val.horizons && an.val.horizons[an.h];
    if (v && v.bt.model && v.bt.bh) lines.push(`Tested on the last ${an.val.testDays} days it hadn't seen: model ${pctPlain(v.bt.model.ret)} vs buy-and-hold ${pctPlain(v.bt.bh.ret)}.`);
    return lines;
  }
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

  async function logDecision(an, rot, L, status) {
    const ts = Math.floor(Date.now() / 1000);
    const decs = await DB.all('decisions');
    let d = decs.reverse().find((x) => x.sell === rot.sell && x.buy === rot.buy && ts - x.ts < 6 * 3600);
    if (!d) {
      d = {
        ts, sell: rot.sell, buy: rot.buy, sellAcr: L[rot.sell].s.acr, buyAcr: L[rot.buy].s.acr,
        amount: rot.amount, adv: rot.adv, se: rot.se, tstat: rot.t, h: an.h,
        evidence: evidence(rot, L), regime: an.regime ? an.regime.label : '', model: MODEL_VERSION,
        reasons: whyLines(an, rot, L), status,
      };
      d.id = await DB.add('decisions', d);
    } else if (status !== 'shown') { d.status = status; await DB.put('decisions', d); }
    return d.id;
  }

  // =====================================================================
  //  PAGE READING & FILLING TORN'S TRADE BOX
  //  Never presses Buy / Sell / Confirm. You do that.
  // =====================================================================
  function stockRows() { return $$("ul[class*='stock_']").filter((u) => /^\d+$/.test(u.id)); }
  function findRow(id) { const el = document.getElementById(String(id)); return el && /stock/i.test(el.className) ? el : null; }
  function domPrice(id) {
    const row = findRow(id);
    const el = row && row.querySelector("[class^='price_'], [class*=' price_'], [class*='price___']");
    if (!el) return null;
    const v = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
    return v > 0 ? v : null;
  }
  function domCash() {
    const el = document.getElementById('user-money');
    const v = el && Number(el.getAttribute('data-money'));
    return Number.isFinite(v) ? v : null;
  }

  function setNativeValue(input, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    const hidden = input.parentElement && input.parentElement.querySelector('input[type=hidden]');
    if (hidden) hidden.value = v;
  }
  function kindOf(el) {
    const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
    const cb = /buy/.test(cls), cs = /sell/.test(cls);
    if (cb !== cs) return cb ? 'buy' : 'sell';
    let b = false, s = false;
    for (const x of el.querySelectorAll("button, [role='button'], input[type='submit'], a")) {
      const t = (x.textContent || x.value || '').trim().toLowerCase();
      if (/^buy\b/.test(t)) b = true;
      if (/^sell\b/.test(t)) s = true;
    }
    if (b && s) return 'both';
    return b ? 'buy' : s ? 'sell' : null;
  }
  function panelScope(row) {
    const nodes = [row];
    let n = row.nextElementSibling;
    while (n && !(n.tagName === 'UL' && /^\d+$/.test(n.id))) { nodes.push(n); n = n.nextElementSibling; }
    if (nodes.length === 1 && row.parentElement && row.parentElement.querySelectorAll("ul[class*='stock_']").length === 1) nodes.push(row.parentElement);
    return nodes;
  }
  function findTradeInput(row, action) {
    for (const root of panelScope(row)) {
      const inputs = $$('input', root).filter((i) => i.type !== 'hidden' && i.offsetParent !== null && !i.closest('#tmm-root'));
      for (const inp of inputs) {
        let el = inp.parentElement;
        while (el && el !== root.parentElement) {
          const k = kindOf(el);
          if (k === 'both') break;
          if (k) { if (k === action) return inp; break; }
          el = el.parentElement;
        }
      }
    }
    return null;
  }
  function safeOpenPanel(row) {
    const cell = row.querySelector("[class*='stockOwned'], [class*='owned' i]");
    if (!cell || /^(buy|sell|confirm|yes)\b/i.test(cell.textContent.trim())) return false;
    cell.click(); // opens the panel only
    return true;
  }
  const readNum = (input) => parseInt(String(input.value).replace(/[^0-9]/g, ''), 10);

  // Torn's trade boxes are React components. Changing the text you see is not
  // enough: React keeps its own copy of the number, and that copy is what the
  // Sell button sends. So we (1) type the number like a keyboard would and
  // (2) hand the number straight to React's own change handler.
  function boxInputs(input) {
    const g = input.closest('.input-money-group') || input.parentElement;
    const list = g ? $$('input', g).filter((x) => !/^(button|submit|checkbox|radio)$/i.test(x.type)) : [];
    return [input, ...list.filter((x) => x !== input)]; // the visible box first
  }
  const boxShows = (inputs, want) => inputs.every((x) => readNum(x) === want);
  function reactProps(el) {
    for (const k in el) if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) return el[k];
    return null;
  }
  function nativeSet(el, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    try { setter.call(el, v); } catch (e) { el.value = v; }
  }
  function fakeEvent(el, type) {
    return { type, target: el, currentTarget: el, nativeEvent: new Event(type), bubbles: true, isTrusted: false,
      preventDefault() {}, stopPropagation() {}, persist() {}, isDefaultPrevented: () => false, isPropagationStopped: () => false };
  }
  function tellReact(el) {
    const p = reactProps(el);
    if (!p) return false;
    for (const h of ['onChange', 'onInput']) { try { if (typeof p[h] === 'function') p[h](fakeEvent(el, h === 'onChange' ? 'change' : 'input')); } catch (e) { /* ignore */ } }
    return true;
  }
  function keyEv(el, type, ch) {
    el.dispatchEvent(new KeyboardEvent(type, { key: ch, code: /\d/.test(ch) ? 'Digit' + ch : ch, bubbles: true, cancelable: true }));
  }
  async function typeLikeKeyboard(el, str) {
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    // clear
    keyEv(el, 'keydown', 'Backspace');
    nativeSet(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    keyEv(el, 'keyup', 'Backspace');
    tellReact(el);
    await sleep(30);
    // type each digit
    let cur = '';
    for (const ch of str) {
      cur += ch;
      keyEv(el, 'keydown', ch);
      keyEv(el, 'keypress', ch);
      nativeSet(el, cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      keyEv(el, 'keyup', ch);
      tellReact(el);
      await sleep(15);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Empty Torn's box after it's been used, so the old amount isn't left behind.
  function clearBox(input) {
    if (!input || !input.isConnected) return;
    for (const x of boxInputs(input)) {
      nativeSet(x, '');
      x.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      x.dispatchEvent(new Event('change', { bubbles: true }));
      tellReact(x);
    }
    input.classList.remove('tmm-filled');
  }

  // Replace whatever is in Torn's box with v, then check it actually stuck.
  async function typeInto(input, v) {
    const str = String(v), want = Number(v);
    const inputs = boxInputs(input);
    await typeLikeKeyboard(input, str);
    for (const x of inputs.slice(1)) { nativeSet(x, str); x.dispatchEvent(new Event('input', { bubbles: true })); tellReact(x); }
    try { input.blur(); } catch (e) { /* ignore */ }
    await sleep(350);
    if (!boxShows(inputs, want)) {
      await typeLikeKeyboard(input, str);
      try { input.blur(); } catch (e) { /* ignore */ }
      await sleep(350);
    }
    return boxShows(inputs, want);
  }

  // Safety net: when Torn asks "Are you sure you want to sell N shares…",
  // compare N with the number we filled in. If they differ, warn loudly.
  function confirmShares(scopeNodes, action) {
    const re = action === 'sell' ? /\bsell\s+([\d,]+)\s+(?:[A-Z]{2,4}\s+)?shares?\b/i : /\bbuy\s+([\d,]+)\s+(?:[A-Z]{2,4}\s+)?shares?\b/i;
    for (const n of scopeNodes) {
      const txt = (n.innerText || n.textContent || '').replace(/\s+/g, ' ');
      const m = txt.match(re);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    return null;
  }

  // After a trade, Torn replaces the Buy/Sell box with "You have sold… [BACK]"
  // (or "Do you want to sell…? [BACK] [CONFIRM]" if one was left unconfirmed).
  // Tapping BACK just returns to the normal boxes; it never trades anything.
  // We only ever tap a button labelled exactly "Back" inside one of those messages.
  // BACK buttons that belong to a finished ("You have sold…") or pending
  // ("Do you want to sell…?") trade message in this stock's panel.
  function resultBackButtons(row, finishedOnly = false) {
    const out = [];
    const re = finishedOnly ? /you have (bought|sold)/i : /you have (bought|sold)|do you want to (buy|sell)/i;
    for (const root of panelScope(row)) {
      for (const b of $$("button, a, [role=button], input[type=button]", root)) {
        if (b.closest('#tmm-root') || b.offsetParent === null || !/^back$/i.test(elText(b))) continue;
        let el = b.parentElement;
        for (let d = 0; el && d < 4 && el !== root.parentElement; d++, el = el.parentElement) {
          if (re.test(elText(el))) { out.push(b); break; }
        }
      }
    }
    return out;
  }
  function clearStaleResult(row) {
    let clicked = false;
    for (const b of resultBackButtons(row)) { try { b.click(); clicked = true; } catch (e) { /* ignore */ } }
    return clicked;
  }

  // After a trade goes through, Torn shows "You have sold… [BACK]". Ask the
  // player to tap BACK (highlighted) and wait for it before moving on, so the
  // next step finds Torn's normal Buy/Sell boxes. Gives up after 3 minutes.
  async function waitForBack(stockId, onWaiting) {
    const row = findRow(stockId);
    if (!row) return;
    const btns = await waitFor(() => { const b = resultBackButtons(row, true); return b.length ? b : null; }, 2500, 200);
    if (!btns) return; // Torn showed no result message
    btns.forEach((b) => b.classList.add('tmm-backhint'));
    try { btns[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ }
    onWaiting();
    await waitFor(() => !resultBackButtons(row, true).length, 3 * 60000, 300);
  }

  async function openAndFill(stockId, action, shares) {
    const row = await waitFor(() => findRow(stockId), 6000);
    if (!row) return { res: 'missing' };
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    let input = findTradeInput(row, action);
    // Panel already open but showing the last trade's result: tap BACK first.
    if (!input && clearStaleResult(row)) input = await waitFor(() => findTradeInput(row, action), 3000);
    if (!input && settings.autoOpen) safeOpenPanel(row);
    input = input || (await waitFor(() => findTradeInput(row, action), settings.autoOpen ? 4000 : 20000));
    if (!input && clearStaleResult(row)) input = await waitFor(() => findTradeInput(row, action), 3000);
    if (!input) return { res: 'missing' };
    const ok = await typeInto(input, shares);
    input.classList.add('tmm-filled');
    setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
    return { res: ok ? 'ok' : 'unverified', input };
  }

  // =====================================================================
  //  QUICK WITHDRAW / DEPOSIT PLANNING (uses the same model rankings)
  // =====================================================================
  const modelUsable = (an) => an && an.model && (an.validated || settings.showUnvalidated);

  function planWithdraw(amount, an, user) {
    const buf = 1 + settings.bufferPct / 100;
    const L = liveStocks(an, user);
    const useModel = modelUsable(an);
    const opts = [];
    for (const x of Object.values(L)) {
      if (!x.owned || !x.allowed) continue;
      const shares = Math.ceil((amount * buf) / (x.price * (1 - FEE)));
      opts.push(Object.assign({}, x, { shares, fits: shares <= x.owned, breaks: shares > x.spare }));
    }
    // First choice: stocks that are worth more than you paid, even after the 0.1% fee.
    // Then stocks with no purchase record. Last: stocks you'd sell at a loss.
    const anyProfit = opts.some((o) => o.profit != null && o.profit >= 0);
    const score = (o) => {
      let v = 0;
      if (o.profit != null) v += o.profit >= 0 ? 100 : -100;
      if (useModel && o.pred) v -= o.pred.mean * 1000;            // sell the weakest expected stock
      if (settings.parkStock && o.s.acr === settings.parkStock.toUpperCase()) v += useModel ? 1 : 5;
      v += Math.min(useModel ? 1 : 5, (o.spare * o.price) / Math.max(amount, 1));
      return v;
    };
    const mode = useModel ? 'model' : 'simple';
    const clean = opts.filter((o) => o.fits && !o.breaks).sort((a, b) => score(b) - score(a));
    if (clean.length) return { legs: [clean[0]], alts: clean.slice(1, 4), mode, anyProfit };
    const totalSpare = opts.reduce((a, o) => a + Math.max(0, o.spare) * o.price * (1 - FEE), 0);
    if (totalSpare >= amount) {
      const legs = []; let left = amount;
      for (const o of opts.filter((o) => o.spare > 0).sort((a, b) => score(b) - score(a))) {
        if (left <= 0) break;
        const sh = Math.min(o.spare, Math.ceil((left * buf) / (o.price * (1 - FEE))));
        legs.push(Object.assign({}, o, { shares: sh, breaks: false, cap: o.spare }));
        left -= sh * o.price * (1 - FEE);
      }
      return { legs, alts: [], mode: 'split', anyProfit };
    }
    const breaking = opts.filter((o) => o.fits).sort((a, b) => score(b) - score(a));
    if (breaking.length) return { legs: [breaking[0]], alts: breaking.slice(1, 4), mode: 'breaks', anyProfit };
    const all = opts.reduce((a, o) => a + o.owned * o.price * (1 - FEE), 0);
    return { error: `You asked for ${money(amount)}, but all your shares are worth about ${money(all)} after fees.` };
  }

  function planDeposit(cash, an, user) {
    const avail = cash - settings.keepOnHand;
    if (avail <= 0) return { error: `Nothing to deposit. You have ${money(cash)} on hand and keep ${money(settings.keepOnHand)}.` };
    const buf = 1 + settings.bufferPct / 100;
    const L = liveStocks(an, user);
    const useModel = modelUsable(an);
    const park = settings.parkStock.toUpperCase();
    let total = cash; for (const x of Object.values(L)) total += x.owned * x.price;
    const opts = [];
    for (const x of Object.values(L)) {
      if (!x.allowed) continue;
      if (settings.depositOwnedOnly && !x.owned && x.s.acr !== park) continue;
      if (!useModel && !x.owned && x.s.acr !== park) continue;
      const shares = Math.floor(avail / (x.price * buf));
      if (shares < 1) continue;
      const target = Core.nextBlockTarget(x.s.benefit, x.owned);
      const completes = target != null && x.owned < target && x.owned + shares >= target;
      const overweight = (x.owned * x.price + shares * x.price) / total > settings.maxWeightPct / 100;
      opts.push(Object.assign({}, x, { shares, completes, overweight }));
    }
    const score = (o) => {
      let v = 0;
      if (useModel && o.pred) v += o.pred.mean * 1000;
      if (o.overweight) v -= 50;
      if (o.completes) v += useModel ? 2 : 6;
      if (park && o.s.acr === park) v += useModel ? 1 : 5;
      v += Math.min(3, Math.log10(1 + (o.owned * o.price) / 1e6) / 2);
      return v;
    };
    opts.sort((a, b) => score(b) - score(a));
    // A "good buy": the model expects it to rise and it won't overweight you.
    // Without a validated model there's no way to judge, so every option counts.
    for (const o of opts) o.good = !useModel || (!!o.pred && o.pred.mean > 0 && !o.overweight);
    if (opts.length && !opts.some((o) => o.good)) return { noGood: true, best: opts[0], alts: opts.slice(1, 4), avail, mode: 'model' };
    if (opts.length && !opts[0].good) opts.sort((a, b) => (b.good - a.good) || (score(b) - score(a)));
    if (!opts.length) return { tooSmall: useModel || Object.values(L).some((x) => x.allowed && (x.owned || x.s.acr === park)), error: useModel ? `${money(avail)} isn't enough to buy one share of an allowed stock.` : 'No stock to deposit into yet. Set a parking stock in Market → Settings, or wait for the model to finish learning.' };
    return { legs: [opts[0]], alts: opts.slice(1, 4), mode: useModel ? 'model' : 'simple', avail };
  }

  function quickReason(o, action, mode) {
    if (mode === 'model' && o.pred) {
      return `${o.s.acr} has the ${action === 'sell' ? 'weakest' : 'strongest'} expected ${hLabel(A ? A.h : 24)} return of your options (${pct(o.pred.mean)}), at ${Math.abs(o.z).toFixed(1)} std ${o.z >= 0 ? 'above' : 'below'} its normal price.`;
    }
    if (settings.parkStock && o.s.acr === settings.parkStock.toUpperCase()) return `${o.s.acr} is your parking stock.`;
    return action === 'sell'
      ? `${o.s.acr} has the most spare shares. (The model is still learning, so this uses a simple rule.)`
      : `${o.s.acr} is your largest holding. (The model is still learning, so this uses a simple rule.)`;
  }

  // =====================================================================
  //  UI
  // =====================================================================
  const CSS = `
  #tmm-root{--bg:#1d2629;--bg2:#27353a;--line:#3a4c52;--ink:#e9eef0;--muted:#aebdc3;--head:#ffffff;--pos:#4cc47c;--neg:#ff7a7a;--warn:#f0b04a;--field:#121a1d;--brass:#d4ac2b;--onbrass:#1b1b1b;--shadow:rgba(0,0,0,.5);--you:#b88d10;--mkt:#4f86d9;
    font:14px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink)}
  #tmm-root[data-theme=light]{--bg:#ffffff;--bg2:#f1f4f6;--line:#cfd8dc;--ink:#1d2629;--muted:#4f5f66;--head:#0f1416;--pos:#1b7f45;--neg:#b8322a;--warn:#9a5c00;--field:#ffffff;--brass:#c9a227;--onbrass:#1b1b1b;--shadow:rgba(0,0,0,.2);--you:#9a7300;--mkt:#3f6aa8}
  #tmm-root *{box-sizing:border-box;color:inherit;font-family:inherit}
  #tmm-root .tmm-moon{position:fixed;z-index:99998;width:46px;height:46px;border-radius:50%;border:0;padding:0;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;
    background:radial-gradient(circle at 35% 30%,#33497a,#121a30 72%);box-shadow:0 3px 12px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.14);display:grid;place-items:center}
  #tmm-root .tmm-moon svg{width:30px;height:30px;pointer-events:none}
  #tmm-root .tmm-moon.dragging{opacity:.85;box-shadow:0 8px 20px rgba(0,0,0,.5)}
  #tmm-root .tmm-dot{position:absolute;width:14px;height:14px;border-radius:50%;border:2px solid #121a30;display:none}
  #tmm-root .tmm-dot.opp{top:-2px;right:-2px;background:#3fd17a}
  #tmm-root .tmm-dot.cash{bottom:-2px;left:-2px;background:#ff9a2e}
  #tmm-root .tmm-moon.has-opp .tmm-dot.opp,#tmm-root .tmm-moon.has-cash .tmm-dot.cash{display:block}
  #tmm-root .tmm-menu{position:fixed;z-index:99998;display:flex;flex-direction:column;gap:6px}
  #tmm-root .tmm-menu[hidden]{display:none}
  #tmm-root .tmm-mi-note{font-weight:400;font-size:12px;opacity:.9;margin-left:6px}
  #tmm-root .tmm-mi{border:0;border-radius:20px;padding:10px 15px;font-weight:600;font-size:14px;line-height:1;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap;text-align:left}
  #tmm-root .tmm-mi.m{background:#2c3e66} #tmm-root .tmm-mi.w{background:#2a8450} #tmm-root .tmm-mi.d{background:#2f6d9c}
  #tmm-root .tmm-mi:focus-visible,#tmm-root .tmm-moon:focus-visible,#tmm-root button:focus-visible{outline:2px solid var(--brass);outline-offset:2px}
  #tmm-root .tmm-sheet{position:fixed;z-index:99999;left:0;right:0;bottom:0;background:var(--bg);color:var(--ink);border-top:3px solid var(--brass);border-radius:14px 14px 0 0;
    padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 16px);max-height:82vh;overflow:auto;box-shadow:0 -6px 24px var(--shadow)}
  #tmm-root h3{margin:0 0 8px;font-size:17px;color:var(--head)}
  #tmm-root h4{margin:14px 0 6px;font-size:14px;color:var(--brass)}
  #tmm-root .tmm-big{font-size:21px;font-weight:700;color:var(--head);margin:2px 0}
  #tmm-root .tmm-sub{color:var(--muted);margin:2px 0 6px}
  #tmm-root .tmm-card{background:var(--bg2);border-radius:10px;padding:12px;margin:10px 0}
  #tmm-root .tmm-card.opp{border-left:4px solid var(--brass)}
  #tmm-root .tmm-why{margin:6px 0 0;padding-left:18px} #tmm-root .tmm-why li{margin:3px 0;color:var(--ink)}
  #tmm-root .tmm-warn{color:var(--warn);font-weight:600;margin:6px 0} #tmm-root .tmm-err{color:var(--neg);font-weight:600;margin:6px 0} #tmm-root .tmm-ok{color:var(--pos);font-weight:600;margin:6px 0}
  #tmm-root .tmm-status{margin:10px 0;padding:10px;border-left:3px solid var(--brass);background:var(--bg2);color:var(--ink)}
  #tmm-root .tmm-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center}
  #tmm-root .tmm-chip{background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:16px;padding:7px 12px;font-size:14px;cursor:pointer}
  #tmm-root .tmm-input{width:100%;font-size:20px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--field);color:var(--ink)}
  #tmm-root .tmm-act{background:var(--brass);color:var(--onbrass);border:0;border-radius:8px;padding:11px 16px;font-weight:700;font-size:15px;line-height:1;cursor:pointer}
  #tmm-root .tmm-plain{background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:10px 14px;font-size:14px;cursor:pointer}
  #tmm-root .tmm-tabs{display:flex;gap:4px;margin:-2px 0 8px;border-bottom:1px solid var(--line)}
  #tmm-root .tmm-tab{background:none;border:0;color:var(--muted);padding:8px 12px;font-weight:600;font-size:14px;cursor:pointer;border-bottom:2px solid transparent}
  #tmm-root .tmm-tab[aria-selected=true]{color:var(--head);border-bottom-color:var(--brass)}
  #tmm-root .tmm-kpis{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}
  #tmm-root .tmm-kpis b{display:block;font-size:17px;color:var(--head)} #tmm-root .tmm-kpis span{color:var(--muted);font-size:12px}
  #tmm-root .tmm-tbl{width:100%;border-collapse:collapse;font-size:12.5px;background:transparent}
  #tmm-root .tmm-tbl th,#tmm-root .tmm-tbl td{padding:4px 6px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap;color:var(--ink);background:transparent}
  #tmm-root .tmm-tbl th:first-child,#tmm-root .tmm-tbl td:first-child{text-align:left} #tmm-root .tmm-tbl th{color:var(--muted);font-weight:600}
  #tmm-root .tmm-scroll{overflow-x:auto}
  #tmm-root .tmm-field{margin:9px 0} #tmm-root .tmm-field label{display:block;color:var(--muted);margin-bottom:3px}
  #tmm-root .tmm-field input[type=text]{width:100%;padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--field);color:var(--ink);font-size:15px}
  #tmm-root .tmm-check{display:flex;gap:8px;align-items:center;margin:8px 0;color:var(--ink)}
  #tmm-root .tmm-pos,#tmm-root .tmm-tbl td.tmm-pos,#tmm-root .tmm-kpis b.tmm-pos{color:var(--pos)} #tmm-root .tmm-neg,#tmm-root .tmm-tbl td.tmm-neg,#tmm-root .tmm-kpis b.tmm-neg{color:var(--neg)}
  #tmm-root .tmm-chart-wrap{position:relative}
  #tmm-root .tmm-chart{display:block;width:100%;height:auto;touch-action:pan-y}
  #tmm-root .tmm-c-grid{stroke:var(--line);stroke-width:1}
  #tmm-root .tmm-c-zero{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
  #tmm-root .tmm-c-ax{fill:var(--muted);font-size:10px}
  #tmm-root .tmm-c-lab{fill:var(--ink);font-size:10px;font-weight:600}
  #tmm-root .tmm-c-you{fill:none;stroke:var(--you);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  #tmm-root .tmm-c-mkt{fill:none;stroke:var(--mkt);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;stroke-dasharray:5 3}
  #tmm-root .tmm-c-x{stroke:var(--muted);stroke-width:1}
  #tmm-root .tmm-c-tip{position:absolute;top:0;width:120px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font-size:12px;line-height:1.35;pointer-events:none;box-shadow:0 2px 8px var(--shadow)}
  #tmm-root .tmm-c-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin-top:4px}
  #tmm-root .tmm-c-sw{display:inline-block;width:14px;height:0;border-top:2px solid var(--you);vertical-align:middle;margin-right:5px}
  #tmm-root .tmm-c-sw.mkt{border-top:2px dashed var(--mkt)}
  #tmm-root .tmm-chip[aria-pressed=true]{border-color:var(--brass);color:var(--head);font-weight:600}
  #tmm-root .tmm-spark{display:block;width:100%;height:34px;margin-top:4px}
  #tmm-root .tmm-pill{position:fixed;z-index:99999;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 8px);max-width:calc(100vw - 20px);
    background:var(--bg);color:var(--ink);border:1px solid var(--brass);border-radius:20px;padding:6px 6px 6px 12px;box-shadow:0 3px 12px var(--shadow);display:flex;gap:6px;align-items:center;font-size:13px;font-weight:600}
  #tmm-root .tmm-pill.card{display:block;border-radius:14px;padding:6px 6px 8px 12px;width:calc(100vw - 20px);max-width:520px}
  #tmm-root .tmm-pill-row{display:flex;gap:6px;align-items:center}
  #tmm-root .tmm-pill-row .tmm-pill-t{flex:1}
  #tmm-root .tmm-pill-info{margin:4px 6px 0 0;padding-left:16px;font-weight:400;font-size:12.5px;line-height:1.35;color:var(--muted)}
  #tmm-root .tmm-pill-info li{margin:2px 0}
  #tmm-root .tmm-pill.ok{border-color:var(--pos)} #tmm-root .tmm-pill.ok .tmm-pill-t{color:var(--pos)}
  #tmm-root .tmm-pill-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  #tmm-root .tmm-pill button{white-space:nowrap}
  #tmm-root .tmm-pill button.tmm-pill-go{background:var(--brass);color:var(--onbrass);font-weight:700}
  #tmm-root .tmm-pill button{background:var(--bg2);border:0;border-radius:14px;cursor:pointer;font-size:12px;padding:5px 9px;color:var(--ink)}
  .tmm-backhint{outline:3px solid #c9a227 !important;outline-offset:3px;box-shadow:0 0 0 6px rgba(201,162,39,.35) !important}
  input.tmm-filled{outline:3px solid #c9a227 !important;outline-offset:2px;background:#fff8dc !important;color:#000 !important}
  @media (prefers-reduced-motion:no-preference){#tmm-root .tmm-sheet{animation:tmmUp .18s ease-out}}
  @keyframes tmmUp{from{transform:translateY(30px);opacity:.4}to{transform:none;opacity:1}}`;

  const MOON_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><mask id="tmm-cres"><rect width="32" height="32" fill="#fff"/><circle cx="21" cy="12" r="10" fill="#000"/></mask></defs>
    <circle cx="15" cy="16" r="11" fill="#f3e7b5" mask="url(#tmm-cres)"/>
    <circle cx="10" cy="19.5" r="1.7" fill="#d8c584"/><circle cx="12.6" cy="24.2" r="1.1" fill="#d8c584"/><circle cx="7.4" cy="13.6" r="1.1" fill="#d8c584"/>
    <circle cx="25.5" cy="23" r=".9" fill="#fff"/><circle cx="27" cy="8.5" r=".7" fill="#fff"/></svg>`;

  let root, sheet, pill = null, moon, menu, watchTimer = null;
  const MOON = 46, EDGE_GAP = 6;

  const isDark = () => document.body.classList.contains('dark-mode') || document.documentElement.classList.contains('dark-mode');
  function applyTheme() { if (root) root.dataset.theme = isDark() ? 'dark' : 'light'; }

  function mountUI() {
    if (document.getElementById('tmm-root')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.id = 'tmm-root';
    root.innerHTML = `
      <button class="tmm-moon" aria-label="Moonshine Asset Manager menu" aria-expanded="false">${MOON_SVG}<i class="tmm-dot opp"></i><i class="tmm-dot cash"></i></button>
      <div class="tmm-menu" hidden>
        <button class="tmm-mi m" data-a="market">Market<span class="tmm-mi-note" data-note="opp"></span></button>
        <button class="tmm-mi w" data-a="withdraw">Withdraw</button>
        <button class="tmm-mi d" data-a="deposit">Deposit<span class="tmm-mi-note" data-note="cash"></span></button>
      </div>`;
    document.body.appendChild(root);
    moon = $('.tmm-moon', root);
    menu = $('.tmm-menu', root);
    applyTheme();
    new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    placeMoon();
    window.addEventListener('resize', () => { placeMoon(); if (!menu.hidden) positionMenu(); });

    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      hideMenu();
      ({ market: () => showMarket('overview'), withdraw: askWithdraw, deposit: () => runJob({ action: 'deposit' }) })[b.dataset.a]();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !moon.contains(e.target)) hideMenu();
    }, true);

    // Drag the moon anywhere; it snaps to the nearest screen edge.
    let drag = null;
    moon.addEventListener('pointerdown', (e) => {
      drag = { x0: e.clientX, y0: e.clientY, moved: false };
      try { moon.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    moon.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      if (!drag.moved) { drag.moved = true; moon.classList.add('dragging'); hideMenu(); }
      moon.style.left = (e.clientX - MOON / 2) + 'px';
      moon.style.top = (e.clientY - MOON / 2) + 'px';
      e.preventDefault();
    });
    moon.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      moon.classList.remove('dragging');
      if (moved) snapMoon(e.clientX, e.clientY);
      else if (menu.hidden) showMenu(); else hideMenu();
    });
    moon.addEventListener('pointercancel', () => { if (drag && drag.moved) placeMoon(); drag = null; moon.classList.remove('dragging'); });
    moon.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.hidden) showMenu(); else hideMenu(); } });
  }

  const dockPos = () => store.get('dock', { edge: 'right', pos: 0.72 });
  function placeMoon() {
    const d = dockPos(), W = window.innerWidth, H = window.innerHeight;
    const along = (len) => EDGE_GAP + Math.min(1, Math.max(0, d.pos)) * (len - MOON - 2 * EDGE_GAP);
    let x, y;
    if (d.edge === 'left') { x = EDGE_GAP; y = along(H); }
    else if (d.edge === 'top') { x = along(W); y = EDGE_GAP; }
    else if (d.edge === 'bottom') { x = along(W); y = H - MOON - EDGE_GAP; }
    else { x = W - MOON - EDGE_GAP; y = along(H); }
    moon.style.left = x + 'px';
    moon.style.top = y + 'px';
  }
  function snapMoon(cx, cy) {
    const W = window.innerWidth, H = window.innerHeight;
    const dist = { left: cx, right: W - cx, top: cy, bottom: H - cy };
    const edge = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
    const pos = edge === 'left' || edge === 'right'
      ? (cy - MOON / 2 - EDGE_GAP) / (H - MOON - 2 * EDGE_GAP)
      : (cx - MOON / 2 - EDGE_GAP) / (W - MOON - 2 * EDGE_GAP);
    store.set('dock', { edge, pos: Math.min(1, Math.max(0, pos)) });
    placeMoon();
  }
  function positionMenu() {
    const d = dockPos(), r = moon.getBoundingClientRect(), m = menu.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    let x, y;
    if (d.edge === 'left') { x = r.right + 8; y = r.top + r.height / 2 - m.height / 2; }
    else if (d.edge === 'top') { x = r.left + r.width / 2 - m.width / 2; y = r.bottom + 8; }
    else if (d.edge === 'bottom') { x = r.left + r.width / 2 - m.width / 2; y = r.top - 8 - m.height; }
    else { x = r.left - 8 - m.width; y = r.top + r.height / 2 - m.height / 2; }
    menu.style.left = Math.min(W - m.width - 6, Math.max(6, x)) + 'px';
    menu.style.top = Math.min(H - m.height - 6, Math.max(6, y)) + 'px';
    menu.style.alignItems = d.edge === 'right' ? 'flex-end' : 'flex-start';
  }
  function showMenu() { menu.hidden = false; positionMenu(); moon.setAttribute('aria-expanded', 'true'); }
  function hideMenu() { if (menu) menu.hidden = true; if (moon) moon.setAttribute('aria-expanded', 'false'); }

  function openSheet(html) {
    closeSheet();
    hideMenu();
    sheet = document.createElement('div');
    sheet.className = 'tmm-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.innerHTML = html;
    root.appendChild(sheet);
    return sheet;
  }
  function closeSheet() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (sheet) sheet.remove();
    if (pill) pill.remove();
    sheet = null; pill = null;
  }

  // Collapsed state: the sheet hides and a small status pill stays at the top.
  function showPill(text, cls = '', extra = null, info = null) {
    if (pill) pill.remove();
    const extras = (Array.isArray(extra) ? extra : extra ? [extra] : []).filter(Boolean);
    pill = document.createElement('div');
    const infoLines = (info || []).filter(Boolean);
    pill.className = 'tmm-pill ' + cls + (infoLines.length ? ' card' : '');
    pill.setAttribute('role', 'status');
    const row = `<span class="tmm-pill-t">${esc(text)}</span>${extras.map((x, i) => `<button data-p="extra" data-i="${i}" class="${i ? '' : 'tmm-pill-go'}">${esc(x.label)}</button>`).join('')}${sheet ? '<button data-p="open">Details</button>' : ''}<button data-p="x" aria-label="Close">✕</button>`;
    pill.innerHTML = infoLines.length
      ? `<div class="tmm-pill-row">${row}</div><ul class="tmm-pill-info">${infoLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      : row;
    pill.addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (b && b.dataset.p === 'x') return closeSheet();
      if (b && b.dataset.p === 'extra') return extras[Number(b.dataset.i)].fn();
      if (b && b.dataset.p === 'open') expandSheet();
    });
    root.appendChild(pill);
  }
  function minimizeSheet(text, extras = null, info = null) { if (!sheet) return; sheet.style.display = 'none'; showPill(text, '', extras, info); }
  function expandSheet() { if (sheet) sheet.style.display = ''; if (pill) { pill.remove(); pill = null; } }
  function updatePill(text) { const t = pill && pill.querySelector('.tmm-pill-t'); if (t) t.textContent = text; }

  function spark(an, sid) {
    const s = an.S[sid];
    if (!s) return '';
    const from = Math.max(0, s.n - 720);
    const pts = []; let lo = Infinity, hi = -Infinity;
    for (let i = from; i < s.n; i += 4) { lo = Math.min(lo, s.lp[i]); hi = Math.max(hi, s.lp[i]); pts.push(s.lp[i]); }
    if (pts.length < 2 || hi === lo) return '';
    const W = 300, Hh = 34;
    const d = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(Hh - 2 - (v - lo) / (hi - lo) * (Hh - 4)).toFixed(1)}`).join(' ');
    return `<svg class="tmm-spark" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-label="${esc(an.market.stocks[sid].acr)} last 30 days"><polyline fill="none" stroke="#c9a227" stroke-width="1.5" points="${d}"/></svg>`;
  }

  // ------------------------------------------------------------ performance
  // Measures how your stocks grew, ignoring money you add or take out.
  // Each hour's change is priced from the shares you held at the start of
  // that hour, then chained together (a "time-weighted" return). The market
  // line does the same for an equal mix of every stock.
  function perfSeries(an, snaps) {
    const S = an.S;
    const px = (sid, t) => { const s = S[sid]; if (!s) return NaN; const i = Core.idxAt(s, t); return i < 0 ? NaN : Math.exp(s.lp[i]); };
    const pts = [];
    if (!snaps.length) return pts;
    let you = 1, mkt = 1;
    pts.push({ t: snaps[0].t, you: 0, mkt: 0 });
    for (let k = 1; k < snaps.length; k++) {
      const a = snaps[k - 1], b = snaps[k];
      let v0 = 0, v1 = 0;
      for (const [sid, n] of Object.entries(a.holdings || {})) {
        const p0 = px(sid, a.t), p1 = px(sid, b.t);
        if (p0 > 0 && p1 > 0) { v0 += n * p0; v1 += n * p1; }
      }
      if (v0 > 0) you *= v1 / v0;
      let sum = 0, cnt = 0;
      for (const sid of Object.keys(S)) {
        const p0 = px(sid, a.t), p1 = px(sid, b.t);
        if (p0 > 0 && p1 > 0) { sum += p1 / p0; cnt++; }
      }
      if (cnt) mkt *= sum / cnt;
      pts.push({ t: b.t, you: you - 1, mkt: mkt - 1 });
    }
    return pts;
  }

  function rebase(pts, fromT) {
    const sub = pts.filter((p) => p.t >= fromT);
    if (sub.length < 2) return sub;
    const y0 = 1 + sub[0].you, m0 = 1 + sub[0].mkt;
    return sub.map((p) => ({ t: p.t, you: (1 + p.you) / y0 - 1, mkt: (1 + p.mkt) / m0 - 1 }));
  }

  function perfChart(pts) {
    if (pts.length < 2) return '<div class="tmm-sub">Not enough history in this range yet. Snapshots are saved hourly while Torn is open.</div>';
    const W = 320, H = 150, L = 40, R = 46, T = 8, B = 20;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let lo = 0, hi = 0;
    for (const p of pts) { lo = Math.min(lo, p.you, p.mkt); hi = Math.max(hi, p.you, p.mkt); }
    if (hi - lo < 0.002) { hi += 0.001; lo -= 0.001; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (t) => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R);
    const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
    const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
    const ticks = [lo + pad, 0, hi - pad].filter((v, i, a) => a.findIndex((w) => Math.abs(w - v) < (hi - lo) * 0.12) === i);
    const fmtD = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const last = pts[pts.length - 1];
    let ly = y(last.you), lm = y(last.mkt);
    if (Math.abs(ly - lm) < 12) { if (ly <= lm) { ly -= 6; lm += 6; } else { ly += 6; lm -= 6; } }
    return `<div class="tmm-chart-wrap"><svg class="tmm-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your stocks ${pctPlain(last.you, 2)} vs market ${pctPlain(last.mkt, 2)} over this range">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${Math.abs(v) < 1e-12 ? 'tmm-c-zero' : 'tmm-c-grid'}"/><text x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="tmm-c-ax">${pctPlain(v, Math.abs(hi - lo) < 0.02 ? 2 : 1)}</text>`).join('')}
      <text x="${L}" y="${H - 5}" class="tmm-c-ax">${fmtD(t0)}</text><text x="${W - R}" y="${H - 5}" text-anchor="end" class="tmm-c-ax">${fmtD(t1)}</text>
      <path d="${line('mkt')}" class="tmm-c-mkt"/><path d="${line('you')}" class="tmm-c-you"/>
      <text x="${W - R + 4}" y="${(ly + 3).toFixed(1)}" class="tmm-c-lab">You</text>
      <text x="${W - R + 4}" y="${(lm + 3).toFixed(1)}" class="tmm-c-lab tmm-c-lab2">Market</text>
      <line class="tmm-c-x" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="tmm-c-hit"/>
    </svg><div class="tmm-c-tip" hidden></div></div>
    <div class="tmm-c-legend"><span><i class="tmm-c-sw you"></i>Your stocks</span><span><i class="tmm-c-sw mkt"></i>Market (all stocks, equal mix)</span></div>`;
  }

  function wireChart(box, pts) {
    const svg = $('.tmm-chart', box), tip = $('.tmm-c-tip', box), hit = $('.tmm-c-hit', svg), xl = $('.tmm-c-x', svg);
    if (!svg || pts.length < 2) return;
    const vb = svg.viewBox.baseVal, L = 40, R = 46, t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const show = (e) => {
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) / r.width * vb.width;
      const tt = t0 + (sx - L) / (vb.width - L - R) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
      const px = L + (best.t - t0) / Math.max(1, t1 - t0) * (vb.width - L - R);
      xl.setAttribute('x1', px); xl.setAttribute('x2', px); xl.setAttribute('visibility', 'visible');
      const d = new Date(best.t * 1000);
      tip.innerHTML = `<b>${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric' })}</b><br>You ${pctPlain(best.you, 2)}<br>Market ${pctPlain(best.mkt, 2)}`;
      tip.hidden = false;
      const left = px / vb.width * r.width;
      tip.style.left = Math.min(r.width - 120, Math.max(0, left - 60)) + 'px';
    };
    const hide = () => { tip.hidden = true; xl.setAttribute('visibility', 'hidden'); };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
  }

  async function perfCard(an) {
    const snaps = (await DB.all('snapshots')).sort((a, b) => a.t - b.t);
    const pts = perfSeries(an, snaps);
    const execs = await DB.all('executions');
    const rotSells = execs.filter((e) => e.kind === 'rotation' && e.action === 'sell').length;
    const nowS = Math.floor(Date.now() / 1000);
    const ranges = { '1D': nowS - 86400, '7D': nowS - 7 * 86400, '30D': nowS - 30 * 86400, All: 0 };
    let sel = store.get('perfRange', '7D');
    if (!(sel in ranges)) sel = '7D';
    const open = store.get('perfOpen', false);
    const sum = (from) => { const r = rebase(pts, from); const l = r[r.length - 1]; return r.length >= 2 ? l : null; };
    const all = sum(0), day = sum(ranges['1D']);
    const kp = (v) => v == null ? '<b>—</b>' : `<b class="${v >= 0 ? 'tmm-pos' : 'tmm-neg'}">${pctPlain(v, 2)}</b>`;
    const edge = all ? (1 + all.you) / (1 + all.mkt) - 1 : null;
    const since = pts.length ? new Date(pts[0].t * 1000).toLocaleDateString() : '';
    const html = `<div class="tmm-card" id="tmm-perf">
      <div class="tmm-kpis">
        <div>${kp(day && day.you)}<span>Your stocks, last 24h</span></div>
        <div>${kp(all && all.you)}<span>Your stocks${since ? ', since ' + since : ''}</span></div>
        <div>${kp(all && all.mkt)}<span>Market, same period</span></div>
        <div>${kp(edge)}<span>You vs market</span></div>
      </div>
      <div class="tmm-row"><button class="tmm-plain" id="tmm-perf-tog" aria-expanded="${open}">${open ? 'Hide chart' : 'Show growth chart'}</button>${rotSells ? `<span class="tmm-sub">${rotSells} rotation trade${rotSells > 1 ? 's' : ''} made</span>` : ''}</div>
      <div id="tmm-perf-body" ${open ? '' : 'hidden'}>
        <div class="tmm-row" role="group" aria-label="Range">${Object.keys(ranges).map((k) => `<button class="tmm-chip" data-rng="${k}" aria-pressed="${k === sel}">${k}</button>`).join('')}</div>
        <div id="tmm-perf-chart"></div>
        <div class="tmm-sub">Growth of the shares you held, ignoring cash you add or take out. Above the market line means your picks and trades are beating just holding everything.</div>
      </div></div>`;
    const wire = (box) => {
      const draw = () => { const c = $('#tmm-perf-chart', box); const r = rebase(pts, ranges[sel]); c.innerHTML = perfChart(r); wireChart(c, r); };
      $('#tmm-perf-tog', box).onclick = (e) => {
        const b = $('#tmm-perf-body', box); b.hidden = !b.hidden;
        store.set('perfOpen', !b.hidden);
        e.currentTarget.textContent = b.hidden ? 'Show growth chart' : 'Hide chart';
        e.currentTarget.setAttribute('aria-expanded', String(!b.hidden));
        if (!b.hidden) draw();
      };
      $$('[data-rng]', box).forEach((btn) => (btn.onclick = () => {
        sel = btn.dataset.rng; store.set('perfRange', sel);
        $$('[data-rng]', box).forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
        draw();
      }));
      if (open) draw();
    };
    return { html, wire };
  }

  // ------------------------------------------------------------ Market panel
  async function showMarket(tab = 'overview') {
    const s = openSheet(`
      <div class="tmm-tabs" role="tablist">
        <button class="tmm-tab" role="tab" data-tab="overview" aria-selected="${tab === 'overview'}">Overview</button>
        <button class="tmm-tab" role="tab" data-tab="details" aria-selected="${tab === 'details'}">Details</button>
        <button class="tmm-tab" role="tab" data-tab="settings" aria-selected="${tab === 'settings'}">Settings</button>
        <button class="tmm-plain" id="tmm-x" style="margin-left:auto;padding:6px 10px">Close</button>
      </div>
      <div id="tmm-body"><div class="tmm-sub">Loading…</div></div>`);
    $('#tmm-x', s).onclick = closeSheet;
    $$('[data-tab]', s).forEach((b) => (b.onclick = () => showMarket(b.dataset.tab)));
    const body = $('#tmm-body', s);
    try {
      if (tab === 'settings') return renderSettings(body);
      if (!apiKey()) { body.innerHTML = `<div class="tmm-err">Add your Torn API key in Settings first.</div>`; return; }
      const [an, user] = await Promise.all([analyze(), getUser(20)]);
      if (!sheet || !document.body.contains(body)) return;
      if (tab === 'details') return renderDetails(body, an, user);
      return renderOverview(body, an, user);
    } catch (e) {
      body.innerHTML = `<div class="tmm-err">${esc(e.message || e)}</div>`;
    }
  }

  async function renderOverview(body, an, user) {
    const cash = domCash() ?? user.cash;
    let { rot, L, total } = an.market ? findOpportunity(an, user, cash) : { rot: null, L: {}, total: cash };
    const skip = store.get('skip', null);
    if (rot && skip && skip.k === rot.sell + '>' + rot.buy && Date.now() < skip.until) rot = null;
    const perf = await perfCard(an);
    const stale = !an.market || Date.now() - an.market.t > 5 * 60000;
    let card;
    if (stale) {
      card = `<div class="tmm-card"><div class="tmm-big">Data stale — no recommendation</div><div class="tmm-sub">Couldn't get fresh prices from Torn. Check your connection and reopen.</div></div>`;
    } else if (!an.model || (an.val && an.val.ok === false && an.val.reason && an.val.reason.startsWith('Need'))) {
      card = `<div class="tmm-card"><div class="tmm-big">Learning the market</div>
        <div class="tmm-sub">${esc(an.val && an.val.reason ? an.val.reason : 'Downloading price history.')}</div>
        <div class="tmm-sub">${esc(sync.status || 'History download starts automatically while Torn is open.')}</div>
        <div class="tmm-sub">Withdraw and Deposit work now with simple rules.</div></div>`;
    } else if (!an.validated && !settings.showUnvalidated) {
      card = `<div class="tmm-card"><div class="tmm-big">No action</div>
        <div class="tmm-sub">The model did not beat buy-and-hold reliably on the ${an.val ? an.val.testDays : '?'} days of data it hadn't seen, so it isn't recommending trades. See Details for the test results.</div></div>`;
    } else if (!rot) {
      const near = Core.bestRotation(L, { totalValue: total, minEdge: -1, tMin: -99, maxWeight: settings.maxWeightPct / 100, minTrade: 0 });
      const nearTxt = near
        ? `Closest idea: sell ${esc(L[near.sell].s.acr)} → buy ${esc(L[near.buy].s.acr)}, ${pct(near.adv)} after the fee (needs ${settings.minEdgePct}%), evidence ${near.t.toFixed(1)}× (needs ${settings.evidenceT}×).`
        : 'No spare shares above your benefit blocks to rotate.';
      card = `<div class="tmm-card"><div class="tmm-big">No action</div>
        <div class="tmm-sub">Nothing clears the bar right now. ${nearTxt}</div>
        <div class="tmm-sub">Checked ${new Date(an.t).toLocaleTimeString()}.</div></div>`;
    } else {
      const ev = evidence(rot, L);
      await logDecision(an, rot, L, 'shown');
      card = `<div class="tmm-card opp">
        <div class="tmm-sub">Opportunity${an.validated ? '' : ' (model not validated)'}</div>
        <div class="tmm-big">Sell ${money(rot.amount)} of ${esc(L[rot.sell].s.acr)}</div>${spark(an, rot.sell)}
        <div class="tmm-big">Buy ${esc(L[rot.buy].s.acr)}</div>${spark(an, rot.buy)}
        <div class="tmm-kpis" style="margin-top:8px"><div><b class="tmm-pos">${pct(rot.adv)}</b><span>Estimated net advantage over ${hLabel(an.h)}</span></div><div><b>${ev}</b><span>Evidence</span></div></div>
        <ul class="tmm-why">${whyLines(an, rot, L).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <div class="tmm-row"><button class="tmm-act" id="tmm-sell">Confirm sell</button><button class="tmm-plain" id="tmm-skip">Skip</button></div></div>`;
    }
    const pocket = cash > settings.keepOnHand + 1000
      ? `<div class="tmm-card"><div class="tmm-warn">You're carrying ${money(cash)} in cash.</div><div class="tmm-row"><button class="tmm-act" id="tmm-dep">Deposit it into stocks</button></div></div>` : '';
    body.innerHTML = `
      <div class="tmm-kpis">
        <div><b>${money(total)}</b><span>Portfolio (stocks + cash)</span></div>
        <div><b>${money(cash)}</b><span>Cash on hand</span></div>
      </div>
      ${updateInfo() ? `<div class="tmm-card opp"><b>Update available: v${esc(updateInfo().latest)}</b> <span class="tmm-sub">(you have v${SCRIPT_VERSION})</span>
        <div class="tmm-row"><button class="tmm-act" id="tmm-upd">Update now</button><button class="tmm-plain" id="tmm-upd-notes">What's new</button></div></div>` : ''}
      ${pocket}${card}${perf.html}
      <div class="tmm-sub">Model: ${esc(MODEL_VERSION)} · ${an.validated ? `validated on ${hLabel(an.h)} horizon` : 'not validated'}${an.regime ? ' · market: ' + esc(an.regime.label) : ''}</div>`;
    const dep = $('#tmm-dep', body); if (dep) dep.onclick = () => runJob({ action: 'deposit' });
    const pc = $('#tmm-perf', body); if (pc) perf.wire(pc);
    const ub = $('#tmm-upd', body); if (ub) ub.onclick = installUpdate;
    const un = $('#tmm-upd-notes', body); if (un) un.onclick = () => window.open(REPO_PAGE, '_blank');
    if (rot && $('#tmm-sell', body)) {
      $('#tmm-sell', body).onclick = async () => {
        const id = await logDecision(an, rot, L, 'confirmed');
        runJob({ action: 'rotate', stage: 'sell', sell: rot.sell, buy: rot.buy, shares: rot.sellShares, decisionId: id });
      };
      $('#tmm-skip', body).onclick = async () => {
        await logDecision(an, rot, L, 'skipped');
        store.set('skip', { k: rot.sell + '>' + rot.buy, until: Date.now() + 3 * 3600000 });
        closeSheet();
      };
    }
  }

  async function renderDetails(body, an, user) {
    const v = an.val;
    let html = '';
    html += `<h4>Did the model work on data it hadn't seen?</h4>`;
    if (!v || !v.horizons) html += `<div class="tmm-sub">${esc((v && v.reason) || 'Not enough history yet.')}</div>`;
    else {
      html += `<div class="tmm-sub">Trained on the first 70% of history, tested on the last ${v.testDays} days. ${v.ok ? 'Passed.' : 'Did not pass.'}</div>`;
      for (const [h, r] of Object.entries(v.horizons)) {
        const row = (name, x) => x ? `<tr><td>${name}</td><td class="${x.ret >= 0 ? 'tmm-pos' : 'tmm-neg'}">${pctPlain(x.ret)}</td><td>${pctPlain(-x.maxDD)}</td><td>${x.trades}</td></tr>` : '';
        html += `<div class="tmm-card"><b>${hLabel(+h)} horizon</b> ${r.passed ? '<span class="tmm-ok">passed</span>' : '<span class="tmm-warn">not passed</span>'}
          <div class="tmm-scroll"><table class="tmm-tbl"><tr><th>Strategy</th><th>Return</th><th>Worst drop</th><th>Trades</th></tr>
          ${row('Buy and hold', r.bt.bh)}${row('Momentum', r.bt.mom)}${row('Simple mean reversion', r.bt.mr)}${row('This model', r.bt.model)}</table></div>
          <div class="tmm-sub">Ranking skill t = ${Number.isFinite(r.ic.t) ? r.ic.t.toFixed(1) : '—'} (needs &gt; 2). Beat buy-and-hold with ${r.robust} of ${r.tried} different settings (needs 2/3).</div></div>`;
      }
    }
    html += `<h4>Your hypotheses, tested</h4>`;
    html += an.hyp ? `<ul class="tmm-why">${an.hyp.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="tmm-sub">Not enough data yet.</div>';
    if (an.regime) html += `<div class="tmm-sub">Market right now: ${esc(an.regime.label)} (volatility at the ${ordinal(Math.round(an.regime.pct * 100))} percentile).</div>`;

    const decs = (await DB.all('decisions')).filter((d) => d.outcome);
    html += `<h4>Track record of recommendations</h4>`;
    if (!decs.length) html += `<div class="tmm-sub">No recommendations have reached their horizon yet.</div>`;
    else {
      const mp = decs.reduce((a, d) => a + d.adv, 0) / decs.length;
      const mr = decs.reduce((a, d) => a + d.outcome.realized, 0) / decs.length;
      const win = decs.filter((d) => d.outcome.realized > 0).length / decs.length;
      html += `<div class="tmm-sub">${decs.length} checked. Predicted ${pct(mp)} on average, actually ${pct(mr)}. Right direction ${Math.round(win * 100)}% of the time.${mr < mp / 2 ? ' The model has been over-confident; consider raising the evidence setting.' : ''}</div>`;
      html += `<div class="tmm-scroll"><table class="tmm-tbl"><tr><th>When</th><th>Trade</th><th>Predicted</th><th>Actual</th><th>You</th></tr>${decs.slice(-10).reverse().map((d) => `<tr><td>${new Date(d.ts * 1000).toLocaleDateString()}</td><td>${esc(d.sellAcr)}→${esc(d.buyAcr)}</td><td>${pct(d.adv)}</td><td class="${d.outcome.realized >= 0 ? 'tmm-pos' : 'tmm-neg'}">${pct(d.outcome.realized)}</td><td>${esc(d.status)}</td></tr>`).join('')}</table></div>`;
    }

    html += `<h4>All stocks</h4><div class="tmm-scroll"><table class="tmm-tbl"><tr><th>Stock</th><th>Price</th><th>vs normal</th><th>Expected ${hLabel(an.h)}</th><th>Owned</th><th>Spare</th></tr>`;
    const L = an.market ? liveStocks(an, user) : {};
    const rows = Object.values(L).sort((a, b) => ((b.pred ? b.pred.mean : -9) - (a.pred ? a.pred.mean : -9)));
    for (const x of rows) {
      html += `<tr><td>${esc(x.s.acr)}</td><td>${x.price.toFixed(2)}</td><td>${Number.isFinite(x.z) ? (x.z >= 0 ? '+' : '') + x.z.toFixed(1) + 'σ' : '—'}</td><td class="${x.pred && x.pred.mean >= 0 ? 'tmm-pos' : 'tmm-neg'}">${x.pred ? pct(x.pred.mean) : '—'}</td><td>${x.owned ? num(x.owned) : ''}</td><td>${x.owned ? num(Math.max(0, x.spare)) : ''}</td></tr>`;
    }
    html += `</table></div>`;

    const minN = await DB.count('minute');
    html += `<h4>Data on this phone</h4><div class="tmm-sub">${num(an.hours)} hourly prices across ${an.nStocks} stocks${Number.isFinite(an.oldest) ? `, back to ${new Date(an.oldest * 1000).toLocaleDateString()}` : ''}. ${num(minN)} minute snapshots (kept 90 days). ${esc(sync.status)}</div>
      <div class="tmm-row"><button class="tmm-plain" id="tmm-rerun">Re-run analysis</button><button class="tmm-plain" id="tmm-sync">Download history now</button></div>`;
    body.innerHTML = html;
    $('#tmm-rerun', body).onclick = async () => { body.innerHTML = '<div class="tmm-sub">Analyzing…</div>'; await DB.setMeta('validation', null); await analyze(true); showMarket('details'); };
    $('#tmm-sync', body).onclick = () => { syncHistory(true).then(() => analyze(true)); $('#tmm-sync', body).textContent = 'Downloading… keep Torn open'; };
  }

  function renderSettings(body) {
    const pda = !PDA_KEY.includes('#');
    const f = (id, label, val, ph = '') => `<div class="tmm-field"><label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}" autocomplete="off"></div>`;
    const c = (id, label, on) => `<label class="tmm-check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
    body.innerHTML = `
      ${pda ? '<div class="tmm-sub">Using your Torn PDA API key.</div>' : f('s-key', 'Torn API key (Limited Access)', settings.apiKey)}
      <h4>Cash</h4>
      ${f('s-keep', 'Keep this much cash on hand after a deposit', short(settings.keepOnHand))}
      ${f('s-park', 'Parking stock (used while the model is learning)', settings.parkStock, 'e.g. TCI')}
      ${f('s-ex', 'Never trade these stocks', settings.exclude, 'e.g. WSU, TCB')}
      ${f('s-buf', 'Price safety margin (%)', settings.bufferPct)}
      ${c('s-own', 'Only deposit into stocks I already own', settings.depositOwnedOnly)}
      ${c('s-vault', 'Offer faction vault deposits (only shown if you are in a faction)', settings.factionVault)}
      ${f('s-church', 'Church limit: only suggest donating amounts up to this, and only when it can\'t buy a single share', short(settings.churchMax))}
      <h4>Recommendations</h4>
      ${f('s-edge', 'Minimum advantage after fees (%)', settings.minEdgePct)}
      ${f('s-t', 'Evidence required (how many times bigger than the uncertainty)', settings.evidenceT)}
      ${f('s-maxw', 'Most of your portfolio in one stock (%)', settings.maxWeightPct)}
      ${f('s-mint', 'Smallest trade worth suggesting', short(settings.minTrade))}
      ${c('s-unval', 'Show recommendations even if the model fails its test (not advised)', settings.showUnvalidated)}
      <h4>Data and display</h4>
      ${f('s-days', 'Days of history to download', settings.historyDays)}
      ${c('s-open', 'Open the trade panel for me', settings.autoOpen)}
      <div class="tmm-row"><button class="tmm-plain" id="s-moon">Move the moon back to its default spot</button></div>
      <h4>Updates</h4>
      <div class="tmm-sub" id="s-ver">You have v${SCRIPT_VERSION}.${updateConfigured() ? '' : ' Update checks are off until the GitHub link is set in the script.'}</div>
      <div class="tmm-row">${updateConfigured() ? '<button class="tmm-plain" id="s-chk">Check for updates</button>' : ''}</div>
      <div class="tmm-row"><button class="tmm-act" id="s-save">Save settings</button></div>`;
    const chk = $('#s-chk', body);
    if (chk) chk.onclick = async () => {
      chk.textContent = 'Checking…';
      const u = await checkForUpdate(true);
      const v = $('#s-ver', body);
      if (u) {
        v.innerHTML = `Update available: <b>v${esc(u.latest)}</b> (you have v${SCRIPT_VERSION}).`;
        chk.textContent = 'Update now'; chk.className = 'tmm-act'; chk.onclick = installUpdate;
      } else {
        const s = store.get('update', null);
        v.textContent = s && s.err ? `Couldn't reach GitHub: ${s.err}` : `You have the latest version (v${SCRIPT_VERSION}).`;
        chk.textContent = 'Check again';
      }
    };
    $('#s-moon', body).onclick = () => { store.set('dock', { edge: 'right', pos: 0.72 }); placeMoon(); };
    $('#s-save', body).onclick = () => {
      const g = (id) => $('#' + id, body).value.trim();
      const n = (id, d, lo, hi) => { const x = parseFloat(g(id)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
      if (!pda) settings.apiKey = g('s-key');
      const keep = parseAmount(g('s-keep')); settings.keepOnHand = keep > 0 ? keep : 0;
      settings.parkStock = g('s-park').toUpperCase();
      settings.exclude = g('s-ex');
      settings.bufferPct = n('s-buf', DEFAULTS.bufferPct, 0, 5);
      settings.depositOwnedOnly = $('#s-own', body).checked;
      settings.factionVault = $('#s-vault', body).checked;
      const cm = parseAmount(g('s-church')); settings.churchMax = cm >= 0 ? cm : DEFAULTS.churchMax;
      settings.minEdgePct = n('s-edge', DEFAULTS.minEdgePct, 0, 50);
      settings.evidenceT = n('s-t', DEFAULTS.evidenceT, 0, 10);
      settings.maxWeightPct = n('s-maxw', DEFAULTS.maxWeightPct, 5, 100);
      const mt = parseAmount(g('s-mint')); settings.minTrade = mt >= 0 ? mt : DEFAULTS.minTrade;
      settings.showUnvalidated = $('#s-unval', body).checked;
      settings.historyDays = Math.round(n('s-days', DEFAULTS.historyDays, 30, 3650));
      settings.autoOpen = $('#s-open', body).checked;
      saveSettings();
      if (A) A.dirty = true;
      showMarket('overview');
    };
  }

  // ------------------------------------------------------------ badges
  // Orange dot: you're carrying cash. Green dot: there's a trade recommendation.
  function cashNow() { const c = domCash(); return c != null ? c : userMem ? userMem.cash : null; }
  function updateCashBadge() {
    if (!moon) return;
    const cash = cashNow();
    const has = cash != null && cash > settings.keepOnHand + 1000;
    moon.classList.toggle('has-cash', has);
    const note = $('[data-note="cash"]', root);
    if (note) note.textContent = has ? `(${money(cash)} on hand)` : '';
    moon.setAttribute('aria-label', 'Moonshine Asset Manager menu' + (has ? ', carrying cash' : '') + (moon.classList.contains('has-opp') ? ', trade idea available' : ''));
  }
  async function updateBadges() {
    try {
      if (!apiKey()) return;
      if (cashNow() == null || !userMem || Date.now() - userMem.t > 60000) { try { await getUser(55); } catch (e) { /* ignore */ } }
      updateCashBadge();
      if (!userMem) return;
      const an = await analyze();
      let has = false;
      if (an.market && (an.validated || settings.showUnvalidated)) {
        const { rot } = findOpportunity(an, userMem, cashNow() ?? userMem.cash);
        const skip = store.get('skip', null);
        has = !!rot && !(skip && skip.k === rot.sell + '>' + rot.buy && Date.now() < skip.until);
      }
      if (moon) moon.classList.toggle('has-opp', has);
      const note = $('[data-note="opp"]', root);
      if (note) note.textContent = has ? '(trade idea)' : updateInfo() ? '(update)' : '';
      updateCashBadge();
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ withdraw input
  function askWithdraw() {
    const recent = [...new Set([...store.get('recent', []), 1e6, 5e6, 10e6, 25e6])].slice(0, 6);
    const s = openSheet(`
      <h3>How much cash do you need?</h3>
      <input class="tmm-input" id="tmm-amt" inputmode="decimal" placeholder="e.g. 5m, 750k, 1.2b" autocomplete="off">
      <div class="tmm-row">${recent.map((a) => `<button class="tmm-chip" data-amt="${a}">${short(a)}</button>`).join('')}</div>
      <div class="tmm-err" id="tmm-amt-err" hidden></div>
      <div class="tmm-row"><button class="tmm-act" id="tmm-go">Find shares to sell</button><button class="tmm-plain" id="tmm-x">Cancel</button></div>`);
    const inp = $('#tmm-amt', s);
    setTimeout(() => inp.focus(), 50);
    const go = (v) => {
      const amt = parseAmount(v);
      if (!(amt > 0)) { const e = $('#tmm-amt-err', s); e.hidden = false; e.textContent = 'Enter an amount like 5m, 750k or 2500000.'; return; }
      store.set('recent', [amt, ...store.get('recent', []).filter((x) => x !== amt)].slice(0, 3));
      runJob({ action: 'withdraw', amount: amt });
    };
    $('#tmm-go', s).onclick = () => go(inp.value);
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(inp.value); };
    $$('[data-amt]', s).forEach((b) => (b.onclick = () => go(b.dataset.amt)));
    $('#tmm-x', s).onclick = closeSheet;
  }

  // ------------------------------------------------------------ trade jobs
  function runJob(job) {
    if (!onStockPage()) {
      sessionStorage.setItem(LS + 'pending', JSON.stringify(Object.assign({ t: Date.now() }, job)));
      openSheet(`<h3>Opening the stock market…</h3>`);
      location.href = STOCK_URL;
      return;
    }
    execute(job);
  }

  function showError(msg) {
    const s = openSheet(`<h3>Can't do that right now</h3><div class="tmm-err">${esc(msg)}</div><div class="tmm-row"><button class="tmm-plain" id="tmm-x">Close</button></div>`);
    $('#tmm-x', s).onclick = closeSheet;
  }

  async function execute(job) {
    openSheet(`<h3>${job.action === 'withdraw' ? 'Withdraw ' + money(job.amount) : job.action === 'deposit' ? 'Deposit' : 'Rotation'}</h3><div class="tmm-sub">Checking prices and your shares…</div>`);
    try {
      const rows = await waitFor(() => stockRows().length > 0, 8000);
      if (!rows) throw new Error("The stock list didn't load. You may be traveling, in hospital or in jail, or Torn changed the page layout.");
      userMem = null;
      const [an, user] = await Promise.all([analyze().catch(() => null), getUser(0)]);
      const market = (an && an.market) || (await getMarket(60));
      const base = an || { market, preds: {}, model: null, S: {}, h: 24 };
      if (Date.now() - market.t > 5 * 60000) throw new Error('Price data is stale. Try again in a moment.');
      if (job.action === 'withdraw') {
        const plan = planWithdraw(job.amount, base, user);
        if (plan.error) return showError(plan.error);
        return showQuick(job, plan, 0, 'sell');
      }
      if (job.action === 'deposit') {
        const cash = domCash() ?? user.cash;
        const plan = planDeposit(cash, base, user);
        if (plan.error) {
          const left = cash - settings.keepOnHand;
          if (plan.tooSmall && left > 0) return showSmallCashOffer(left, plan.error);
          return showError(plan.error);
        }
        if (plan.noGood) return showNoGoodBuys(job, plan);
        return showQuick(job, plan, 0, 'buy');
      }
      if (job.action === 'rotate') return showRotation(job, base, user);
    } catch (e) { showError(e.message || String(e)); }
  }

  // ------------------------------------------------------------ church donation
  const CHURCH_URL = 'https://www.torn.com/church.php';
  const onChurchPage = () => /church\.php/i.test(location.href);

  function cheapestAllowedPrice() {
    const m = marketMem || store.get('market', null);
    if (!m) return null;
    const ex = excluded();
    const park = settings.parkStock.toUpperCase();
    const owned = userMem ? userMem.owned : {};
    let best = null;
    for (const s of Object.values(m.stocks)) {
      if (ex.includes(s.acr)) continue;
      if (settings.depositOwnedOnly && !owned[s.id] && s.acr !== park) continue;
      const p = domPrice(s.id) || s.price;
      if (p > 0 && (best == null || p < best)) best = p;
    }
    return best;
  }

  // ------------------------------------------------------------ cash leftovers
  const vaultAvailable = () => settings.factionVault && !!userMem && userMem.factionId > 0 &&
    !/hospital|jail|travel|abroad|federal/i.test(userMem.state || '');
  // The church gives money away for good, so it's a last resort: only for small
  // amounts that can't buy even one share of any stock. A cheap share keeps the
  // money and only costs the 0.1% fee when you sell it.
  const canBuyAShare = (amt) => { const c = cheapestAllowedPrice(); return c != null && amt >= c * (1 + settings.bufferPct / 100); };
  const churchOk = (amt) => amt >= 1 && amt <= settings.churchMax && !canBuyAShare(amt);
  function placeOptions(amt) {
    const out = [];
    if (vaultAvailable()) out.push({ label: 'Faction vault', long: `Deposit ${money(amt)} to the faction vault`, fn: () => startVaultDeposit(amt) });
    if (churchOk(amt)) out.push({ label: 'Church', long: `Donate ${money(amt)} to the church`, fn: () => startDonation(amt) });
    return out;
  }

  // After a stock purchase: is there enough left for more, and is it worth it?
  async function leftoverNext(job, cash) {
    const left = cash - settings.keepOnHand;
    if (left < 1) return false;
    let user = userMem;
    try { user = await getUser(30); } catch (e) { /* use what we have */ }
    const an = A || { market: marketMem || store.get('market', null), preds: {}, model: null, S: {}, h: 24 };
    if (!an.market || !user) return { text: `${money(left)} left on hand`, extras: placeOptions(left) };
    const plan = planDeposit(cash, an, user);
    if (plan.legs && plan.legs.length) {
      const o = plan.legs[0];
      return {
        text: `✓ Bought · ${money(left)} left`,
        extras: [{ label: `Buy ${num(o.shares)} ${o.s.acr}`, long: `Buy ${num(o.shares)} more ${o.s.acr}`, fn: () => showQuick(job, plan, 0, 'buy') }, ...placeOptions(left)],
      };
    }
    if (plan.noGood) {
      // Vault first (keeps the money); otherwise buying anyway beats giving it away.
      const buyAnyway = { label: `Buy ${plan.best.s.acr} anyway`, fn: () => showQuick(job, Object.assign({}, plan, { legs: [plan.best] }), 0, 'buy') };
      return { text: `✓ Bought · no good buys for the last ${money(left)}`, extras: [...placeOptions(left), buyAnyway] };
    }
    return { text: `✓ Bought · ${money(left)} left`, extras: placeOptions(left) };
  }

  // Nothing worth buying right now.
  function showNoGoodBuys(job, plan) {
    const o = plan.best, amt = plan.avail;
    const opts = placeOptions(amt);
    const s = openSheet(`
      <h3>No good buys right now</h3>
      <div class="tmm-sub">Every stock you can buy is expected to fall or would put too much in one stock. The best option, ${esc(o.s.acr)}, is expected to change ${o.pred ? pct(o.pred.mean) : '—'} over ${hLabel(A ? A.h : 24)}.</div>
      <div class="tmm-big">${money(amt)} to put away</div>
      <div class="tmm-row" id="tmm-ng"></div>
      <div class="tmm-sub">Buying anyway keeps your money safe in stocks; you only pay the 0.1% fee when you sell.</div>
      <div class="tmm-row"><button class="tmm-plain" id="tmm-x">Keep it</button></div>`);
    const row = $('#tmm-ng', s);
    const all = [...opts, { label: `Buy ${num(o.shares)} ${o.s.acr} anyway`, fn: () => showQuick(job, Object.assign({}, plan, { legs: [o] }), 0, 'buy') }];
    all.forEach((x, i) => { const b = document.createElement('button'); b.className = i ? 'tmm-plain' : 'tmm-act'; b.textContent = x.long || x.label; b.onclick = x.fn; row.appendChild(b); });
    $('#tmm-x', s).onclick = closeSheet;
  }

  // Too little cash to buy even one share.
  function showSmallCashOffer(left, why) {
    const opts = placeOptions(left);
    const s = openSheet(`
      <h3>Too little to buy a share</h3>
      <div class="tmm-sub">${esc(why)}</div>
      <div class="tmm-big">${money(left)} on hand</div>
      <div class="tmm-sub">${opts.length ? 'Put it somewhere it can\'t be mugged:' : 'Not enough for a share, and over your church limit in Settings.'}</div>
      <div class="tmm-row" id="tmm-sc"></div>
      <div class="tmm-row"><button class="tmm-plain" id="tmm-x">Keep it</button></div>`);
    const row = $('#tmm-sc', s);
    opts.forEach((x, i) => { const b = document.createElement('button'); b.className = i ? 'tmm-plain' : 'tmm-act'; b.textContent = x.long; b.onclick = x.fn; row.appendChild(b); });
    $('#tmm-x', s).onclick = closeSheet;
  }

  // ------------------------------------------------------------ faction vault
  // Faction → Armory (revolver tab) → Deposit. We fill in the money box only;
  // you tap DEPOSIT MONEY.
  const FACTION_URL = 'https://www.torn.com/factions.php?step=your&type=1#faction-armoury';
  const onFactionPage = () => /factions\.php/i.test(location.href);
  const onArmoury = () => onFactionPage() && /step=your/i.test(location.search) && /armou?ry/i.test(location.hash);

  function startVaultDeposit(amount) {
    const job = { action: 'vault', amount: Math.floor(amount), t: Date.now() };
    closeSheet();
    if (!onArmoury()) {
      sessionStorage.setItem(LS + 'pending', JSON.stringify(job));
      showPill('Opening the faction armory…');
      location.href = FACTION_URL;
      return;
    }
    fillVault(job);
  }

  // The Donate tab has a money box and a points box. Use the money one.
  function findVaultInput() {
    const isDepositBtn = (el) => /^(deposit|donate)\b/i.test(elText(el));
    const isPoints = (el) => /point/i.test(elText(el));
    const cands = $$('input').filter(visibleInput);
    const money = cands.filter((i) => i.classList.contains('input-money'));
    for (const inp of [...money, ...cands.filter((i) => !money.includes(i))]) {
      let el = inp.parentElement;
      for (let d = 0; el && d < 5; d++, el = el.parentElement) {
        const btns = $$("button, input[type='submit'], input[type='button'], a", el).filter((x) => !x.closest('#tmm-root') && isDepositBtn(x));
        if (!btns.length) continue;
        const pts = btns.some(isPoints), mon = btns.some((x) => !isPoints(x));
        if (mon && !pts) return inp;           // only a money button nearby
        if (pts && !mon) break;                // this is the points box
        // both buttons share this container: decide by the box's own label
        const near = elText(inp.parentElement.parentElement || inp.parentElement);
        if (/point/i.test(near) && !/money|\$/i.test(near)) break;
        return inp;
      }
    }
    return null;
  }

  async function fillVault(job) {
    const cash = domCash();
    const amount = Math.max(0, Math.floor(Math.min(job.amount, cash != null ? cash : job.amount)));
    if (amount < 1) { showPill('No cash on hand to deposit.'); return; }
    const copy = { label: 'Copy', fn: () => { try { navigator.clipboard.writeText(String(amount)); updatePill(`Copied ${money(amount)} · paste it in the money box`); } catch (e) { /* ignore */ } } };
    showPill(`Faction vault ${money(amount)}`, '', copy);
    if (!/armou?ry/i.test(location.hash)) { try { location.hash = '#faction-armoury'; } catch (e) { /* ignore */ } }
    let input = await waitFor(findVaultInput, 6000);
    if (!input) {
      // The Armory tab is the revolver icon: find it by its link, not its text.
      const arm = $$('a, li, button, [role=tab]').find((el) => !el.closest('#tmm-root') &&
        (/faction-armou?ry/i.test(el.getAttribute('href') || '') || /armou?ry/i.test(el.getAttribute('aria-controls') || '') || /^armou?ry$/i.test(el.getAttribute('title') || el.getAttribute('aria-label') || '')));
      if (arm) { try { arm.click(); } catch (e) { /* ignore */ } }
      input = await waitFor(findVaultInput, 5000);
    }
    if (!pill) return;
    if (!input) { updatePill(`Open Faction → Armory, type ${money(amount)}, tap Deposit Money`); return; }
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const ok = await typeInto(input, amount);
    input.classList.add('tmm-filled');
    setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
    updatePill(ok ? `${money(amount)} filled in · tap Deposit Money` : `Type ${money(amount)} in the money box, tap Deposit Money`);
    const startCash = domCash();
    const started = Date.now();
    watchTimer = setInterval(() => {
      if (Date.now() - started > 5 * 60000 || !pill) { clearInterval(watchTimer); watchTimer = null; return; }
      const c = domCash();
      if (startCash != null && c != null && c < startCash) {
        clearInterval(watchTimer); watchTimer = null;
        DB.add('executions', { t: Date.now(), kind: 'vault', action: 'deposit', amount: startCash - c, cashBefore: startCash, cashAfter: c }).catch(() => {});
        setTimeout(() => clearBox(input), 400); // Torn leaves the old amount in the box
        showPill(`✓ Deposited to faction vault · cash ${money(c)}`, 'ok');
        const p0 = pill;
        setTimeout(() => { if (pill === p0) closeSheet(); }, 5000);
      }
    }, 1000);
  }

  function startDonation(amount) {
    const job = { action: 'donate', amount: Math.floor(amount), t: Date.now() };
    if (!onChurchPage()) {
      sessionStorage.setItem(LS + 'pending', JSON.stringify(job));
      closeSheet();
      showPill('Opening the church…');
      location.href = CHURCH_URL + '#church-donate';
      return;
    }
    closeSheet();
    fillDonation(job);
  }

  const visibleInput = (i) => !/^(hidden|button|submit|checkbox|radio|image|file)$/i.test(i.type) && i.offsetParent !== null && !i.closest('#tmm-root');

  // The church has tabs "Donate / Ceremony / Pray" and opens on Ceremony.
  // In the Donate tab, a "Donate" button under the chest reveals the amount
  // box and Torn's "give" button. We tap the tab and that reveal button only.
  // We never tap "give" — that's yours.
  const elText = (el) => (el.textContent || el.value || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const innermost = (list) => list.filter((el) => !list.some((o) => o !== el && el.contains(o)));
  function isChurchTab(el) {
    let p = el.parentElement;
    for (let d = 0; p && d < 5; d++, p = p.parentElement) {
      const tx = elText(p);
      if (/ceremony/i.test(tx) && /pray/i.test(tx) && tx.length < 120) return true;
    }
    return false;
  }
  function donateCandidates() {
    return $$('a, li, button, span, div, img, input[type=button], [role=tab], [role=button]').filter((el) =>
      !el.closest('#tmm-root') && el.offsetParent !== null && /^donate$/i.test(elText(el)));
  }
  function findDonateTab() {
    const tabs = innermost(donateCandidates().filter(isChurchTab));
    return tabs[0] || null;
  }
  function findRevealButton() {
    const btns = innermost(donateCandidates().filter((el) => !isChurchTab(el) && !/give/i.test(elText(el))));
    return btns[0] || null;
  }
  async function openDonateBox() {
    if (findDonateInput()) return true;
    const tab = await waitFor(findDonateTab, 5000);
    if (tab) {
      tab.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(250);
      try { tab.click(); } catch (e) { /* ignore */ }
    }
    if (await waitFor(findDonateInput, 800)) return true;
    const reveal = await waitFor(findRevealButton, 4000);
    if (reveal) {
      reveal.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(250);
      try { reveal.click(); } catch (e) { /* ignore */ }
    }
    return !!(await waitFor(findDonateInput, 4000));
  }

  // Finds the church's donation box. Never presses Torn's Donate button.
  function findDonateInput() {
    // 1) Inside the Donate tab's own panel.
    const panels = [document.getElementById('church-donate'), ...$$("[id*='donate' i], [class*='donate' i]")]
      .filter((el) => el && !el.closest('#tmm-root') && el.offsetParent !== null);
    for (const pnl of panels) {
      const inp = $$('input', pnl).find(visibleInput);
      if (inp) return inp;
    }
    // 2) A visible box that sits next to a real Donate button (not the tab link).
    const isDonateBtn = (el) => el.tagName !== 'A' && /donat/i.test((el.textContent || el.value || '').trim());
    for (const inp of $$('input').filter(visibleInput)) {
      let el = inp.parentElement;
      for (let d = 0; el && d < 4; d++, el = el.parentElement) {
        if ($$("button, input[type='submit'], input[type='button']", el).some(isDonateBtn)) return inp;
      }
    }
    return null;
  }

  // Minimal: only a small bar at the top showing the amount, never a big panel.
  async function fillDonation(job) {
    const cash = domCash();
    const amount = Math.max(0, Math.floor(Math.min(job.amount, cash != null ? cash : job.amount)));
    if (amount < 1) { showPill('No cash on hand to donate.'); return; }
    const copy = { label: 'Copy', fn: () => { try { navigator.clipboard.writeText(String(amount)); updatePill(`Copied ${money(amount)} · paste it in the Donate box`); } catch (e) { /* ignore */ } } };
    showPill(`Donate ${money(amount)}`, '', copy);
    await openDonateBox();
    const input = findDonateInput();
    if (!pill) return;
    if (!input) { updatePill(`Open Donate, type ${money(amount)}, tap give`); return; }
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const ok = await typeInto(input, amount);
    input.classList.add('tmm-filled');
    setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
    updatePill(ok ? `${money(amount)} filled in · tap give` : `Type ${money(amount)} in the box, then tap give`);
    const startCash = domCash();
    const started = Date.now();
    watchTimer = setInterval(() => {
      if (Date.now() - started > 5 * 60000 || !pill) { clearInterval(watchTimer); watchTimer = null; return; }
      const c = domCash();
      if (startCash != null && c != null && c < startCash) {
        clearInterval(watchTimer); watchTimer = null;
        DB.add('executions', { t: Date.now(), kind: 'donation', action: 'donate', amount: startCash - c, cashBefore: startCash, cashAfter: c }).catch(() => {});
        setTimeout(() => clearBox(input), 400);
        showPill(`✓ Donated · cash ${money(c)}`, 'ok');
        const p0 = pill;
        setTimeout(() => { if (pill === p0) closeSheet(); }, 5000);
      }
    }, 1000);
  }

  // Generic: show one leg, fill Torn's box, watch for your confirmation.
  async function showLeg({ title, action, stock, shares, price, lines, warn, alts, onAlt, recompute, onDone, kind, extras }) {
    const isSell = action === 'sell';
    const btn = isSell ? 'Sell' : 'Buy';
    const s = openSheet(`
      <h3>${esc(title)}</h3>
      <div class="tmm-big">${btn} ${num(shares)} ${esc(stock.acr)}</div>
      ${lines.map((l) => `<div class="tmm-sub">${esc(l)}</div>`).join('')}
      ${(warn || []).map((w) => `<div class="tmm-warn">${esc(w)}</div>`).join('')}
      <div class="tmm-status" id="tmm-status">Filling in the ${btn} box…</div>
      ${alts && alts.length ? `<div class="tmm-sub">Use a different stock:</div><div class="tmm-row">${alts.map((a, i) => `<button class="tmm-chip" data-alt="${i}">${esc(a.s.acr)} · ${num(a.shares)}${action === 'sell' && a.profit != null ? (a.profit >= 0 ? ' · in profit' : ' · at a loss') : ''}</button>`).join('')}</div>` : ''}
      ${extras && extras.length ? `<div class="tmm-row">${extras.map((x, i) => `<button class="tmm-plain" data-ex="${i}">${esc(x.long || x.label)}</button>`).join('')}</div>` : ''}
      <div class="tmm-row"><button class="tmm-plain" id="tmm-copy">Copy share count</button><button class="tmm-plain" id="tmm-x">Close</button></div>`);
    $('#tmm-x', s).onclick = closeSheet;
    $$('[data-ex]', s).forEach((b) => (b.onclick = () => extras[Number(b.dataset.ex)].fn()));
    const cur = { shares, price };
    $('#tmm-copy', s).onclick = () => { try { navigator.clipboard.writeText(String(cur.shares)); $('#tmm-copy', s).textContent = 'Copied'; } catch (e) { /* ignore */ } };
    $$('[data-alt]', s).forEach((b) => (b.onclick = () => onAlt(Number(b.dataset.alt))));
    const status = $('#tmm-status', s);
    const filled = await openAndFill(stock.id, action, shares);
    const res = filled.res;
    const ok = res === 'ok';
    if (!sheet || !document.body.contains(status)) return;
    status.innerHTML = ok
      ? `Share count is filled in. Tap Torn's <b>${btn}</b> button in the ${esc(stock.acr)} panel to confirm.`
      : res === 'unverified'
        ? `I tried to enter <b>${num(shares)}</b> but Torn's ${btn} box didn't take it. Clear the box and type <b>${num(shares)}</b> yourself, or use Copy share count.`
        : settings.autoOpen
        ? `Couldn't find the ${btn} box. Tap the Owned cell on ${esc(stock.acr)} and type <b>${num(shares)}</b>, or use Copy share count.`
        : `Tap the Owned cell on ${esc(stock.acr)}. The share count fills in when the panel opens.`;
    const pillText = () => `${btn} ${num(cur.shares)} ${stock.acr} · tap ${btn}`;
    // Collapse to a small card at the top: keeps the explanation readable without covering Torn's button.
    if (ok) minimizeSheet(pillText(), extras, [...(warn || []), ...lines]);
    const guard = async () => {
      if (!filled.input || !sheet || !document.body.contains(status) || !watchTimer) return;
      const inputs = boxInputs(filled.input);
      if (boxShows(inputs, cur.shares)) return;
      if (await typeInto(filled.input, cur.shares)) return;
      expandSheet();
      status.innerHTML = `Torn changed the ${btn} box back. Clear it and type <b>${num(cur.shares)}</b> yourself, or use Copy share count.`;
    };
    if (ok) { setTimeout(guard, 1200); setTimeout(guard, 3500); }
    const legRow = findRow(stock.id);
    let warned = false;
    const confirmObs = legRow && new MutationObserver(() => {
      const scope = panelScope(legRow);
      const n = confirmShares(scope, action);
      if (n == null) return;
      if (n !== cur.shares && !warned) {
        warned = true;
        expandSheet();
        status.className = 'tmm-err';
        status.innerHTML = `STOP — Torn is asking to ${btn.toLowerCase()} <b>${num(n)}</b> shares, not <b>${num(cur.shares)}</b>. Tap <b>No</b> / Cancel in Torn's box, then type <b>${num(cur.shares)}</b> into the ${btn} box yourself.`;
      } else if (n === cur.shares && warned) {
        warned = false;
        status.className = 'tmm-ok';
        status.innerHTML = `Torn now shows ${num(n)} shares. Correct — tap Torn's confirm.`;
      }
    });
    if (confirmObs) {
      for (const node of panelScope(legRow)) confirmObs.observe(node, { childList: true, subtree: true, characterData: true });
      setTimeout(() => confirmObs.disconnect(), 5 * 60000);
    }
    const startCash = domCash();
    const started = Date.now();
    watchTimer = setInterval(async () => {
      if (Date.now() - started > 5 * 60000) { clearInterval(watchTimer); watchTimer = null; return; }
      const cash = domCash();
      if (startCash != null && cash != null && cash !== startCash) {
        clearInterval(watchTimer); watchTimer = null;
        if (confirmObs) confirmObs.disconnect();
        try {
          await DB.add('executions', { t: Date.now(), kind, action, sid: stock.id, acr: stock.acr, shares: cur.shares, expectedPrice: cur.price, actualPrice: Math.abs(cash - startCash) / cur.shares / (isSell ? 1 - FEE : 1), cashBefore: startCash, cashAfter: cash });
        } catch (e) { /* logging is best-effort */ }
        status.className = 'tmm-ok';
        status.innerHTML = `${isSell ? 'Sold' : 'Bought'}. Cash on hand: ${money(cash)}.`;
        userMem = null;
        const waitSheet = sheet;
        await waitForBack(stock.id, () => {
          const msg = `✓ ${isSell ? 'Sold' : 'Bought'} · now tap BACK in Torn's panel`;
          status.innerHTML = `${isSell ? 'Sold' : 'Bought'}. Cash on hand: ${money(cash)}. <b>Now tap Torn's BACK button</b> (highlighted) to continue.`;
          if (sheet && sheet.style.display === 'none') showPill(msg, 'ok');
          else if (sheet) minimizeSheet(msg);
        });
        if (sheet !== waitSheet) return; // closed or replaced while waiting
        const next = onDone ? await onDone(cash, status) : false;
        if (next === true) { expandSheet(); return; }
        const doneSheet = sheet;
        const doneText = `✓ ${isSell ? 'Sold' : 'Bought'} · cash ${money(cash)}`;
        if (next && next.extras && next.extras.length) {
          if (doneSheet && doneSheet.style.display === 'none') showPill(next.text || doneText, 'ok', next.extras);
          else {
            const row = document.createElement('div'); row.className = 'tmm-row';
            next.extras.forEach((x, i) => { const b = document.createElement('button'); b.className = i ? 'tmm-plain' : 'tmm-act'; b.textContent = x.long || x.label; b.onclick = x.fn; row.appendChild(b); });
            if (next.text) { const d = document.createElement('div'); d.className = 'tmm-sub'; d.textContent = next.text; status.after(d); d.after(row); } else status.after(row);
          }
          setTimeout(() => { if (sheet === doneSheet && !watchTimer) closeSheet(); }, 25000);
        } else {
          if (doneSheet && doneSheet.style.display === 'none') showPill(doneText, 'ok');
          setTimeout(() => { if (sheet === doneSheet && !watchTimer) closeSheet(); }, 5000);
        }
        return;
      }
      const p = domPrice(stock.id);
      if (p && Math.abs(p - cur.price) > 1e-9 && recompute) {
        const ns = recompute(p);
        cur.price = p;
        if (ns > 0 && ns !== cur.shares) {
          cur.shares = ns;
          const row = findRow(stock.id);
          const inp = row && findTradeInput(row, action);
          if (inp) await typeInto(inp, ns);
          status.innerHTML = `Price moved to $${p.toFixed(2)}. Updated to <b>${num(ns)}</b> shares. Tap Torn's <b>${btn}</b> button to confirm.`;
          updatePill(`Price moved · ${pillText()}`);
        }
      }
    }, 1500);
  }

  function showQuick(job, plan, legIdx, action) {
    const o = plan.legs[legIdx];
    const isSell = action === 'sell';
    const buf = 1 + settings.bufferPct / 100;
    const value = isSell ? o.shares * o.price * (1 - FEE) : o.shares * o.price;
    const legTag = plan.legs.length > 1 ? ` (sale ${legIdx + 1} of ${plan.legs.length})` : '';
    const warn = [];
    if (plan.mode === 'breaks') warn.push(`This sale drops ${o.s.acr} below a benefit block. Pick another stock below to avoid that.`);
    if (plan.mode === 'split') warn.push('No single stock covers this without breaking a benefit, so it is split into separate sales.');
    if (!isSell && o.completes) warn.push(`This completes your next ${o.s.acr} benefit block.`);
    if (!isSell && o.overweight) warn.push(`This puts more than ${settings.maxWeightPct}% of your portfolio in ${o.s.acr}.`);
    if (isSell && o.profit != null && o.profit < 0) {
      const loss = o.shares * (o.cost - o.price * (1 - FEE));
      warn.push(plan.anyProfit
        ? `${o.s.acr} is below what you paid: this sale loses about ${money(loss)}. A stock in profit is listed below.`
        : `All your stocks are below what you paid. This is the smallest hit: about ${money(loss)}.`);
    }
    const profitLine = isSell && o.profit != null && o.profit >= 0
      ? `You paid about $${o.cost.toFixed(2)} a share, so this sells at ${pctPlain(o.profit, 2)} after the fee: no loss.`
      : null;
    const avgLine = !isSell && o.owned > 0 && o.cost
      ? `You own ${num(o.owned)} ${o.s.acr} at an average of $${o.cost.toFixed(2)}. Buying at $${o.price.toFixed(2)} ${o.price < o.cost ? 'lowers' : o.price > o.cost ? 'raises' : 'keeps'} that average${o.price !== o.cost ? ' a little' : ''}.`
      : null;
    const target = isSell ? (plan.legs.length > 1 ? o.shares * o.price * (1 - FEE) : job.amount) : plan.avail;
    showLeg({
      kind: 'cash',
      title: isSell ? `Withdraw ${money(job.amount)}${legTag}` : `Deposit ${money(plan.avail)}`,
      action, stock: o.s, shares: o.shares, price: o.price,
      lines: [
        isSell ? `At about $${o.price.toFixed(2)}, you get about ${money(value)} after the 0.1% fee.` : `At about $${o.price.toFixed(2)}, this uses about ${money(value)} and leaves ${money(Math.max(0, plan.avail - value) + settings.keepOnHand)} on hand.`,
        quickReason(o, action, plan.mode === 'split' || plan.mode === 'breaks' ? (modelUsable(A) ? 'model' : 'simple') : plan.mode),
        ...(profitLine ? [profitLine] : []),
        ...(avgLine ? [avgLine] : []),
      ],
      warn,
      alts: plan.alts,
      onAlt: (i) => {
        const alt = plan.alts[i];
        const rest = plan.alts.filter((x) => x !== alt).concat([o]);
        showQuick(job, Object.assign({}, plan, { legs: [alt], alts: rest, mode: alt.breaks ? 'breaks' : plan.mode === 'breaks' ? (modelUsable(A) ? 'model' : 'simple') : plan.mode }), 0, action);
      },
      recompute: (p) => isSell
        ? Math.min(o.cap || o.owned, Math.ceil((target * buf) / (p * (1 - FEE))))
        : Math.floor(target / (p * buf)),
      extras: !isSell && vaultAvailable() ? [{ label: 'Vault instead', long: `Deposit ${money(plan.avail)} to the faction vault instead`, fn: () => startVaultDeposit(plan.avail) }] : null,
      onDone: async (cash, status) => {
        if (!isSell) return leftoverNext(job, cash);
        if (isSell && legIdx + 1 < plan.legs.length) {
          const b = document.createElement('button');
          b.className = 'tmm-act'; b.textContent = 'Next sale';
          b.onclick = () => showQuick(job, plan, legIdx + 1, action);
          status.after(b);
          return true;
        }
        return false;
      },
    });
  }

  function showRotation(job, an, user) {
    const m = an.market.stocks;
    const sellS = m[job.sell], buyS = m[job.buy];
    if (!sellS || !buyS) return showError('One of the stocks in this recommendation no longer exists.');
    const buf = 1 + settings.bufferPct / 100;
    const goBuy = () => {
      const cash = domCash() ?? 0;
      const price = domPrice(buyS.id) || buyS.price;
      const avail = cash - settings.keepOnHand;
      const shares = Math.floor(avail / (price * buf));
      if (shares < 1) return showError(`Not enough cash on hand to buy ${buyS.acr}.`);
      showLeg({
        kind: 'rotation', title: 'Rotation, step 2 of 2', action: 'buy', stock: buyS, shares, price,
        lines: [`Uses about ${money(shares * price)} of your ${money(cash)} cash.`],
        recompute: (p) => Math.floor(avail / (p * buf)),
        onDone: async () => {
          const d = await DB.get('decisions', job.decisionId);
          if (d) { d.status = 'executed'; await DB.put('decisions', d); }
        },
      });
    };
    if (job.stage === 'buy') return goBuy();
    const owned = user.owned[sellS.id] || 0;
    const spare = owned - Core.protectedShares(sellS.benefit, owned);
    const shares = Math.min(job.shares, spare);
    if (shares < 1) return showError(`You no longer have spare ${sellS.acr} shares to sell.`);
    const price = domPrice(sellS.id) || sellS.price;
    showLeg({
      kind: 'rotation', title: 'Rotation, step 1 of 2', action: 'sell', stock: sellS, shares, price,
      lines: [`About ${money(shares * price * (1 - FEE))} after the 0.1% fee. Next you'll buy ${buyS.acr}.`],
      onDone: (cash, status) => {
        sessionStorage.setItem(LS + 'pending', JSON.stringify(Object.assign({}, job, { stage: 'buy', t: Date.now() })));
        const b = document.createElement('button');
        b.className = 'tmm-act'; b.textContent = `Confirm buy ${buyS.acr}`;
        b.onclick = () => { sessionStorage.removeItem(LS + 'pending'); goBuy(); };
        status.after(b);
        return true;
      },
    });
  }

  // =====================================================================
  //  BOOT
  // =====================================================================
  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    mountUI();
    const raw = sessionStorage.getItem(LS + 'pending');
    if (raw) {
      let job = null;
      try { job = JSON.parse(raw); } catch (e) { /* ignore */ }
      if (job && job.action === 'donate' && onChurchPage()) {
        sessionStorage.removeItem(LS + 'pending');
        if (Date.now() - job.t < 10 * 60000) fillDonation(job);
      } else if (job && job.action === 'vault' && onFactionPage()) {
        sessionStorage.removeItem(LS + 'pending');
        if (Date.now() - job.t < 10 * 60000) setTimeout(() => fillVault(job), 300);
      } else if (job && job.action !== 'donate' && job.action !== 'vault' && onStockPage()) {
        sessionStorage.removeItem(LS + 'pending');
        if (Date.now() - job.t < 10 * 60000) execute(job);
      }
    }
    if (!window.indexedDB) return;
    updateCashBadge();
    const um = document.getElementById('user-money');
    if (um) new MutationObserver(updateCashBadge).observe(um, { attributes: true, childList: true, characterData: true, subtree: true });
    setInterval(updateCashBadge, 15000);
    collectTick();
    setInterval(collectTick, 60000);
    setTimeout(updateBadges, 3000);
    setInterval(updateBadges, 60000);
    setTimeout(() => { checkForUpdate().then(updateBadges).catch(() => {}); }, 8000);
  }
  boot();
})();

/* ============================================================
   VINGADOR BOT 24H · Watchlist V11 no servidor
   ------------------------------------------------------------
   - Mesma checklist de 8 fatores + selo V11 do painel (porta fiel)
   - Alertas por Telegram (e WhatsApp via CallMeBot, opcional)
   - Roda 24/7 sem navegador e sem PC ligado
   - Sem dependências: apenas Node 18+ (fetch nativo)
   - Configuração 100% por variáveis de ambiente:
       TELEGRAM_TOKEN, TELEGRAM_CHAT  (alertas)
       WA_PHONE, WA_KEY               (WhatsApp opcional)
       WATCHLIST=BTCUSDT,SOLUSDT,...  (máx. 40 ativos)
       PROFILE=padrao|scalp|swing     (timeframes)
       INTERVAL_MIN=5                 (ciclo de varredura)
       ALERT_COOLDOWN_MIN=120         (intervalo por ativo+direção)
       V11_GATE=1                     (0 desliga o selo V11)
       PORT=7860                      (status HTTP)
   ============================================================ */
'use strict';

const isNode = (typeof process !== 'undefined') && (typeof window === 'undefined');
const ENV = isNode ? process.env : (globalThis.__VG_ENV__ || {});

const BYBIT = 'https://api.bybit.com';
const AI_MIN_RR = 1.8;

/* ---------------- fonte de dados: Bybit V5 (pública, sem chave) ----------------
   Por que Bybit: a Binance bane IPs de datacenter (418) e IPs compartilhados de
   hospedagem grátis ficam permanentemente queimados. A Bybit aceita varredura
   leve de servidores. Os klines são convertidos para o formato Binance para
   TODO o motor matemático continuar idêntico ao painel. */
const TF_MS = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
const BYBIT_IV = { '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
async function bbJson(url, timeout = 9000){
  const r = await fetchJson(url, timeout);
  if(r && r.retCode !== undefined && r.retCode !== 0) throw new Error('Bybit ' + r.retCode + ' ' + (r.retMsg || ''));
  return r;
}
async function byKlines(sym, tf, limit){
  const r = await bbJson(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=${BYBIT_IV[tf] || '15'}&limit=${Math.min(1000, limit)}`);
  const list = (r.result && r.result.list) || [];
  const ms = TF_MS[tf] || 900000;
  // Envelope novo→antigo da Bybit → formato Binance antigo→novo:
  // [0]openTime [1]open [2]high [3]low [4]close [5]volume [6]closeTime [9]takerBuy
  return list.map(x => [+x[0], x[1], x[2], x[3], x[4], x[5], +x[0] + ms - 1, '0', '0', 0]).reverse();
}
async function byBook(sym, limit){
  const r = await bbJson(`${BYBIT}/v5/market/orderbook?category=linear&symbol=${sym}&limit=${limit}`);
  return { bids: (r.result && r.result.b) || [], asks: (r.result && r.result.a) || [] };
}
async function byTrades(sym){
  const r = await bbJson(`${BYBIT}/v5/market/recent-trade?category=linear&symbol=${sym}&limit=1000`);
  return ((r.result && r.result.list) || []).map(t => ({ p: t.price, q: t.size, T: Number(t.time), m: t.side === 'Sell' }));
}
async function byTickers(sym){
  const r = await bbJson(`${BYBIT}/v5/market/tickers?category=linear&symbol=${sym}`);
  const tk = (r.result && r.result.list && r.result.list[0]) || {};
  return {
    fund: { lastFundingRate: tk.fundingRate },
    oi: { openInterest: tk.openInterest },
    t24: { lastPrice: tk.lastPrice, priceChangePercent: (+tk.price24hPcnt || 0) * 100, quoteVolume: tk.turnover24h }
  };
}
/* Histórico de Open Interest próprio: a Bybit retirou o endpoint de histórico,
   então amostramos o OI atual (do tickers, que funciona) a cada ciclo e guardamos
   no state.json. Após ~6h rodando, oiChange(6h) fica disponível com dado real. */
function oiSample(sym, val){
  if(!val || !isFinite(val)) return;
  const h = state.oiHist = state.oiHist || {};
  const arr = (h[sym] = h[sym] || []).filter(x => Date.now() - x.ts < 26 * 3600000);
  arr.push({ ts: Date.now(), v: val });
  if(arr.length > 170) arr.shift();
  h[sym] = arr;
}
function oiChange(sym, val, horas){
  const arr = (state.oiHist && state.oiHist[sym]) || [];
  if(arr.length < 2 || !val) return null;
  const alvo = Date.now() - horas * 3600000;
  let best = null, bd = Infinity;
  for(const x of arr){ const d = Math.abs(x.ts - alvo); if(d < bd){ bd = d; best = x; } }
  if(!best || bd > 45 * 60000) return null;
  return aiRound((val / best.v - 1) * 100);
}
/* Fluxo de agressor (taker): a Bybit não fornece volume comprador por candle
   como a Binance; usamos as últimas 1000 negociações reais (lado agressor).
   FLOW é aplicado só aos cálculos do ativo em análise — BTC fica neutro. */
let FLOW = null;
function flowFromTrades(tr){
  const list = Array.isArray(tr) ? tr : [];
  let buy = 0, sell = 0;
  for(const t of list){ const q = Number(t.q) || 0; if(t.m === false) buy += q; else sell += q; }
  const tot = buy + sell;
  return tot ? { ratio: buy / tot, imb: (buy - sell) / tot } : { ratio: 0.5, imb: 0 };
}

const PROFILES = {
  padrao: { nome: 'Padrão', tfs: ['15m', '1h', '4h'], hold: 4 * 3600000 },
  scalp:  { nome: 'SCALP',  tfs: ['5m', '15m', '30m'], hold: 2 * 3600000 },
  swing:  { nome: 'SWING',  tfs: ['1h', '4h', '1d'],  hold: 48 * 3600000 }
};

const CFG = {
  profile: PROFILES[ENV.PROFILE] ? ENV.PROFILE : 'padrao',
  intervalMin: Math.max(3, Number(ENV.INTERVAL_MIN) || 5),
  cooldownMin: Math.max(15, Number(ENV.ALERT_COOLDOWN_MIN) || 120),
  watchlist: String(ENV.WATCHLIST || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,SUIUSDT')
    .split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9_]{5,20}$/.test(s)).slice(0, 40),
  // Blindagem de credenciais: remove espaços, aspas e caracteres inválidos
  // que venham colados no valor da variável (causa clássica de "Not Found").
  tgToken: String(ENV.TELEGRAM_TOKEN || '').replace(/[^A-Za-z0-9_:-]/g, '').trim(),
  tgChat: String(ENV.TELEGRAM_CHAT || '').replace(/[^-0-9]/g, '').trim(),
  waPhone: String(ENV.WA_PHONE || '').replace(/[^+0-9]/g, '').trim(),
  waKey: String(ENV.WA_KEY || '').replace(/[^A-Za-z0-9]/g, '').trim(),
  gateOn: String(ENV.V11_GATE ?? '1') !== '0',
  port: Number(ENV.PORT) || 7860,
  stateFile: String(ENV.STATE_FILE || 'state.json')
};

/* ---------------- util ---------------- */
function log(msg){
  console.log('[' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }) + '] ' + msg);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function aiRound(x){ if(x == null || !isFinite(x)) return null; const a = Math.abs(x); return a >= 1000 ? Number(x.toFixed(2)) : a >= 1 ? Number(x.toFixed(4)) : Number(x.toFixed(6)); }

/* ---------------- anti-ban ----------------
   IPs de servidores gratuitos sao compartilhados e a Binance limita
   requisicoes em rajada (429 -> ban temporario 418). Estrategia:
   - espaco maior entre simbolos (SCAN_GAP_MS)
   - cache dos candles do BTC (era baixado de novo para CADA ativo)
   - pausa global automatica ao receber 429/418 */
let BAN_UNTIL = 0, BAN_HITS = 0;
async function fetchJson(url, timeout = 9000){
  if(Date.now() < BAN_UNTIL) throw new Error('HTTP 429 (pausa anti-ban ativa, aguarde)');
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try{
    const r = await fetch(url, { cache: 'no-store', signal: c.signal });
    if(!r.ok){
      if(r.status === 429 || r.status === 418){
        // Pausa progressiva: 10, 20, 30... até 60min. Martelar a Binance
        // durante o ban renova a suspensão — quanto mais 418, mais espera.
        BAN_HITS++;
        const pausaMin = Math.min(60, 10 * BAN_HITS);
        BAN_UNTIL = Date.now() + pausaMin * 60000;
        log('⏸ Binance limitou o IP (' + r.status + ') — pausa de ' + pausaMin + 'min (offset anti-ban ' + BAN_HITS + ')');
        throw new Error('HTTP ' + r.status + ' (pausa de ' + pausaMin + 'min)');
      }
      throw new Error('HTTP ' + r.status);
    }
    BAN_HITS = 0;
    return await r.json();
  } finally { clearTimeout(t); }
}
async function fetchJsonRetry(url, tries = 2){
  let err;
  for(let i = 0; i < tries; i++){
    try { return await fetchJson(url); } catch(e){
      err = e;
      if(i < tries - 1) await sleep(/429|418/.test(e.message) ? 15000 : 800);
    }
  }
  throw err;
}
/* Cache dos candles do BTC (1h/4h): validos por 5 min, compartilhados
   por todos os ativos do ciclo. Reduz ~2 chamadas por ativo. */
const BTC_KCACHE = {};
async function btcKlines(tf, limit){
  const c = BTC_KCACHE[tf];
  if(c && Date.now() - c.ts < 300000) return c.k.slice(-limit);
  const k = await byKlines('BTCUSDT', tf, 120);
  BTC_KCACHE[tf] = { k, ts: Date.now() };
  return k.slice(-limit);
}

/* ---------------- indicadores (idênticos ao painel) ---------------- */
function aiEma(arr, p){ if(arr.length < p) return null; const k = 2 / (p + 1); let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p; for(let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; }
function aiRsi(arr, p = 14){ if(arr.length <= p) return null; let g = 0, l = 0; for(let i = 1; i <= p; i++){ const d = arr[i] - arr[i - 1]; if(d >= 0) g += d; else l -= d; } let ag = g / p, al = l / p; for(let i = p + 1; i < arr.length; i++){ const d = arr[i] - arr[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; } return al === 0 ? 100 : 100 - (100 / (1 + ag / al)); }
function aiAtr(kl, p = 14){ if(kl.length <= p) return null; const tr = []; for(let i = 1; i < kl.length; i++){ const h = +kl[i][2], l = +kl[i][3], pc = +kl[i - 1][4]; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p; for(let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p; return a; }
function aiAdx(kl, p = 14){ if(kl.length < 2 * p + 2) return null; const tr = [], plus = [], minus = []; for(let i = 1; i < kl.length; i++){ const h = +kl[i][2], l = +kl[i][3], ph = +kl[i - 1][2], pl = +kl[i - 1][3], pc = +kl[i - 1][4]; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); const up = h - ph, down = pl - l; plus.push(up > down && up > 0 ? up : 0); minus.push(down > up && down > 0 ? down : 0); } let atr = tr.slice(0, p).reduce((a, b) => a + b, 0) / p, ps = plus.slice(0, p).reduce((a, b) => a + b, 0) / p, ms = minus.slice(0, p).reduce((a, b) => a + b, 0) / p; const dx = []; for(let i = p; i < tr.length; i++){ atr = (atr * (p - 1) + tr[i]) / p; ps = (ps * (p - 1) + plus[i]) / p; ms = (ms * (p - 1) + minus[i]) / p; const pdi = 100 * ps / atr, mdi = 100 * ms / atr; dx.push(100 * Math.abs(pdi - mdi) / (pdi + mdi || 1)); } if(dx.length < p) return null; let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p; for(let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p; return adx; }

const v11Clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, Number(x) || 0));
const SCAN_GAP_MS = Math.max(2000, Number(ENV.SCAN_GAP_MS) || 4000);
function v11EMA(a, p){ if(a.length < p) return null; let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p, k = 2 / (p + 1); for(let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function v11RSI(a, p = 14){ if(a.length <= p) return null; let g = 0, l = 0; for(let i = 1; i <= p; i++){ let d = a[i] - a[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); } let ag = g / p, al = l / p; for(let i = p + 1; i < a.length; i++){ let d = a[i] - a[i - 1]; ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p; } return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function v11ATR(k, p = 14){ if(k.length <= p) return null; let tr = []; for(let i = 1; i < k.length; i++){ let h = +k[i][2], l = +k[i][3], pc = +k[i - 1][4]; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); } let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p; for(let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p; return a; }
function v11Adx(k, p = 14){ if(k.length < 2 * p + 5) return null; let tr = [], plus = [], minus = []; for(let i = 1; i < k.length; i++){ let h = +k[i][2], l = +k[i][3], ph = +k[i - 1][2], pl = +k[i - 1][3], pc = +k[i - 1][4]; tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); let up = h - ph, dn = pl - l; plus[i] = up > dn && up > 0 ? up : 0; minus[i] = dn > up && dn > 0 ? dn : 0; } let atr = tr.slice(1, p + 1).reduce((a, b) => a + b, 0) / p, ps = plus.slice(1, p + 1).reduce((a, b) => a + b, 0) / p, ms = minus.slice(1, p + 1).reduce((a, b) => a + b, 0) / p, dx = []; for(let i = p + 1; i < k.length; i++){ atr = (atr * (p - 1) + tr[i]) / p; ps = (ps * (p - 1) + plus[i]) / p; ms = (ms * (p - 1) + minus[i]) / p; let P = 100 * ps / (atr || 1), M = 100 * ms / (atr || 1); dx.push(100 * Math.abs(P - M) / (P + M || 1)); } if(dx.length < p) return null; let a = dx.slice(0, p).reduce((x, y) => x + y, 0) / p; for(let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p; return a; }
function v11Corr(a, b){ const n = Math.min(60, a.length - 1, b.length - 1); if(n < 20) return null; const ra = [], rb = []; for(let i = a.length - n; i < a.length; i++) ra.push((a[i] - a[i - 1]) / (a[i - 1] || 1)); for(let i = b.length - n; i < b.length; i++) rb.push((b[i] - b[i - 1]) / (b[i - 1] || 1)); const m = Math.min(ra.length, rb.length); const ma = ra.reduce((x, y) => x + y, 0) / m, mb = rb.reduce((x, y) => x + y, 0) / m; let num = 0, da = 0, db = 0; for(let i = 0; i < m; i++){ const x = ra[i] - ma, y = rb[i] - mb; num += x * y; da += x * x; db += y * y; } const den = Math.sqrt(da * db); return den ? num / den : null; }
function v11TrendScore(c){ if(!c) return 0; let x = 0; if(c.e9 > c.e21) x += 8; else x -= 8; if(c.e21 > c.e50) x += 7; else x -= 7; if(c.e50 > c.e200) x += 5; else x -= 5; if(c.r >= 52 && c.r <= 68) x += 8; else if(c.r > 70 || c.r < 30) x -= 5; if(c.adx >= 25) x += 7; else if(c.adx < 18) x -= 4; return x; }
function v11Regime(c1, c4){ const same = c1.trend === c4.trend && c1.trend !== 'mixed', adx = Math.max(c1.adx || 0, c4.adx || 0), atr = c1.atrPct || 0; if(atr > 2.5) return { name: 'HIGH VOLATILITY', quality: 'CUIDADO' }; if(same && adx >= 25) return { name: c1.trend === 'bull' ? 'TREND BULL' : 'TREND BEAR', quality: 'FORTE' }; if(adx < 18) return { name: 'RANGE', quality: 'BAIXA' }; return { name: 'MIXED / TRANSIÇÃO', quality: 'MÉDIA' }; }
function v11Calc(k){
  k = (Array.isArray(k) ? k : []).filter(x => Number(x[6]) <= Date.now());
  const c = k.map(x => +x[4]), v = k.map(x => +x[5]);
  const e9 = v11EMA(c, 9), e21 = v11EMA(c, 21), e50 = v11EMA(c, 50), e200 = c.length >= 200 ? v11EMA(c, 200) : null;
  const r = v11RSI(c), atr = v11ATR(k), adx = v11Adx(k);
  const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, v.slice(-21, -1).length);
  let tR, takerImbalance;
  if(FLOW){ tR = FLOW.ratio; takerImbalance = FLOW.imb; }
  else {
    const tb = k.map(x => +x[9] || 0), n20 = Math.min(20, v.length);
    const buy20 = tb.slice(-n20).reduce((a, b) => a + b, 0), vol20 = v.slice(-n20).reduce((a, b) => a + b, 0);
    tR = buy20 / (vol20 || 1);
    takerImbalance = vol20 ? (2 * buy20 - vol20) / vol20 : 0;
  }
  return { close: c.at(-1), prev: c.at(-2), e9, e21, e50, e200, r, atr, atrPct: atr / c.at(-1) * 100, adx, vol: v.at(-1), volRatio: v.at(-1) / (avg || 1), takerRatio: tR, takerImbalance, cvdBias: takerImbalance, trend: e200 != null && e9 > e21 && e21 > e50 && e50 > e200 ? 'bull' : e200 != null && e9 < e21 && e21 < e50 && e50 < e200 ? 'bear' : 'mixed', high20: Math.max(...k.slice(-20).map(x => +x[2])), low20: Math.min(...k.slice(-20).map(x => +x[3])) };
}

/* Requisições SEQUENCIAIS com respiro: rajada simultânea (Promise.all com 11
   chamadas) é o gatilho do ban 418 da Binance em IPs compartilhados. */
const REQ_GAP_MS = Math.max(150, Number(ENV.REQ_GAP_MS) || 400);
async function seq(jobs){
  const out = [];
  for(const j of jobs){ out.push(await j()); await sleep(REQ_GAP_MS); }
  return out;
}

/* ---------------- contexto de mercado (igual aiFetchContext do painel) ---------------- */
async function buildContext(sym, tfs){
  const LIMITS = { '5m': 220, '15m': 220, '30m': 220, '1h': 220, '4h': 220, '1d': 220 };
  const raw = async (tf) => byKlines(sym, tf, LIMITS[tf] || 220);
  const [kA, kB, kC, tkr, k7d, b1h, b4h, depth, trades] = await seq([
    () => raw(tfs[0]), () => raw(tfs[1]), () => raw(tfs[2]),
    () => byTickers(sym),
    () => byKlines(sym, '1d', 8),
    () => btcKlines('1h', 100),
    () => btcKlines('4h', 100),
    () => byBook(sym, 50).catch(() => null),
    () => byTrades(sym).catch(() => [])
  ]);
  const calc = (k) => {
    k = (Array.isArray(k) ? k : []).filter(x => Number(x[6]) <= Date.now());
    const c = k.map(x => +x[4]), v = k.map(x => +x[5]);
    const e9 = aiEma(c, 9), e21 = aiEma(c, 21), e50 = aiEma(c, 50), e200 = c.length >= 200 ? aiEma(c, 200) : null, r = aiRsi(c), a = aiAtr(k), adx = aiAdx(k);
    const last = c[c.length - 1], prev = c[c.length - 2];
    const vol = v[v.length - 1], vavg = v.slice(-21, -1).reduce((x, y) => x + y, 0) / Math.max(1, v.slice(-21, -1).length);
    const highs = k.slice(-30).map(x => +x[2]), lows = k.slice(-30).map(x => +x[3]);
    let takerRatio, takerImbalance;
    if(FLOW){ takerRatio = FLOW.ratio; takerImbalance = FLOW.imb; }
    else {
      const tb = k.map(x => +x[9] || 0), n20 = Math.min(20, v.length);
      const vol20 = v.slice(-n20).reduce((x, y) => x + y, 0) || 1;
      const buy20 = tb.slice(-n20).reduce((x, y) => x + y, 0);
      takerRatio = buy20 / vol20;
      takerImbalance = (2 * buy20 - vol20) / vol20;
    }
    return { close: aiRound(last), prevClose: aiRound(prev), rsi: aiRound(r), ema9: aiRound(e9), ema21: aiRound(e21), ema50: aiRound(e50), ema200: e200 == null ? null : aiRound(e200), atr: aiRound(a), atrPct: aiRound(a / last * 100), adx: aiRound(adx), volume: aiRound(vol), volumeRatio: aiRound(vol / (vavg || 1)), high30: aiRound(Math.max(...highs)), low30: aiRound(Math.min(...lows)), takerRatio: aiRound(takerRatio), takerImbalance: aiRound(takerImbalance), cvdBias: aiRound(takerImbalance), trend: e200 != null && e9 > e21 && e21 > e50 && e50 > e200 ? 'bull' : e200 != null && e9 < e21 && e21 < e50 && e50 < e200 ? 'bear' : 'mixed' };
  };
  FLOW = flowFromTrades(trades);
  const cA = calc(kA), cB = calc(kB), cC = calc(kC);
  FLOW = null;
  const k7Closed = (Array.isArray(k7d) ? k7d : []).filter(x => Number(x[6]) <= Date.now());
  const c7First = +(k7Closed[0]?.[1] || 0), c7Last = +(k7Closed.at(-1)?.[4] || 0);
  const fr = +(tkr.fund.lastFundingRate) || 0, oiVal = +(tkr.oi.openInterest) || 0;
  const price = +(tkr.t24.lastPrice) || cA.close;
  const btc1 = calc(b1h), btc4 = calc(b4h);
  oiSample(sym, oiVal);
  const oiChg6h = oiChange(sym, oiVal, 6), oiChg24h = oiChange(sym, oiVal, 24);
  const bb = Number(depth?.bids?.[0]?.[0]), ba = Number(depth?.asks?.[0]?.[0]);
  const spreadBps = (bb && ba) ? aiRound((ba - bb) / ((ba + bb) / 2) * 10000) : null;
  const hUTC = new Date().getUTCHours();
  const sessao = hUTC < 7 ? 'ÁSIA (liquidez baixa)' : hUTC < 12 ? 'EUROPA' : hUTC < 21 ? 'EUA (maior liquidez)' : 'PÓS-EUA';
  const corrBtc = v11Corr(kB.map(x => +x[4]), b1h.map(x => +x[4]));
  return { ativo: sym, price: aiRound(price), var24h: aiRound(+(tkr.t24.priceChangePercent)), var7d: c7First ? aiRound((c7Last - c7First) / c7First * 100) : null, funding: aiRound(fr * 100), openInterest: aiRound(oiVal), oiChange6h: oiChg6h, oiChange24h: oiChg24h, spreadBps, sessao, btcCorrelation: (corrBtc === null ? null : aiRound(corrBtc)), time: new Date().toISOString(), perfil: tfs.join('/'), timeframes: { [tfs[0]]: cA, [tfs[1]]: cB, [tfs[2]]: cC }, btc: { '1h': { trend: btc1.trend, rsi: btc1.rsi, adx: btc1.adx }, '4h': { trend: btc4.trend, rsi: btc4.rsi, adx: btc4.adx } } };
}

/* ---------------- decisão local (checklist a-h + regras duras) ---------------- */
const V11_FACTOR_LABELS = {
  a_tendencia_alinhada: 'Tendência alinhada nos 3 TFs',
  b_momentum: 'Momentum na zona (RSI 50-70 / 30-50)',
  c_adx: 'ADX ≥ 20 (tendência negociável)',
  d_fluxo: 'Fluxo agressor a favor (taker imbalance)',
  e_oi: 'Open Interest confirmando',
  f_estrutura: 'Preço do lado certo da EMA21',
  g_btc: 'BTC não contradiz',
  h_derivativos: 'Derivativos saudáveis (funding/spread)'
};
function localChecklist(ctx, side){
  const long = side === 'LONG';
  const T = Object.keys(ctx.timeframes);
  const A = ctx.timeframes[T[0]], B = ctx.timeframes[T[1]], C = ctx.timeframes[T[2]];
  const bull = long ? 'bull' : 'bear';
  const subiu = A.close > A.prevClose;
  return {
    a_tendencia_alinhada: A.trend === bull && B.trend === bull && C.trend === bull,
    b_momentum: A.rsi != null && (long ? A.rsi >= 50 && A.rsi <= 70 : A.rsi >= 30 && A.rsi <= 50),
    c_adx: [A, B, C].every(x => x.adx != null && x.adx >= 20),
    d_fluxo: long ? [A, B, C].every(x => x.takerImbalance > 0 && x.takerRatio >= 0.5) : [A, B, C].every(x => x.takerImbalance < 0 && x.takerRatio <= 0.5),
    e_oi: ctx.oiChange6h != null && (long ? (ctx.oiChange6h >= 0 && subiu) : (ctx.oiChange6h >= 0 && !subiu)),
    f_estrutura: A.ema21 != null && (long ? A.close > A.ema21 : A.close < A.ema21),
    g_btc: [ctx.btc['1h'].trend, ctx.btc['4h'].trend].every(t => t === bull || t === 'mixed'),
    h_derivativos: Math.abs(ctx.funding) <= 0.15 && (ctx.spreadBps == null || ctx.spreadBps <= 15)
  };
}
function normalizeAIResult(x, ctx, origem){
  const r = x || {};
  const dir = ['LONG', 'SHORT', 'NEUTRO'].includes(String(r.direcao || '').toUpperCase()) ? String(r.direcao).toUpperCase() : 'NEUTRO';
  let conf = Math.max(0, Math.min(100, Number(r.confianca) || 0));
  let status = String(r.status || '').toUpperCase() === 'ENTRADA_VALIDADA' ? 'ENTRADA_VALIDADA' : 'AGUARDAR';
  const rr = aiRound(Number(r.rr));
  const fk = r.fatores_confirmados || {};
  const trueKeys = Object.keys(fk).filter(k => fk[k] === true);
  const nTrue = trueKeys.length;
  if(fk.d_fluxo === false) status = 'AGUARDAR';
  if(status === 'ENTRADA_VALIDADA' && Object.keys(fk).length >= 6 && nTrue < 5) status = 'AGUARDAR';
  if(Object.keys(fk).length >= 6) conf = Math.min(conf, 30 + nTrue * 9);
  if(status === 'ENTRADA_VALIDADA' && (rr == null || rr < AI_MIN_RR || dir === 'NEUTRO')) status = 'AGUARDAR';
  return { direcao: dir, status, confianca: Math.round(conf), setup: ['continuacao_tendencia', 'pullback', 'reversao', 'rompimento'].includes(r.setup) ? r.setup : (status === 'ENTRADA_VALIDADA' ? 'continuacao_tendencia' : null), fatores: fk, nFatores: nTrue, timeStopHoras: (Number(r.timeStopHoras) > 0 && Number(r.timeStopHoras) <= 240) ? aiRound(Number(r.timeStopHoras)) : null, entrada: aiRound(Number(r.entrada)), stop_loss: aiRound(Number(r.stop_loss)), alvos: Array.isArray(r.alvos) ? r.alvos.slice(0, 3).map(Number).map(aiRound) : [], rr, invalidacao: r.invalidacao || '--', origem, contexto_ativo: ctx.ativo };
}
function localDecision(ctx){
  const T = Object.keys(ctx.timeframes);
  const A = ctx.timeframes[T[0]];
  const L = localChecklist(ctx, 'LONG'), S = localChecklist(ctx, 'SHORT');
  const nL = Object.values(L).filter(Boolean).length, nS = Object.values(S).filter(Boolean).length;
  const tie = nL === nS;
  const long = nL > nS;
  const side = tie ? 'NEUTRO' : (long ? 'LONG' : 'SHORT');
  const fk = tie ? L : (long ? L : S);
  const nTrue = Math.max(nL, nS);
  const atr = A.atr || (A.close * 0.008);
  const asiaScalp = /ÁSIA/.test(ctx.sessao || '') && T[0] === '5m';
  const risk = (asiaScalp ? 1.0 : 1.25) * atr;
  const entry = A.close;
  const stop = long ? entry - risk : entry + risk;
  const tp1 = long ? entry + 2 * risk : entry - 2 * risk;
  const tp2 = long ? entry + 3 * risk : entry - 3 * risk;
  let setup = 'continuacao_tendencia';
  if(long ? A.close >= A.high30 * 0.998 : A.close <= A.low30 * 1.002) setup = 'rompimento';
  else if(long ? (A.rsi != null && A.rsi <= 30) : (A.rsi != null && A.rsi >= 70)) setup = 'reversao';
  else if(Math.abs(A.close - A.ema21) <= 0.6 * atr) setup = 'pullback';
  const timeStopHoras = T[0] === '5m' ? 2 : T[0] === '1d' ? 48 : 8;
  const spreadOk = ctx.spreadBps == null || ctx.spreadBps <= 15;
  const valida = !tie && nTrue >= 5 && fk.d_fluxo && spreadOk;
  let conf = 30 + nTrue * 9;
  if(asiaScalp) conf -= 10;
  const just = Object.keys(fk).filter(k => fk[k]).map(k => V11_FACTOR_LABELS[k]);
  const riscos = Object.keys(fk).filter(k => !fk[k]).map(k => 'Falhou: ' + V11_FACTOR_LABELS[k]);
  if(/ÁSIA/.test(ctx.sessao || '')) riscos.push('Sessão de baixa liquidez: ' + ctx.sessao);
  if(ctx.btcCorrelation != null && ctx.btcCorrelation > 0.8) riscos.push('Correlação alta com BTC (' + ctx.btcCorrelation + ')');
  const raw = {
    direcao: valida ? side : 'NEUTRO',
    status: valida ? 'ENTRADA_VALIDADA' : 'AGUARDAR',
    setup: valida ? setup : null,
    confianca: Math.max(30, Math.min(100, conf)),
    fatores_confirmados: fk,
    entrada: entry, stop_loss: stop, alvos: [tp1, tp2], rr: 2,
    timeStopHoras,
    invalidacao: valida ? ('Fecha ' + (long ? 'abaixo' : 'acima') + ' da EMA21 (' + T[0] + ') ou stop atingido') : 'Sem setup válido: complete a checklist (mín. 5 fatores + fluxo)',
    justificativa: just, riscos: riscos.slice(0, 5)
  };
  return normalizeAIResult(raw, ctx, 'VINGADOR V11 · BOT 24H');
}

/* ---------------- selo V11 (igual v11Compute do painel) ---------------- */
async function v11Gate(sym){
  const [k15, k1, k4, b1, b4, depth, trades, tkr] = await seq([
    () => byKlines(sym, '15m', 220),
    () => byKlines(sym, '1h', 220),
    () => byKlines(sym, '4h', 220),
    () => btcKlines('1h', 120),
    () => btcKlines('4h', 120),
    () => byBook(sym, 200).catch(() => ({ bids: [], asks: [] })),
    () => byTrades(sym).catch(() => []),
    () => byTickers(sym)
  ]);
  const fund = tkr.fund, oi = tkr.oi, t24 = { quoteVolume: tkr.t24.quoteVolume };
  if(!Array.isArray(k15) || !k15.length || !Array.isArray(k1) || !k1.length || !Array.isArray(k4) || !k4.length || !Array.isArray(b1) || !b1.length || !Array.isArray(b4) || !b4.length) throw new Error('Histórico insuficiente para V11');
  FLOW = flowFromTrades(trades);
  const c15 = v11Calc(k15), c1 = v11Calc(k1), c4 = v11Calc(k4);
  FLOW = null;
  const btc1 = v11Calc(b1), btc4 = v11Calc(b4);
  const regime = v11Regime(c1, c4);
  const mtf = (c15.trend === c1.trend && c1.trend === c4.trend && c1.trend !== 'mixed') ? 20 : (c1.trend === c4.trend && c1.trend !== 'mixed' ? 12 : 0);
  const trend = v11Clamp(30 + v11TrendScore(c15) + v11TrendScore(c1) + v11TrendScore(c4), 0, 30);
  const volume = c15.volRatio >= 1.5 ? 10 : c15.volRatio >= 1 ? 6 : 2;
  let deriv = 0; const fr = +fund.lastFundingRate * 100; const oiVal = +oi.openInterest;
  if((c15.trend === 'bull' && fr < 0.08) || (c15.trend === 'bear' && fr > -0.08)) deriv += 5;
  if(Math.abs(fr) > 0.1) deriv -= 3;
  const btc = (btc1.trend === btc4.trend && btc1.trend === c1.trend) ? 10 : (btc1.trend === c1.trend ? 5 : -5);
  let structure = 0;
  if(c15.trend === 'bull') structure = c15.close > c15.e21 ? 8 : -4;
  else if(c15.trend === 'bear') structure = c15.close < c15.e21 ? 8 : -4;
  const bids = depth.bids || [], asks = depth.asks || [];
  const mid = ((Number(bids?.[0]?.[0]) || 0) + (Number(asks?.[0]?.[0]) || 0)) / 2;
  const near = (arr) => arr.slice(0, 20).reduce((sum, x) => {
    const px = Number(x[0]), qty = Number(x[1]);
    if(!px || !qty || !mid) return sum;
    const dist = Math.abs(px - mid) / mid;
    return sum + px * qty * (1 / (1 + dist * 250));
  }, 0);
  const bidNot = near(bids), askNot = near(asks);
  const imb = (bidNot + askNot) ? (bidNot - askNot) / (bidNot + askNot) : 0;
  let whaleBuy = 0, whaleSell = 0, whaleN = 0;
  const whaleNow = Date.now();
  const q24 = Math.max(0, Number(t24.quoteVolume) || 0);
  const whaleThreshold = Math.max(50000, q24 * 0.0002);
  for(const t of trades){
    if(whaleNow - Number(t.T) > 3600000) continue;
    const q = Number(t.p) * Number(t.q);
    if(q >= whaleThreshold){ if(t.m) whaleSell += q; else whaleBuy += q; whaleN++; }
  }
  const whaleTotal = whaleBuy + whaleSell, whaleBias = whaleTotal ? (whaleBuy - whaleSell) / whaleTotal : 0;
  const corrBtc = v11Corr(k1.map(x => +x[4]), b1.map(x => +x[4]));
  const bb = Number(depth.bids?.[0]?.[0]), ba = Number(depth.asks?.[0]?.[0]);
  const spreadBps = (bb && ba) ? ((ba - bb) / ((ba + bb) / 2) * 10000) : null;
  const oiValBy = +oi.openInterest || 0;
  oiSample(sym, oiValBy);
  const oiChg6h = oiChange(sym, oiValBy, 6);
  const px6h = k1.length >= 7 ? (+k1[k1.length - 1][4] / +k1[k1.length - 7][4] - 1) * 100 : 0;
  const cvdScore = v11Clamp((c15.takerImbalance * 10 + c1.takerImbalance * 8 + c4.takerImbalance * 4) / 1.2, -12, 12);
  const flow = v11Clamp(cvdScore + v11Clamp(imb * 8, -6, 6) + v11Clamp(whaleBias * 5, -5, 5), -22, 22);
  let oiScore = 0;
  if(oiChg6h !== null){ if(oiChg6h > 0.5 && px6h > 0) oiScore = 7; else if(oiChg6h > 0.5 && px6h < 0) oiScore = -7; else if(oiChg6h < -0.5) oiScore = -2; }
  let penalty = 0;
  if(regime.name === 'RANGE') penalty += 12;
  if(regime.name === 'HIGH VOLATILITY') penalty += 15;
  if(regime.name.includes('TRANSIÇÃO')) penalty += 6;
  if(Math.abs(imb) < 0.03) penalty += 2;
  if((c15.atrPct || 0) > 1.8) penalty += 5;
  if(c1.trend !== c4.trend) penalty += 8;
  if(Math.abs(fr) > 0.15) penalty += 7;
  if(btc1.trend !== c1.trend) penalty += 8;
  if(corrBtc !== null && Math.abs(corrBtc) < 0.3) penalty += 5;
  if(spreadBps !== null && spreadBps > 15) penalty += 10;
  const rawScore = mtf + trend + volume + deriv + btc + structure + flow + oiScore;
  const score = Math.round(v11Clamp(rawScore - penalty, 0, 100));
  let gate = score >= 75 && penalty < 25 && regime.name !== 'RANGE' ? 'ENTRADA POTENCIAL' : score >= 60 ? 'AGUARDAR CONFIRMAÇÃO' : 'BLOQUEADO';
  if(regime.name === 'HIGH VOLATILITY') gate = 'BLOQUEADO';
  if(gate === 'ENTRADA POTENCIAL' && flow < -8) gate = 'AGUARDAR CONFIRMAÇÃO';
  return { score, gate, penalty, flow, imb, fr, spreadBps, whaleBias, oiChg6h, regime: regime.name };
}

/* ---------------- alertas ---------------- */
const SETUP_LABEL = { continuacao_tendencia: 'Continuação de tendência', pullback: 'Pullback', reversao: 'Reversão', rompimento: 'Rompimento' };
function fmtV(v){ const n = Number(v); return (v === undefined || v === null || !isFinite(n)) ? '--' : n; }
function buildPlano(sym, res, perfil, v11){
  const side = res.direcao, emoji = side === 'LONG' ? '🟢' : '🔴';
  let p =
    emoji + ' ' + sym + ' · ' + side + ' · ENTRADA VALIDADA (VINGADOR BOT 24H)\n' +
    '⏱ Perfil: ' + perfil.nome + ' · ' + perfil.tfs.join('/') + '\n' +
    '🧩 Setup: ' + (SETUP_LABEL[res.setup] || res.setup || '--') + ' · checklist ' + (res.nFatores || 0) + '/8 fatores\n' +
    '🎯 Entrada: ' + fmtV(res.entrada) + '\n' +
    '🛑 Stop: ' + fmtV(res.stop_loss) + '\n' +
    '🏁 TP1: ' + fmtV(res.alvos?.[0]) + (res.alvos?.[1] !== undefined ? ' | TP2: ' + fmtV(res.alvos[1]) : '') + '\n' +
    '⚖️ R:R 1:' + fmtV(res.rr) + ' · Confiança: ' + fmtV(res.confianca) + '%\n' +
    '⌛ Time stop: ' + (res.timeStopHoras ? res.timeStopHoras + 'h' : '--') + '\n' +
    '❌ Invalida se: ' + (res.invalidacao || '--') + '\n';
  if(v11) p += '🛡 Selo V11: ' + v11.gate + ' · score ' + v11.score + ' · regime ' + v11.regime + '\n';
  p += '⚙️ VINGADOR V11 · bot 24h no servidor';
  return p;
}
async function sendTelegram(text){
  try{
    const r = await fetch(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CFG.tgChat, text })
    });
    const j = await r.json().catch(() => ({}));
    if(!j.ok) log('Telegram erro: ' + (j.description || r.status));
  } catch(e){ log('Telegram falhou: ' + e.message); }
}
async function sendWhatsApp(text){
  try{
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CFG.waPhone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CFG.waKey)}`;
    await fetch(url);
  } catch(e){ log('WhatsApp falhou: ' + e.message); }
}
async function sendAlert(text){
  log('🔔 ALERTA → ' + text.split('\n')[0]);
  const jobs = [];
  if(CFG.tgToken && CFG.tgChat) jobs.push(sendTelegram(text));
  if(CFG.waPhone && CFG.waKey) jobs.push(sendWhatsApp(text));
  if(!jobs.length) log('(sem Telegram/WhatsApp configurado — alerta apenas no log/status)');
  await Promise.allSettled(jobs);
}

/* ---------------- placar (TP1 x Stop, igual ao painel) ---------------- */
function trackSignal(sym, res, maxHold){
  const entry = Number(res.entrada), sl = Number(res.stop_loss), tp1 = Number(res.alvos?.[0]);
  if(!isFinite(entry) || entry <= 0 || !isFinite(sl) || sl <= 0 || !isFinite(tp1) || tp1 <= 0) return;
  if(state.signals.some(s => s.sym === sym && s.state === 'open')) return;
  state.signals.push({ sym, side: res.direcao, entry, sl, tp1, ts: Date.now(), state: 'open', maxHold: maxHold || (4 * 3600000), perfil: PROFILES[CFG.profile].nome });
  if(state.signals.length > 100) state.signals = state.signals.slice(-100);
}
function notifyScore(s, result){
  const txt = result === 'WIN'
    ? '✅ ' + s.sym + ' · ' + s.side + ' · bateu o TP1\n🎯 Entrada ' + fmtV(s.entry) + ' · TP1 ' + fmtV(s.tp1)
    : result === 'LOSS'
      ? '❌ ' + s.sym + ' · ' + s.side + ' · bateu o STOP\n🎯 Entrada ' + fmtV(s.entry) + ' · Stop ' + fmtV(s.sl)
      : '⏱ ' + s.sym + ' · ' + s.side + ' · time stop (sem direção no prazo)\n🎯 Entrada ' + fmtV(s.entry);
  sendAlert(txt + '\n🏆 Placar do bot');
}
async function scoreTick(){
  const open = state.signals.filter(s => s.state === 'open');
  if(!open.length) return;
  const syms = [...new Set(open.map(s => s.sym))];
  try{
    const r = await bbJson(`${BYBIT}/v5/market/tickers?category=linear`);
    const px = {};
    ((r.result && r.result.list) || []).forEach(x => { px[x.symbol] = parseFloat(x.lastPrice); });
    let changed = false;
    for(const s of open){
      const p = px[s.sym]; if(!p) continue;
      const hitTP = s.side === 'LONG' ? p >= s.tp1 : p <= s.tp1;
      const hitSL = s.side === 'LONG' ? p <= s.sl : p >= s.sl;
      if(hitSL){ s.state = 'loss'; s.exit = p; s.closedTs = Date.now(); changed = true; await notifyScore(s, 'LOSS'); }
      else if(hitTP){ s.state = 'win'; s.exit = p; s.closedTs = Date.now(); changed = true; await notifyScore(s, 'WIN'); }
      else if(Date.now() - s.ts > s.maxHold){ s.state = 'timeout'; s.exit = p; s.closedTs = Date.now(); changed = true; await notifyScore(s, 'TIMEOUT'); }
    }
    if(changed) saveState();
  } catch(e){ log('scoreTick: ' + e.message); }
}

/* ---------------- estado ---------------- */
let state = { signals: [], alertTs: {}, verdicts: {}, cycles: 0, alertsSent: 0, lastScan: 0, startedAt: Date.now() };
let fsMod = null;
if(isNode){ try { fsMod = require('fs'); } catch(e){} }
function saveState(){
  if(!fsMod) return;
  try{
    fsMod.writeFileSync(CFG.stateFile, JSON.stringify({ signals: state.signals, alertTs: state.alertTs, cycles: state.cycles, alertsSent: state.alertsSent, lastScan: state.lastScan, startedAt: state.startedAt, oiHist: state.oiHist || {} }));
  } catch(e){}
}
function loadState(){
  if(!fsMod) return;
  try{
    const d = JSON.parse(fsMod.readFileSync(CFG.stateFile, 'utf8'));
    if(d && typeof d === 'object'){
      state.signals = Array.isArray(d.signals) ? d.signals : [];
      state.alertTs = d.alertTs || {};
      state.cycles = d.cycles || 0;
      state.alertsSent = d.alertsSent || 0;
      state.lastScan = d.lastScan || 0;
      state.startedAt = d.startedAt || Date.now();
      state.oiHist = (d.oiHist && typeof d.oiHist === 'object') ? d.oiHist : {};
    }
  } catch(e){}
}

/* ---------------- varredura ---------------- */
async function scanSymbol(sym){
  const perfil = PROFILES[CFG.profile];
  const ctx = await buildContext(sym, perfil.tfs);
  const res = localDecision(ctx);
  state.verdicts[sym] = { dir: res.direcao, status: res.status, conf: res.confianca, setup: res.setup, ts: Date.now() };
  if(res.status !== 'ENTRADA_VALIDADA') return;
  const key = sym + ':' + res.direcao;
  const last = state.alertTs[key] || 0;
  if(Date.now() - last < CFG.cooldownMin * 60000){ log('⏳ ' + sym + ' ' + res.direcao + ': sinal válido em cooldown (' + CFG.cooldownMin + 'min)'); return; }
  let v11 = null;
  if(CFG.gateOn){
    try { v11 = await v11Gate(sym); } catch(e){ log('V11 falhou em ' + sym + ': ' + e.message); }
    if(v11 && (v11.score < 60 || v11.gate === 'BLOQUEADO')){
      log('🔒 ' + sym + ': checklist válida mas o V11 bloqueou (score ' + v11.score + ' · ' + v11.gate + ') — descartado');
      state.verdicts[sym].blocked = true;
      return;
    }
  }
  const plano = buildPlano(sym, res, perfil, v11);
  await sendAlert(plano);
  state.alertTs[key] = Date.now();
  state.alertsSent++;
  trackSignal(sym, res, perfil.hold);
  saveState();
}
async function runScanCycle(){
  const t0 = Date.now();
  log('🔎 Varredura iniciada · ' + CFG.watchlist.length + ' ativos · perfil ' + PROFILES[CFG.profile].nome);
  for(const sym of CFG.watchlist){
    try { await scanSymbol(sym); } catch(e){ log('ERRO ' + sym + ': ' + e.message); }
    // Respiro entre ativos: IPs compartilhados de servidor grátis são
    // limitados pela Binance em rajada. 4s é o equilíbrio seguro.
    // Ajustável pela variável SCAN_GAP_MS.
    await sleep(SCAN_GAP_MS);
  }
  state.cycles++;
  state.lastScan = Date.now();
  saveState();
  log('✅ Varredura concluída em ' + Math.round((Date.now() - t0) / 1000) + 's');
}

/* ---------------- status HTTP ---------------- */
function scoreSummary(){
  const rec = state.signals.slice(-20);
  const w = rec.filter(s => s.state === 'win').length, l = rec.filter(s => s.state === 'loss').length;
  const o = rec.filter(s => s.state === 'open').length, t = rec.filter(s => s.state === 'timeout').length;
  return { wins: w, losses: l, open: o, timeouts: t, winrate: (w + l) ? Math.round(w / (w + l) * 100) + '%' : '--' };
}
function startServer(){
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      bot: 'VINGADOR BOT 24H',
      perfil: PROFILES[CFG.profile].nome, tfs: PROFILES[CFG.profile].tfs,
      ativos: CFG.watchlist, cicloMin: CFG.intervalMin, gateV11: CFG.gateOn,
      iniciado: new Date(state.startedAt).toISOString(),
      ultimaVarredura: state.lastScan ? new Date(state.lastScan).toISOString() : null,
      ciclos: state.cycles, alertasEnviados: state.alertsSent,
      placar: scoreSummary(), sinais: state.signals.slice(-20).reverse(),
      vereditos: state.verdicts
    }, null, 2));
  }).listen(CFG.port, () => log('🌐 Status HTTP na porta ' + CFG.port));
}

/* ---------------- boot ---------------- */
if(isNode){
  loadState();
  log('🤖 VINGADOR BOT 24H iniciado · perfil ' + PROFILES[CFG.profile].nome + ' (' + PROFILES[CFG.profile].tfs.join('/') + ') · ' + CFG.watchlist.length + ' ativos · ciclo ' + CFG.intervalMin + 'min' + (CFG.gateOn ? ' · selo V11 ON' : ' · selo V11 OFF'));
  // Diagnóstico de credenciais (mascarado — nunca imprime o token completo):
  if(CFG.tgToken){
    const okFormat = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(CFG.tgToken);
    log('🔑 Telegram: token recebido (' + CFG.tgToken.length + ' chars, começa com "' + CFG.tgToken.slice(0, 8) + '...") · formato ' + (okFormat ? 'válido' : 'INVÁLIDO — deve ser 123456789:AA...') + ' · chat ' + (CFG.tgChat || 'VAZIO!'));
  } else {
    log('❌ Telegram: TELEGRAM_TOKEN vazio — confira a variável no Render → Environment');
  }
  startServer();
  if(CFG.tgToken && CFG.tgChat){
    sendTelegram('🤖 VINGADOR BOT 24H online ✅\nPerfil: ' + PROFILES[CFG.profile].nome + ' (' + PROFILES[CFG.profile].tfs.join('/') + ')\nAtivos: ' + CFG.watchlist.join(', ') + '\nCiclo: a cada ' + CFG.intervalMin + 'min\n🛡 Selo V11: ' + (CFG.gateOn ? 'ativo' : 'desligado'));
  }
  runScanCycle().catch(e => log('ciclo inicial: ' + e.message));
  setInterval(() => runScanCycle().catch(e => log('ciclo: ' + e.message)), CFG.intervalMin * 60000);
  setInterval(() => scoreTick().catch(() => {}), 30000);
} else {
  globalThis.vgScan = runScanCycle;
  globalThis.vgVerdicts = () => state.verdicts;
  globalThis.vgSignals = () => state.signals;
  globalThis.vgState = () => state;
}

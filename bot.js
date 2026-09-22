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
const TF_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
const BYBIT_IV = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
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
  if(list.length && list.length < Math.min(1000, limit)) warnOnce('curto:' + sym + ':' + tf, '⚠ ' + sym + ' ' + tf + ': histórico curto (' + list.length + ' velas de ' + limit + ') — indicadores longos podem ficar inválidos');
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
  // Bybit DEMO: ordens REAIS em conta demo (dinheiro virtual, dados reais).
  // As chaves ficam no Render -> Environment, nunca no código.
  bybitDemo: String(ENV.BYBIT_DEMO ?? '0') === '1',
  bybitKey: String(ENV.BYBIT_API_KEY || '').replace(/[^A-Za-z0-9]/g, '').trim(),
  bybitSecret: String(ENV.BYBIT_API_SECRET || '').replace(/[^A-Za-z0-9]/g, '').trim(),
  // Robô paper trading: executa os sinais em posição SIMULADA no preço real.
  // Limites fixos de segurança (nem você nem eu estouramos por engano):
  robo: String(ENV.ROBO ?? '1') !== '0',
  roboEq: Number(ENV.ROBO_EQ) || 100,                                   // equity virtual inicial ($100 = capital real)
  roboRisk: Math.min(0.02, Number(ENV.ROBO_RISK) || 0.01),              // 1% por trade (teto 2%)
  roboMaxPos: Math.max(1, Math.min(3, Number(ENV.ROBO_MAXPOS) || 2)),   // máx 2 posições (teto 3)
  roboDailyStop: Math.min(0.1, Number(ENV.ROBO_DAILY_STOP) || 0.03),    // kill switch: -3% no dia
  roboLev: Math.max(1, Math.min(20, Number(ENV.ROBO_LEV) || 5)),        // alavancagem 5x (teto 20x)
  roboMetaPct: Math.min(10, Number(ENV.ROBO_META_PCT) || 1.5),          // meta diária: 1.5% da equity (escala com a conta)
  // V12 · Backtest + Walk-Forward (blueprint do auditor V12):
  btDays: Math.min(365, Math.max(7, Number(ENV.BACKTEST_DAYS) || 90)),
  btFeeBps: Math.min(50, Math.max(0, Number(ENV.BACKTEST_FEE_BPS) || 5.5)),
  btSlipBps: Math.min(50, Math.max(0, Number(ENV.BACKTEST_SLIPPAGE_BPS) || 2)),
  btTrainPct: Math.min(0.9, Math.max(0.5, Number(ENV.BACKTEST_TRAIN_PCT) || 0.70)),
  btMinTrades: Math.max(10, Number(ENV.BACKTEST_MIN_TRADES) || 30),
  btRR: Math.min(5, Math.max(1, Number(ENV.BACKTEST_RR) || 2)),
  btMaxHoldBars: Math.max(4, Number(ENV.BACKTEST_MAX_HOLD_BARS) || 32),
  btAuto: String(ENV.BACKTEST_AUTO ?? '0') === '1',
  btFolds: Math.max(2, Math.min(6, Number(ENV.BACKTEST_FOLDS) || 3)),
  btFundBps: Math.min(20, Math.max(0, Number(ENV.BACKTEST_FUNDING_BPS) || 1)),
  port: Number(ENV.PORT) || 7860,
  stateFile: String(ENV.STATE_FILE || 'state.json')
};

/* ---------------- util ---------------- */
function log(msg){
  console.log('[' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }) + '] ' + msg);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function aiRound(x){ if(x == null || !isFinite(x)) return null; const a = Math.abs(x); return a >= 1000 ? Number(x.toFixed(2)) : a >= 1 ? Number(x.toFixed(4)) : Number(x.toFixed(6)); }
const WARN_ONCE = new Set();
function warnOnce(key, msg){ if(WARN_ONCE.has(key)) return; WARN_ONCE.add(key); log(msg); }

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
function v11Calc(k, withFlow){
  k = (Array.isArray(k) ? k : []).filter(x => Number(x[6]) <= Date.now());
  const c = k.map(x => +x[4]), v = k.map(x => +x[5]);
  const e9 = v11EMA(c, 9), e21 = v11EMA(c, 21), e50 = v11EMA(c, 50), e200 = c.length >= 200 ? v11EMA(c, 200) : null;
  const r = v11RSI(c), atr = v11ATR(k), adx = v11Adx(k);
  const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, v.slice(-21, -1).length);
  let tR, takerImbalance;
  if(withFlow && FLOW){ tR = FLOW.ratio; takerImbalance = FLOW.imb; }
  else {
    const tb = k.map(x => +x[9] || 0), n20 = Math.min(20, v.length);
    const buy20 = tb.slice(-n20).reduce((a, b) => a + b, 0), vol20 = v.slice(-n20).reduce((a, b) => a + b, 0);
    const hasTb = tb.some(x => x > 0);
    tR = hasTb ? buy20 / (vol20 || 1) : null;
    takerImbalance = hasTb ? (2 * buy20 - vol20) / vol20 : null;
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
  const calc = (k, withFlow) => {
    k = (Array.isArray(k) ? k : []).filter(x => Number(x[6]) <= Date.now());
    const c = k.map(x => +x[4]), v = k.map(x => +x[5]);
    const e9 = aiEma(c, 9), e21 = aiEma(c, 21), e50 = aiEma(c, 50), e200 = c.length >= 200 ? aiEma(c, 200) : null, r = aiRsi(c), a = aiAtr(k), adx = aiAdx(k);
    const last = c[c.length - 1], prev = c[c.length - 2];
    const vol = v[v.length - 1], vavg = v.slice(-21, -1).reduce((x, y) => x + y, 0) / Math.max(1, v.slice(-21, -1).length);
    const highs = k.slice(-30).map(x => +x[2]), lows = k.slice(-30).map(x => +x[3]);
    const lastK = k[k.length - 1];
    const lastRange = lastK ? (+lastK[2] - +lastK[3]) : null;
    let takerRatio, takerImbalance;
    if(withFlow && FLOW){ takerRatio = FLOW.ratio; takerImbalance = FLOW.imb; }
    else {
      const tb = k.map(x => +x[9] || 0), n20 = Math.min(20, v.length);
      const vol20 = v.slice(-n20).reduce((x, y) => x + y, 0) || 1;
      const buy20 = tb.slice(-n20).reduce((x, y) => x + y, 0);
      /* Fonte sem campo agressor (klines da Bybit não têm)? Nulo = fator
         falha seguro, em vez de veredito "agressor vendedor" fabricado. */
      const hasTb = tb.some(x => x > 0);
      takerRatio = hasTb ? buy20 / vol20 : null;
      takerImbalance = hasTb ? (2 * buy20 - vol20) / vol20 : null;
    }
    return { close: aiRound(last), prevClose: aiRound(prev), rsi: aiRound(r), ema9: aiRound(e9), ema21: aiRound(e21), ema50: aiRound(e50), ema200: e200 == null ? null : aiRound(e200), atr: aiRound(a), atrPct: aiRound(a / last * 100), adx: aiRound(adx), volume: aiRound(vol), volumeRatio: aiRound(vol / (vavg || 1)), high30: aiRound(Math.max(...highs)), low30: aiRound(Math.min(...lows)), lastRange: lastRange == null ? null : aiRound(lastRange), takerRatio: aiRound(takerRatio), takerImbalance: aiRound(takerImbalance), cvdBias: aiRound(takerImbalance), trend: e200 != null && e9 > e21 && e21 > e50 && e50 > e200 ? 'bull' : e200 != null && e9 < e21 && e21 < e50 && e50 < e200 ? 'bear' : 'mixed' };
  };
  FLOW = flowFromTrades(trades);
  const cA = calc(kA, true), cB = calc(kB), cC = calc(kC);
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
    /* Fluxo honesto (auditoria V12): o snapshot de 1000 negociações cobre
       honestamente a janela do 1º TF — não dá pra fingir "3 TFs every" com
       o mesmo valor. Falha seguro se a fonte não tiver taker. */
    d_fluxo: A.takerImbalance != null && (long ? (A.takerImbalance > 0 && A.takerRatio >= 0.5) : (A.takerImbalance < 0 && A.takerRatio <= 0.5)),
    e_oi: ctx.oiChange6h != null && (long ? (ctx.oiChange6h >= 0 && subiu) : (ctx.oiChange6h >= 0 && !subiu)),
    f_estrutura: A.ema21 != null && (long ? A.close > A.ema21 : A.close < A.ema21),
    // Anti-drift: short so com BTC 4h bear de verdade (long aceita misto).
    g_btc: long ? [ctx.btc['1h'].trend, ctx.btc['4h'].trend].every(t => t === 'bull' || t === 'mixed')
                : (ctx.btc['4h'].trend === 'bear' && (ctx.btc['1h'].trend === 'bear' || ctx.btc['1h'].trend === 'mixed')),
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
  /* Filtro anti-spike: candle anterior com amplitude > 2.5x ATR = mercado em
     pânico/spike (o caso do JUP que estopou em 27s). Não entra nessa vela. */
  const spike = A.lastRange != null && atr > 0 && A.lastRange > 2.5 * atr;
  /* R:R estrutural mínimo: só valida se houver espaço até a estrutura (topos/fundos
     de 30 candles) para pelo menos MIN_RR_ESTRUTURAL x o risco da operação. */
  const roomRR = long ? (A.high30 - entry) / risk : (entry - A.low30) / risk;
  /* Drift tax (vies long do varejo): o short paga imposto — precisa de mais
     espaço estrutural (1.5x) que o long (1.3x) pra correr a cena. */
  const rrOk = roomRR >= (long ? 1.3 : 1.5);
  /* Tres OBRIGATORIOS (mecanica V11): fluxo + tendencia + estrutura. Sem cena
     estruturada = fatiado contra-tendencia (o massacre de 6 losses num dia de queda). */
  const valida = !tie && nTrue >= 5 && fk.d_fluxo && fk.a_tendencia_alinhada && fk.f_estrutura && spreadOk && !spike && rrOk;
  let conf = 30 + nTrue * 9;
  if(asiaScalp) conf -= 10;
  const just = Object.keys(fk).filter(k => fk[k]).map(k => V11_FACTOR_LABELS[k]);
  const riscos = Object.keys(fk).filter(k => !fk[k]).map(k => 'Falhou: ' + V11_FACTOR_LABELS[k]);
  if(/ÁSIA/.test(ctx.sessao || '')) riscos.push('Sessão de baixa liquidez: ' + ctx.sessao);
  if(ctx.btcCorrelation != null && ctx.btcCorrelation > 0.8) riscos.push('Correlação alta com BTC (' + ctx.btcCorrelation + ')');
  if(spike) riscos.push('Spike detectado: último candle com amplitude > 2.5× ATR');
  if(!rrOk && !tie) riscos.push('Espaço estrutural insuficiente: R:R de cena ' + (isFinite(roomRR) ? roomRR.toFixed(2) : '?') + ' < 1.3');
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
  /* Fluxo honesto (auditoria V12): o snapshot cobre a janela do 15m —
     c1/c4 não fingem fluxo próprio (a fonte não tem agressor por TF). */
  const c15 = v11Calc(k15, true), c1 = v11Calc(k1), c4 = v11Calc(k4);
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
  /* Peso único no 15m (auditoria V12): pesava o MESMO snapshot três vezes
     (10+8+4) — teatro matemático. Granularidade real: saturação em ±1.5. */
  const cvdScore = v11Clamp((c15.takerImbalance || 0) * 8, -12, 12);
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
  /* Espelho de direção removido daqui: era cego ao lado e punia o fluxo
     ALINHADO ao SHORT (flow < -8 em um SHORT é ótimo). O espelho real
     vive no call site, com o lado na mão. */
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
    '⚖️ R:R 1:' + fmtV(res.rr) + ' · Confluência: ' + fmtV(res.confianca) + '/100\n' +
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
      if(hitSL){
        s.state = 'loss'; s.exit = p; s.closedTs = Date.now(); changed = true;
        // Cooldown pós-loss: registra a data pro scan não re-entrar na mesma direção
        (state.lossTs = state.lossTs || {})[s.sym + ':' + s.side] = Date.now();
        await notifyScore(s, 'LOSS');
      }
      else if(hitTP){ s.state = 'win'; s.exit = p; s.closedTs = Date.now(); changed = true; await notifyScore(s, 'WIN'); }
      else if(Date.now() - s.ts > s.maxHold){ s.state = 'timeout'; s.exit = p; s.closedTs = Date.now(); changed = true; await notifyScore(s, 'TIMEOUT'); }
    }
    if(changed) saveState();
  } catch(e){ log('scoreTick: ' + e.message); }
}

/* ---------------- estado ---------------- */
let state = { signals: [], alertTs: {}, verdicts: {}, cycles: 0, alertsSent: 0, lastScan: 0, startedAt: Date.now(), robo: null };
let fsMod = null, cryptoMod = null;
if(isNode){ try { fsMod = require('fs'); } catch(e){} try { cryptoMod = require('crypto'); } catch(e){} }
function saveState(){
  if(!fsMod) return;
  try{
    fsMod.writeFileSync(CFG.stateFile, JSON.stringify({ signals: state.signals, alertTs: state.alertTs, cycles: state.cycles, alertsSent: state.alertsSent, lastScan: state.lastScan, startedAt: state.startedAt, oiHist: state.oiHist || {}, lossTs: state.lossTs || {}, robo: state.robo }));
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
      state.lossTs = (d.lossTs && typeof d.lossTs === 'object') ? d.lossTs : {};
      state.robo = (d.robo && typeof d.robo === 'object') ? d.robo : null;
    }
  } catch(e){}
}

/* ================= BYBIT DEMO (ordens reais, dinheiro virtual) =================
   Domínio api-demo.bybit.com (mesmos caminhos V5 da real). Autenticação HMAC:
   assina ts + apiKey + recvWindow + corpo. SL/TP ficam REGISTRADOS na corretora
   (a Bolsa dispara mesmo se o robô dormir) — é a grande vantagem sobre o paper.
   Zero risco: a chave só existe na conta demo, nunca na real. */
const BB_DEMO = 'https://api-demo.bybit.com';
const DEMO_RECV = '6000';
/* Sincronização de clock (validado ao vivo): a demo rejeita req_timestamp
   deslocado (10002). O Render tem NTP, mas sincronizar com o /time da Bybit
   no boot deixa o bot imune a drift em qualquer host. */
let DEMO_OFF = 0;
async function demoSync(){
  try{
    const r = await bbJson(BB_DEMO + '/v5/market/time');
    if(r && r.time) DEMO_OFF = r.time - Date.now();
  } catch(e){}
}
function demoSign(ts, payload){
  return cryptoMod.createHmac('sha256', CFG.bybitSecret).update(ts + CFG.bybitKey + DEMO_RECV + payload).digest('hex');
}
async function demoApi(method, path, params){
  if(!cryptoMod || !CFG.bybitKey || !CFG.bybitSecret) throw new Error('Bybit demo não configurado (BYBIT_API_KEY/SECRET)');
  const ts = (Date.now() + DEMO_OFF).toString();
  let url = BB_DEMO + path, payload = '';
  const opt = { method, cache: 'no-store', headers: { 'X-BAPI-API-KEY': CFG.bybitKey, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': DEMO_RECV, 'Content-Type': 'application/json' } };
  if(method === 'GET'){
    payload = new URLSearchParams(params || {}).toString();
    if(payload) url += '?' + payload;
  } else {
    payload = JSON.stringify(params || {});
    opt.body = payload;
  }
  opt.headers['X-BAPI-SIGN'] = demoSign(ts, payload);
  const r = await fetch(url, opt);
  const j = await r.json();
  if(j && j.retCode !== 0) throw new Error('Bybit demo ' + j.retCode + ': ' + (j.retMsg || ''));
  return j.result;
}
/* Filtro de lote por ativo (qtyStep/minOrderQty da Binance dos futuros): cacheia
   instruments-info para arredondar a qty corretamente (qty fracionada = rejeição). */
const DEMO_LOT = {};
async function demoQtyStep(sym){
  if(DEMO_LOT[sym]) return DEMO_LOT[sym];
  try{
    const r = await bbJson(`${BYBIT}/v5/market/instruments-info?category=linear&symbol=${sym}`);
    const f = (r.result && r.result.list && r.result.list[0] && r.result.list[0].lotSizeFilter) || {};
    DEMO_LOT[sym] = { step: parseFloat(f.qtyStep) || 0.001, min: parseFloat(f.minOrderQty) || 0.001 };
  } catch(e){ DEMO_LOT[sym] = { step: 0.001, min: 0.001 }; }
  return DEMO_LOT[sym];
}
function demoQtyRound(q, lot){
  const r = Math.floor(q / lot.step) * lot.step;
  return r < lot.min ? lot.min : Number(r.toFixed(8));
}
const DEMO_TRACK = new Map();
const DEMO_PART = new Map();
async function demoTick(){
  if(!CFG.bybitDemo) return;
  try{
    const r = await demoApi('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
    const list = (r && r.list) || [];
    const open = list.filter(p => parseFloat(p.size) > 0);
    for(const p of open){
      if(!DEMO_TRACK.has(p.symbol)){
        DEMO_TRACK.set(p.symbol, p.side);
        DEMO_PART.delete(p.symbol);
        const upnl = parseFloat(p.unrealisedPnl) || 0;
        log('🟨 DEMO posição: ' + p.symbol + ' ' + p.side + ' ' + p.size + ' @ ' + p.avgPrice + ' · uPnL ' + upnl.toFixed(4));
        sendAlert('🟨 DEMO: posição aberta na corretora ✅\n' + p.symbol + ' ' + p.side + ' ' + p.size + ' @ ' + fmtV(p.avgPrice) + '\n🛑 SL e 🏁 TP registrados na BOLSA (disparam mesmo se o robô dormir)\nAlavancagem: ' + p.leverage + 'x · uPnL: ' + (upnl >= 0 ? '+' : '') + upnl.toFixed(4) + ' USDT');
      }
      /* TP1 PARCIAL live (mecânica MT5): uPnL atingiu +1R (risco = |SL-entrada|)?
         Fecha 50% com ordem reduceOnly e move o stop do exchange pro breakeven. */
      else if(!DEMO_PART.has(p.symbol)){
        const dir = p.side === 'Buy' ? 1 : -1;
        const entry = parseFloat(p.avgPrice), mark = parseFloat(p.markPrice) || entry, sl = parseFloat(p.stopLoss) || 0;
        const risk = sl ? Math.abs(entry - sl) : 0;
        const prog = (mark - entry) * dir;
        if(risk > 0 && prog >= risk){
          const half = String((parseFloat(p.size) * 0.5).toFixed(3));
          try{
            await demoApi('POST', '/v5/order/create', { category: 'linear', symbol: p.symbol, side: p.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: half, reduceOnly: true, positionIdx: 0 });
            await demoApi('POST', '/v5/position/set-trading-stop', { category: 'linear', symbol: p.symbol, stopLoss: String(aiRound(entry + dir * 0.05 * risk)), positionIdx: 0 }).catch(() => {});
            DEMO_PART.set(p.symbol, true);
            log('🟨 DEMO TP1 parcial: ' + p.symbol + ' 50% fechado em +1R, stop no breakeven');
            sendAlert('🎯 DEMO ' + p.symbol + ': TP1 PARCIAL — 50% fechado em +1R\n🛑 Stop no breakeven (a BOLSA dispara sozinha). Resto corre até TP1/TP2.');
          } catch(e){ log('❌ DEMO parcial falhou em ' + p.symbol + ': ' + e.message); }
        }
      }
    }
    for(const [sym2, side2] of [...DEMO_TRACK]){
      if(!open.some(p => p.symbol === sym2)){
        DEMO_TRACK.delete(sym2);
        DEMO_PART.delete(sym2);
        let rp = null;
        try{
          const c = await demoApi('GET', '/v5/position/closed-pnl', { category: 'linear', symbol: sym2, limit: 1 });
          const item = (c && c.list && c.list[0]) || null;
          if(item) rp = parseFloat(item.closedPnl) || 0;
        } catch(e){}
        log('🟨 DEMO posição fechada: ' + sym2 + (rp != null ? ' · PnL ' + rp.toFixed(4) : ''));
        sendAlert('🟨 DEMO: posição FECHADA na corretora\n' + sym2 + ' ' + side2 + (rp != null ? '\n📊 PnL realizado: ' + (rp >= 0 ? '+' : '') + rp.toFixed(4) + ' USDT' : '') + '\n🏆 Placar do bot');
      }
    }
  } catch(e){ log('demoTick: ' + e.message); }
}

/* ================= ROBÔ PAPER TRADING =================
   Executa os sinais validados do motor em posição SIMULADA no preço REAL da Bybit.
   Nenhuma ordem real é enviada nesta fase — a fase de dinheiro real só existe
   depois desta provar o placar tick a tick. Regras fixas no código:
   - risco 1% da equity virtual por trade (ROBO_RISK, teto 2%)
   - máx 2 posições simultâneas (ROBO_MAXPOS, teto 3)
   - kill switch: -3% no dia pausa novas entradas e avisa no Telegram
   - comandos no Telegram: PAUSAR · RETOMAR · FECHAR TUDO · STATUS */
function roboDay(){ return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function roboEnsure(){
  if(!state.robo) state.robo = { eq: CFG.roboEq, day: roboDay(), dayStartEq: CFG.roboEq, dayPnl: 0, paused: false, killed: false, positions: [], closed: [], tgOffset: 0, trades: 0, dayWins: 0, dayLosses: 0 };
  if(state.robo.dayWins == null) state.robo.dayWins = 0;
  if(state.robo.dayLosses == null) state.robo.dayLosses = 0;
  if(state.robo.day !== roboDay()){
    // Relatório noturno do dia anterior: dispara na virada da meia-noite (SP), 1x por dia
    const f = { dia: state.robo.day, pnl: state.robo.dayPnl || 0, w: state.robo.dayWins || 0, l: state.robo.dayLosses || 0, eq: state.robo.eq, startEq: state.robo.dayStartEq };
    state.robo.day = roboDay();
    state.robo.dayStartEq = state.robo.eq;
    state.robo.dayPnl = 0;
    state.robo.dayWins = 0;
    state.robo.dayLosses = 0;
    state.robo.killed = false;
    log('🗓 Robô: novo dia operacional · equity ' + fmtV(state.robo.eq));
    roboRelatorio(f);
  }
}
function roboMeta(){ return (state.robo ? state.robo.dayStartEq : CFG.roboEq) * CFG.roboMetaPct / 100; }
function roboSemana(){
  const R = state.robo; if(!R) return 0;
  const corte = Date.now() - 7 * 86400000;
  return ((R.closed || []).filter(c => c.ts >= corte).reduce((a, c) => a + (c.pnl || 0), 0));
}
function roboRelatorio(f){
  if(!CFG.tgToken || !CFG.tgChat) return;
  const meta = (f.startEq || CFG.roboEq) * CFG.roboMetaPct / 100;
  const bateu = f.pnl >= meta;
  const sem = roboSemana();
  const total = (state.robo.closed || []);
  const wins = total.filter(c => c.why === 'WIN').length, losses = total.filter(c => c.why === 'LOSS').length;
  sendAlert('🌙 RELATÓRIO ROBÔ PAPER · ' + f.dia + '\n'
    + 'Resultado: ' + (f.pnl >= 0 ? '+' : '') + fmtV(f.pnl) + ' / meta ' + fmtV(meta) + (bateu ? ' ✅ BATIDA' : ' · abaixo da meta') + '\n'
    + 'Trades do dia: ' + f.w + ' ✅ · ' + f.l + ' ❌\n'
    + '💰 Equity: ' + fmtV(f.eq) + '\n'
    + '📅 Últimos 7 dias: ' + (sem >= 0 ? '+' : '') + fmtV(sem) + ' (meta semanal +7 a +10)\n'
    + '📊 Histórico total: ' + wins + ' wins · ' + losses + ' losses\n'
    + (bateu ? 'Meta é média, não promessa — amanhã recomeça de zero. 🤝' : 'Manter a disciplina: meta é média semanal, não promessa diária.'));
}
async function roboOpen(sym, res){
  roboEnsure();
  const R = state.robo;
  if(R.paused && R.pausedUntil && Date.now() > R.pausedUntil){ R.paused = false; delete R.pausedUntil; log('🤖 Robô: pausa do StoplossGuard expirou — retomando'); }
  if(R.paused || R.killed) return;
  if(R.positions.length >= CFG.roboMaxPos){ log('🤖 Robô: limite de ' + CFG.roboMaxPos + ' posições — ' + sym + ' ignorado'); return; }
  if(R.positions.some(p => p.sym === sym)) return;
  /* StoplossGuard (mecânica Freqtrade, only_per_pair): par que estopou 2x nas
     últimas 12h fica travado — evita o suicídio de re-entradas (caso SUI 4x loss).
     PROTEÇÃO GLOBAL REMOVIDA (auditoria, a pedido do usuário): a pausa de conta
     inteira ("mercado contra o motor") bloqueava trades bons — caso TAO que deu
     win mesmo bloqueado. Fica a proteção por par + cooldown pós-loss, que são
     por ativo/direção e não engessam a conta. */
  const stopsPar = (R.closed || []).filter(t => t.sym === sym && t.why === 'LOSS' && Date.now() - t.ts < 12 * 3600000).length;
  if(stopsPar >= 2){ log('🤖 Robô: StoplossGuard — ' + sym + ' estopou ' + stopsPar + 'x em 12h, par travado'); return; }
  const entry = Number(res.entrada), sl = Number(res.stop_loss), tp = Number(res.alvos && res.alvos[0]);
  if(!isFinite(entry) || !isFinite(sl) || !isFinite(tp) || entry <= 0) return;
  const side = res.direcao === 'SHORT' ? 'SHORT' : 'LONG';
  const riskDist = Math.abs(entry - sl);
  if(riskDist <= 0 || riskDist / entry > 0.05) return; // stop absurdo (>5%)? não opera
  const riskUSD = R.eq * CFG.roboRisk;
  const qty = riskUSD / riskDist;
  // Alavancagem (padrão 5x): não muda o PnL (quem define é a qty), mas define a
  // margem usada e a liquidação. Com stop <= 5%, o stop sempre chega antes da liq.
  const notional = qty * entry;
  const margin = notional / CFG.roboLev;
  const liq = side === 'LONG' ? entry * (1 - 1 / CFG.roboLev * 0.9) : entry * (1 + 1 / CFG.roboLev * 0.9);
  const pos = { id: ++R.trades, sym, side, entry: aiRound(entry), sl: aiRound(sl), tp: aiRound(tp), risk0: aiRound(riskDist), trailLvl: 0, qty: Number(qty.toFixed(6)), riskUSD: Number(riskUSD.toFixed(2)), lev: CFG.roboLev, margin: Number(margin.toFixed(2)), liq: aiRound(liq), ts: Date.now(), maxHold: PROFILES[CFG.profile].hold };
  R.positions.push(pos);
  log('🤖 ROBÔ PAPER #' + pos.id + ' ' + sym + ' ' + side + ' · entrada ' + fmtV(entry) + ' · SL ' + fmtV(sl) + ' · TP ' + fmtV(tp) + ' · qty ' + pos.qty + ' (≈' + fmtV(notional) + ') · ' + CFG.roboLev + 'x · margem ' + fmtV(margin));
  sendAlert('🤖 ROBÔ PAPER #' + pos.id + '\n' + (side === 'LONG' ? '🟢' : '🔴') + ' ' + sym + ' ' + side + ' · FUTUROS ' + CFG.roboLev + 'x\n🎯 Entrada ' + fmtV(entry) + ' · Stop ' + fmtV(sl) + ' · TP1 ' + fmtV(tp) + '\n💰 Qty ' + pos.qty + ' (≈' + fmtV(notional) + ')\n🏦 Margem ' + fmtV(margin) + ' · Liq estimada ≈ ' + fmtV(liq) + '\n🧪 Papel · risco ' + (CFG.roboRisk * 100) + '% (' + fmtV(riskUSD) + ') · equity ' + fmtV(R.eq));
  /* CONTA DEMO: se BYBIT_DEMO=1 e as chaves estão configuradas, manda a ordem
     REAL (market) na conta demo com SL/TP e alavancagem registrados na Bolsa. */
  if(CFG.bybitDemo){
    try{
      const lot = await demoQtyStep(sym);
      const qtyD = demoQtyRound(qty, lot);
      const levS = String(CFG.roboLev);
      await demoApi('POST', '/v5/position/set-leverage', { category: 'linear', symbol: sym, buyLeverage: levS, sellLeverage: levS }).catch(e => { if(!/110043/.test(e.message)) log('⚠ alavancagem demo: ' + e.message); });
      const r = await demoApi('POST', '/v5/order/create', { category: 'linear', symbol: sym, side: side === 'LONG' ? 'Buy' : 'Sell', orderType: 'Market', qty: String(qtyD), stopLoss: String(sl), takeProfit: String(tp), positionIdx: 0 });
      pos.demoOrderId = r.orderId;
      log('🟨 DEMO: ordem enviada ' + sym + ' ' + side + ' qty ' + qtyD + ' (id ' + r.orderId + ')');
      sendAlert('🟨 CONTA DEMO: ordem enviada ✅\n' + sym + ' ' + side + ' · Market · qty ' + qtyD + '\n🛑 SL ' + fmtV(sl) + ' · 🏁 TP1 ' + fmtV(tp) + ' registrados na BOLSA\nId: ' + r.orderId + '\n(positivo: a Bolsa dispara sozinha, mesmo se o Render dormir)');
      saveState();
    } catch(e){
      log('❌ DEMO falhou em ' + sym + ': ' + e.message);
      sendAlert('❌ CONTA DEMO: ordem FALHOU em ' + sym + '\nMotivo: ' + e.message + '\nA posição segue SÓ no papel. Confira chaves/permissões (Read+Trade) e fundos demo.');
    }
  }
}
async function roboTick(){
  roboEnsure();
  if(!state.robo || !state.robo.positions || !state.robo.positions.length) return;
  const R = state.robo;
  let px = null;
  try{
    const r = await bbJson(`${BYBIT}/v5/market/tickers?category=linear`);
    px = {};
    ((r.result && r.result.list) || []).forEach(x => { px[x.symbol] = parseFloat(x.lastPrice); });
  } catch(e){ return; }
  const fechar = [];
  for(const p of R.positions){
    const price = px[p.sym]; if(!price) continue;
    let hitTP = p.side === 'LONG' ? price >= p.tp : price <= p.tp;
    let hitSL = p.side === 'LONG' ? price <= p.sl : price >= p.sl;
    /* Varredura de pavio (candles 1m): o poll de 30s pode perder um pavio rápido
       que atravessou o stop e voltou (caso SUI #1). O high/low do candle registra
       TODO preço que negociou — se tocou, dispara. Tocou SL e TP no mesmo candle
       = LOSS (conservador, mesma regra do painel). A saída usa o preço do nível,
       como uma ordem real de stop/TP dispararia na corretora. */
    let exit = price;
    if(hitSL){ exit = p.sl; }
    else if(hitTP){ exit = p.tp; }
    else {
      try{
        const kl = await byKlines(p.sym, '1m', 30);
        const desde = kl.filter(c => Number(c[0]) >= p.ts - 60000);
        for(const c of desde){
          const hit = CORE.evalBar(p, +c[2], +c[3]); if(hit){ if(hit.why === 'LOSS') hitSL = true; else hitTP = true; exit = hit.price; break; }
          // trilho SL/TP via CORE (mesmo motor do backtest)
          //
          //
          //
        }
      } catch(e){}
    }
    const expired = Date.now() - p.ts > p.maxHold;
    /* TP1 PARCIAL (mecânica clássica dos EAs de MetaTrader 5): quando o trade
       atinge +1R, fecha 50% da posição (trava meio lucro) e sobe o stop pro
       breakeven+buffer. Reduz variância e mata o "volo a volo" que devolve
       lucro. O resto corre até TP1/TP2 com o trailing. */
    if(!hitSL && !hitTP && !expired && !p.partClosed){
      const dirT = p.side === 'LONG' ? 1 : -1;
      const prog = (price - p.entry) * dirT;
      if(p.risk0 > 0 && p.qty > 0 && prog >= p.risk0){
        const met = Math.max(1e-6, Number((p.qty * 0.5).toFixed(6)));
        const pnlH = Number((met * p.risk0).toFixed(4));
        R.eq = Number((R.eq + pnlH).toFixed(4));
        R.dayPnl = Number(((R.dayPnl || 0) + pnlH).toFixed(4));
        p.partClosed = true;
        p.qty = Number((p.qty - met).toFixed(6));
        p.sl = aiRound(p.entry + dirT * 0.05 * p.risk0);
        saveState();
        sendAlert('🎯 ROBÔ PAPER #' + p.id + ' ' + p.sym + ': TP1 PARCIAL — 50% fechado em +1R (+' + fmtV(pnlH) + ')\n🛑 Stop sobe pro breakeven (' + fmtV(p.sl) + '). Resto corre até TP1/TP2.');
      }
    }
    /* Trailing de alvo: quando o preço se aproxima do TP1, o stop SOBE para
       travar lucro em vez de deixar o alvo devolver. Nível 1 (80% do caminho):
       stop para metade do caminho (trava ~1R com alvo 2R). Nível 2 (90%):
       stop para 80% do caminho (trava quase todo o lucro). Frações do caminho,
       então funciona com qualquer TP. Máx 2 alertas por posição (sem spam). */
    if(!hitSL && !hitTP && !expired){
      const dirT = p.side === 'LONG' ? 1 : -1;
      const caminho = Math.abs(p.tp - p.entry);
      const prog = (price - p.entry) * dirT;
      if(caminho > 0 && (p.trailLvl || 0) < 1 && prog >= 0.8 * caminho){
        p.sl = aiRound(p.entry + dirT * 0.5 * caminho);
        p.trailLvl = 1; saveState();
        sendAlert('🔒 ROBÔ PAPER #' + p.id + ' ' + p.sym + ': 80% do caminho — stop travando metade do lucro (SL ' + fmtV(p.sl) + ')');
      }
      if(caminho > 0 && (p.trailLvl || 0) < 2 && prog >= 0.9 * caminho){
        p.sl = aiRound(p.entry + dirT * 0.8 * caminho);
        p.trailLvl = 2; saveState();
        sendAlert('🔒 ROBÔ PAPER #' + p.id + ' ' + p.sym + ': 90% do caminho — stop travando 80% do lucro (SL ' + fmtV(p.sl) + ')');
      }
    }
    if(hitTP || hitSL || expired) fechar.push({ p, price: exit, why: hitTP ? 'WIN' : hitSL ? 'LOSS' : 'TIMEOUT' });
  }
  for(const f of fechar) roboClose(f.p, f.price, f.why);
  if(fechar.length){
    if(R.eq <= (R.dayStartEq || R.eq) * (1 - CFG.roboDailyStop) && !R.killed){
      R.killed = true;
      sendAlert('🛑 ROBÔ PAPER: kill switch diário (' + (CFG.roboDailyStop * 100) + '%) atingido · equity ' + fmtV(R.eq) + '\nNenhuma nova posição hoje. Zera automaticamente amanhã.');
    }
    saveState();
  }
}
function roboClose(p, price, why){
  const R = state.robo;
  const dir = p.side === 'LONG' ? 1 : -1;
  const pnl = (price - p.entry) * p.qty * dir;
  const pnlR = pnl / (p.riskUSD || 1);
  R.eq = Number((R.eq + pnl).toFixed(4));
  R.dayPnl = Number(((R.dayPnl || 0) + pnl).toFixed(4));
  if(why === 'WIN') R.dayWins = (R.dayWins || 0) + 1;
  if(why === 'LOSS') R.dayLosses = (R.dayLosses || 0) + 1;
  R.positions = R.positions.filter(x => x.id !== p.id);
  R.closed.push({ id: p.id, sym: p.sym, side: p.side, entry: p.entry, exit: aiRound(price), why, pnl: Number(pnl.toFixed(4)), pnlR: Number(pnlR.toFixed(2)), ts: Date.now() });
  if(R.closed.length > 200) R.closed = R.closed.slice(-200);
  const emoji = why === 'WIN' ? '✅' : why === 'LOSS' ? '❌' : '⏱';
  log('🤖 ROBÔ ' + emoji + ' #' + p.id + ' ' + p.sym + ' ' + why + ' · PnL ' + (pnl >= 0 ? '+' : '') + fmtV(pnl) + ' (' + (pnlR >= 0 ? '+' : '') + pnlR.toFixed(2) + 'R) · equity ' + fmtV(R.eq));
  sendAlert(emoji + ' ROBÔ PAPER #' + p.id + ' · ' + p.sym + ' ' + p.side + ' · ' + why + '\nSaiu em ' + fmtV(price) + '\nPnL ' + (pnl >= 0 ? '+' : '') + fmtV(pnl) + ' (' + (pnlR >= 0 ? '+' : '') + pnlR.toFixed(2) + 'R)\n💰 Equity: ' + fmtV(R.eq) + '\nDia: ' + ((R.dayPnl || 0) >= 0 ? '+' : '') + fmtV(R.dayPnl || 0));
}
async function roboCmd(){
  if(!CFG.tgToken || !CFG.tgChat) return;
  roboEnsure();
  const off = state.robo.tgOffset || 0;
  let data = null;
  try{ data = await fetchJson('https://api.telegram.org/bot' + CFG.tgToken + '/getUpdates?timeout=0&offset=' + off, 8000); } catch(e){ return; }
  const ups = (data && data.result) || [];
  for(const u of ups){
    state.robo.tgOffset = Math.max(state.robo.tgOffset || 0, (u.update_id || 0) + 1);
    const msg = u.message;
    if(!msg || String(msg.chat.id) !== String(CFG.tgChat)) continue;
    const t = String(msg.text || '').toUpperCase().trim();
    if(t.includes('PAUSAR')){
      state.robo.paused = true; saveState();
      sendAlert('⏸ ROBÔ PAPER pausado. Posições abertas seguem monitoradas até TP/SL. Envie RETOMAR para voltar.');
    } else if(t.includes('RETOMAR')){
      state.robo.paused = false; state.robo.killed = false; saveState();
      sendAlert('▶️ ROBÔ PAPER retomado. Novos sinais serão executados em papel.');
    } else if(t.includes('FECHAR')){
      let px = null;
      try{ const r = await bbJson(`${BYBIT}/v5/market/tickers?category=linear`); px = {}; ((r.result && r.result.list) || []).forEach(x => { px[x.symbol] = parseFloat(x.lastPrice); }); } catch(e){}
      for(const p of state.robo.positions.slice()) roboClose(p, px ? (px[p.sym] || p.entry) : p.entry, 'MANUAL');
      saveState();
    } else if(t.includes('STATUS')){
      const R2 = state.robo, dia = R2.dayPnl || 0;
      const meta = roboMeta();
      const metaTxt = dia >= meta ? '✅ META BATIDA' : 'faltam ' + fmtV(Math.max(0, meta - dia)) + ' p/ meta';
      sendAlert('🤖 ROBÔ PAPER · STATUS\nEquity: ' + fmtV(R2.eq) + '\nDia: ' + (dia >= 0 ? '+' : '') + fmtV(dia) + ' / meta +' + fmtV(meta) + ' · ' + metaTxt + '\nSemana (7d): ' + (roboSemana() >= 0 ? '+' : '') + fmtV(roboSemana()) + '\nPosições abertas: ' + R2.positions.length + '/' + CFG.roboMaxPos + (R2.paused ? '\n⏸ pausado' : '') + (R2.killed ? '\n🛑 kill switch ativo' : ''));
    }
  }
  if(ups.length) saveState();
}
function roboSummary(){
  const R = state.robo;
  if(!R) return { ativo: false };
  const closed = R.closed || [];
  return { ativo: CFG.robo, modo: CFG.bybitDemo ? 'DEMO (ordens reais em conta demo)' : 'PAPER', demo: !!CFG.bybitDemo, demoAbertas: [...DEMO_TRACK.keys()], eq: R.eq, dia: R.dayPnl || 0, paused: !!R.paused, killed: !!R.killed, abertas: (R.positions || []).length, maxPos: CFG.roboMaxPos, wins: closed.filter(c => c.why === 'WIN').length, losses: closed.filter(c => c.why === 'LOSS').length, historico: closed.slice(-10).reverse() };
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
  /* Cooldown pós-loss (6h): estopou nessa direção? Só reentra com confiança >= 80.
     Mata a re-entrada suicida (ex.: SUI LONG estopado 4x no mesmo dia). */
  const lastLoss = (state.lossTs || {})[key] || 0;
  if(Date.now() - lastLoss < 6 * 3600000 && res.confianca < 80){
    log('🧊 ' + sym + ' ' + res.direcao + ': em cooldown pós-loss (6h) — confiança ' + res.confianca + ' < 80. Aguardando sinal forte.');
    return;
  }
  let v11 = null;
  if(CFG.gateOn){
    try { v11 = await v11Gate(sym); } catch(e){ log('V11 falhou em ' + sym + ': ' + e.message); }
    if(v11){
      /* Espelho direcional (auditoria V12): o Selo confirma a DIREÇÃO?
         LONG exige fluxo alinhado (+8) e SHORT (-8) — mesma régua. */
      const fluxoOk = res.direcao === 'LONG' ? v11.flow >= 8 : v11.flow <= -8;
      if(v11.score < 60 || v11.gate === 'BLOQUEADO' || !fluxoOk){
        log('🔒 ' + sym + ': checklist válida mas o V11 bloqueou (score ' + v11.score + ' · ' + v11.gate + ' · flow ' + v11.flow + ' vs ' + res.direcao + ') — descartado');
        state.verdicts[sym].blocked = true;
        return;
      }
    }
  }
  const plano = buildPlano(sym, res, perfil, v11);
  await sendAlert(plano);
  state.alertTs[key] = Date.now();
  state.alertsSent++;
  trackSignal(sym, res, perfil.hold);
  if(CFG.robo) await roboOpen(sym, res);
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

/* ================= V12 · BACKTEST EVENT-DRIVEN + WALK-FORWARD =================
   (blueprint do auditor V12, implementado em cima do bot.js corrigido)
   Entrada na abertura da vela seguinte · sem look-ahead · SL/TP por High/Low ·
   SL e TP na mesma vela = SL primeiro (conservador) · taxas e slippage incluídos.
   Walk-Forward: minScore calibrado SÓ no treino (70%), aplicado no OOS/teste.
   Fluxo histórico = PROXY candle/volume (a API não fornece agressor histórico);
   o V11 ao vivo continua com os trades reais recentes da Bybit. */
let LAST_BT_META = null;
async function byKlinesDeep(sym, tf, want){
  const ms = TF_MS[tf] || TF_MS['15m'];
  let raw = [];
  for(let end = Date.now(); raw.length < want && raw.length < 6000; end -= 1000 * ms){
    const r = await bbJson(`${BYBIT}/v5/market/kline?category=linear&symbol=${sym}&interval=${BYBIT_IV[tf] || '15'}&limit=1000&end=${end}`);
    const list = (r.result && r.result.list) || [];
    if(!list.length) break;
    raw = raw.concat(list);
    if(list.length < 1000) break;
    await sleep(REQ_GAP_MS); // mesmo gap anti-ban do ciclo (coleta fora da fila)
  }
  const uniq = new Map();
  for(const x of raw) uniq.set(+x[0], x);
  const k = [...uniq.keys()].sort((a, b) => a - b).map(t => { const x = uniq.get(t); return [+t, x[1], x[2], x[3], x[4], x[5], +t + ms - 1, '0', '0', 0]; });
  let gaps = 0;
  for(let i = 1; i < k.length; i++) if(k[i][0] - k[i - 1][0] !== ms) gaps++;
  LAST_BT_META = { solicitadas: want, recebidas: raw.length, recebidasDuplicadas: raw.length - uniq.size, unicas: k.length, gaps, aviso: k.length < want ? 'ativo novo ou histórico curto' : null };
  return k;
}
/* ================= V12.3 · CORE ÚNICO (Backtest = Papel) =================
   O mesmo trilho roda no papel (poll 30s + varredura de pavio) e no backtest (vela a vela):
   - SL avaliado antes do TP na mesma vela (conservador);
   - trailing nos mesmos níveis: 80% do caminho → trava 50%, 90% → trava 80%;
   - custos realistas: taxa nos dois lados + slippage nos dois lados (pior no stop)
     + funding aproximado proporcional ao tempo em posição. */
const CORE = {
  trail(pos, pos_price){ // pos_price: preço de referência (close da barra no backtest)
    const price = pos_price, dirT = pos.side === 'LONG' ? 1 : -1;
    const caminho = Math.abs(pos.tp - pos.entry);
    if(!(caminho > 0)) return pos.sl;
    const prog = (price - pos.entry) * dirT;
    if((pos.trailLvl || 0) < 1 && prog >= 0.8 * caminho){ pos.sl = pos.entry + dirT * 0.5 * caminho; pos.trailLvl = 1; }
    if((pos.trailLvl || 0) < 2 && prog >= 0.9 * caminho){ pos.sl = pos.entry + dirT * 0.8 * caminho; pos.trailLvl = 2; }
    return pos.sl;
  },
  evalBar(pos, h, l){
    const long = pos.side === 'LONG';
    if(long ? l <= pos.sl : h >= pos.sl) return { why: 'LOSS', price: pos.sl };
    if(long ? h >= pos.tp : l <= pos.tp) return { why: 'WIN', price: pos.tp };
    return null;
  }
};
function coreNet(grossR, bars, entry, exit, risk, why, fundBars){
  const slipExit = CFG.btSlipBps * (why === 'LOSS' ? 1 : 0.5);
  const fee = (entry + exit) * CFG.btFeeBps / 10000;
  const slip = entry * CFG.btSlipBps / 10000 + exit * slipExit / 10000;
  const fund = (bars / (fundBars || 32)) * (CFG.btFundBps / 10000) * entry;
  return grossR - (fee + slip + fund) / risk;
}
function v12RegimeOf(b, h){
  if(!b) return 'N/A';
  if((b.atrPct || 0) > 2.5) return 'HIGH VOL';
  const same = h && h.trend === b.trend && b.trend !== 'mixed';
  const adx = Math.max(b.adx || 0, (h && h.adx) || 0);
  if(same && adx >= 25) return b.trend === 'bull' ? 'TREND BULL' : 'TREND BEAR';
  if(adx < 18) return 'RANGE';
  return 'MIXED';
}
function v12Calibration(tr){
  const buckets = [];
  for(let lo = 50; lo < 100; lo += 5){
    const g = tr.filter(t => t.score >= lo && t.score < lo + 5);
    buckets.push({ score: lo + '-' + (lo + 4), trades: g.length, pWin: g.length ? +(100 * g.filter(t => t.r > 0).length / g.length).toFixed(1) : null, expR: g.length ? +(g.reduce((s, t) => s + t.r, 0) / g.length).toFixed(2) : null });
  }
  return buckets;
}
function v12Breakdown(tr){
  const bd = (list) => ({ trades: list.length, winRate: list.length ? Math.round(100 * list.filter(t => t.r > 0).length / list.length) + '%' : '--', pnlR: +list.reduce((s, t) => s + t.r, 0).toFixed(2), expectancy: list.length ? +(list.reduce((s, t) => s + t.r, 0) / list.length).toFixed(2) : null });
  const regimes = {}, porRegime = {};
  for(const t of tr){ (regimes[t.reg] = regimes[t.reg] || []).push(t); }
  Object.keys(regimes).forEach(k => porRegime[k] = bd(regimes[k]));
  return { porLado: { LONG: bd(tr.filter(t => t.side === 'LONG')), SHORT: bd(tr.filter(t => t.side === 'SHORT')) }, porRegime };
}
async function runSelfTest(){
  const resultados = [];
  const t = (nome, ok, info) => resultados.push({ teste: nome, ok, info: String(info) });
  try{
    const k = await byKlinesDeep('BTCUSDT', '15m', 400);
    t('ordem cronológica (antigo→novo)', k.length > 2 && k[0][0] < k[k.length - 1][0], 'primeiro ' + new Date(k[0][0]).toISOString());
    t('sem duplicatas', new Set(k.map(x => x[0])).size === k.length, new Set(k.map(x => x[0])).size + '/' + k.length);
    let gaps = 0;
    for(let i = 1; i < k.length; i++) if(k[i][0] - k[i - 1][0] !== TF_MS['15m']) gaps++;
    t('continuidade (sem buracos)', gaps === 0, gaps + ' buracos');
    t('recebeu >= pediu', k.length >= 400, k.length + ' de 400');
    t('meta de dados registrada', !!LAST_BT_META && LAST_BT_META.unicas === k.length, JSON.stringify(LAST_BT_META));
    const kb2 = await byKlines('BTCUSDT', '15m', 50);
    t('byKlines antigo→novo', kb2.length === 50 && kb2[0][0] < kb2[kb2.length - 1][0], 'último ' + new Date(kb2[kb2.length - 1][0]).toISOString());
    const closed = k.filter(x => +x[6] <= Date.now());
    t('motor usa somente candles fechados', closed.length === k.length, (k.length - closed.length) + ' abertos filtrados');
  } catch(e){ t('execução', false, e.message); }
  return { selfTest: 'paginador de candles', ok: resultados.every(x => x.ok), resultados };
}
function v12Resample(k, bucketMs){
  const map = new Map();
  for(const x of k){ const b = Math.floor(+x[0] / bucketMs); if(!map.has(b)) map.set(b, []); map.get(b).push(x); }
  const out = [];
  for(const b of [...map.keys()].sort((a, c) => a - c)){
    const g = map.get(b);
    out.push([g[0][0], g[0][1], String(Math.max(...g.map(x => +x[2]))), String(Math.min(...g.map(x => +x[3]))), g[g.length - 1][4], String(g.reduce((s, x) => s + +x[5], 0)), g[g.length - 1][6]]);
  }
  return out;
}
function v12CalcW(w){ // indicadores de janela fixa + proxy de fluxo (candle/volume)
  const c = w.map(x => +x[4]), v = w.map(x => +x[5]);
  const e9 = aiEma(c, 9), e21 = aiEma(c, 21), e50 = aiEma(c, 50), e200 = c.length >= 200 ? aiEma(c, 200) : null, r = aiRsi(c), a = aiAtr(w), adx = aiAdx(w);
  const close = c[c.length - 1];
  let sv = 0, tv = 0;
  for(const x of w.slice(-20)){ const hi = +x[2], lo = +x[3], o = +x[1], cl = +x[4], vol = +x[5]; const rng = (hi - lo) || cl * 1e-9; sv += vol * (2 * (cl - o) / rng - 1); tv += vol; }
  return { close, e9, e21, e50, e200, rsi: r, atr: a, atrPct: a / close * 100, adx, volRatio: v[v.length - 1] / ((v.slice(-21, -1).reduce((s, y) => s + y, 0) / Math.max(1, v.slice(-21, -1).length)) || 1), flowImb: tv ? sv / tv : 0, trend: e200 != null && e9 > e21 && e21 > e50 && e50 > e200 ? 'bull' : e200 != null && e9 < e21 && e21 < e50 && e50 < e200 ? 'bear' : 'mixed' };
}
function v12ScoreW(b, m, h, btcT, side){ // confluência ponderada 0-100 (8 fatores do blueprint)
  const long = side === 'LONG', tv = long ? 'bull' : 'bear';
  let s = 0;
  s += b.trend === tv ? 12 : (b.trend === 'mixed' ? 4 : 0);
  if(m.trend === tv) s += 5; if(h.trend === tv) s += 3;
  s += b.rsi != null && (long ? b.rsi >= 48 && b.rsi <= 70 : b.rsi >= 30 && b.rsi <= 52) ? 8 : (b.rsi != null && (b.rsi > 78 || b.rsi < 22) ? 0 : 4);
  s += (b.adx != null && b.adx >= 25) ? 12 : ((b.adx != null && b.adx >= 20) ? 7 : 2);
  s += long ? (b.flowImb > 0.15 ? 15 : b.flowImb > 0 ? 8 : 0) : (b.flowImb < -0.15 ? 15 : b.flowImb < 0 ? 8 : 0);
  s += b.e21 != null && (long ? b.close > b.e21 : b.close < b.e21) ? 13 : 0;
  s += btcT === tv ? 10 : (btcT === 'mixed' ? 4 : 0);
  s += b.volRatio >= 1.5 ? 10 : b.volRatio >= 1 ? 6 : 2;
  s += b.atrPct > 0.25 && b.atrPct < 1.8 ? 8 : (b.atrPct < 2.5 ? 4 : 0);
  return Math.max(0, Math.min(100, Math.round(s)));
}
function v12Stats(tr){
  const n = tr.length, wins = tr.filter(t => t.r > 0), losses = tr.filter(t => t.r <= 0);
  const gw = wins.reduce((s, t) => s + t.r, 0), gl = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
  for(const r of tr.map(t => t.r)){ cum += r; if(cum > peak) peak = cum; dd = Math.min(dd, cum - peak); if(r <= 0){ streak++; if(streak > maxStreak) maxStreak = streak; } else streak = 0; }
  const mean = n ? tr.reduce((s, t) => s + t.r, 0) / n : 0;
  const hasExc = n > 0 && tr[0].mae != null; const mMae = hasExc ? tr.reduce((s, t) => s + (t.mae || 0), 0) / n : null, mMfe = hasExc ? tr.reduce((s, t) => s + (t.mfe || 0), 0) / n : null;
  const std = n > 1 ? Math.sqrt(tr.reduce((s, t) => s + (t.r - mean) * (t.r - mean), 0) / (n - 1)) : 0;
  const fx = (a, b) => { const g = tr.filter(t => t.score >= a && t.score < b); return { trades: g.length, winRate: g.length ? Math.round(g.filter(t => t.r > 0).length / g.length * 100) + '%' : '--' }; };
  return { trades: n, winRate: n ? Math.round(wins.length / n * 100) + '%' : '--', profitFactor: gl > 0 ? Math.round(gw / gl * 100) / 100 : (gw > 0 ? '∞' : 0), pnlR: Math.round(cum * 100) / 100, maxDrawdownR: Math.round(dd * 100) / 100, expectancy: Math.round(mean * 100) / 100, mediaR: Math.round(mean * 100) / 100, sharpe: std > 0 ? Math.round(mean / std * 100) / 100 : '∞', maxLossStreak: maxStreak, avgMAE: mMae == null ? null : +mMae.toFixed(2), avgMFE: mMfe == null ? null : +mMfe.toFixed(2), longShort: tr.filter(t => t.side === 'LONG').length + '/' + tr.filter(t => t.side === 'SHORT').length, faixas: { '55-64': fx(55, 65), '65-74': fx(65, 75), '75-84': fx(75, 85), '85+': fx(85, 101) } };
}
async function v12Backtest(opt){
  const prof = PROFILES[opt.profile] || PROFILES[CFG.profile];
  const baseTf = prof.tfs[0], ms = TF_MS[baseTf] || TF_MS['15m'];
  const days = opt.days || CFG.btDays;
  const want = Math.min(6000, Math.ceil(days * 86400000 / ms) + 2);
  const kb = (await byKlinesDeep(opt.symbol, baseTf, want)).filter(x => +x[6] < Date.now());
  const metaK = LAST_BT_META;
  if(kb.length < 500) return { erro: 'Histórico insuficiente (' + kb.length + ' velas de ' + baseTf + ') — reduza os dias ou o ativo é novo', ativo: opt.symbol, flowModel: 'PROXY candle/volume' };
  const kM = v12Resample(kb, TF_MS[prof.tfs[1]] || ms * 4), kH = v12Resample(kb, TF_MS[prof.tfs[2]] || ms * 16);
  const btcB = v12Resample((await byKlinesDeep('BTCUSDT', baseTf, want)).filter(x => +x[6] < Date.now()), TF_MS[prof.tfs[1]] || ms * 4);
  const n = kb.length, warm = 210, nT = Math.floor(n * CFG.btTrainPct);
  // passada 1: calcs cacheados por barra (janelas 100% fechadas, sem look-ahead)
  const ptrs = [0, 0], btPtr = 0;
  const C = [];
  for(let i = 210; i < n; i++){
    const T = +kb[i][6];
    const b = v12CalcW(kb.slice(Math.max(0, i - 219), i + 1));
    const series = [kM, kH], R = [];
    for(let s = 0; s < 2; s++){
      while(ptrs[s] < series[s].length && +series[s][ptrs[s]][6] <= T) ptrs[s]++;
      const w = series[s].slice(Math.max(0, ptrs[s] - 220), ptrs[s]);
      R.push(w.length >= 210 ? v12CalcW(w) : null);
    }
    while(btPtr < btcB.length && +btcB[btPtr][6] <= T) btPtr++;
    const bw = btcB.slice(Math.max(0, btPtr - 220), btPtr);
    C.push({ b, m: R[0], h: R[1], bt: bw.length >= 210 ? v12CalcW(bw) : null });
  }
  // passada 2: simulação event-driven por candidato de minScore
  const sim = (minScore, iFrom, iTo) => {
    const trades = []; let busy = -1;
    for(let i = Math.max(warm, iFrom); i < iTo - 1; i++){
      if(i <= busy) continue;
      const c = C[i - warm];
      if(!c || !c.b || c.m == null || c.h == null || !c.bt) continue;
      const sL = v12ScoreW(c.b, c.m, c.h, c.bt.trend, 'LONG'), sS = v12ScoreW(c.b, c.m, c.h, c.bt.trend, 'SHORT');
      const side = sL > sS ? 'LONG' : 'SHORT', sc = Math.max(sL, sS);
      if(sc < minScore) continue;
      const long = side === 'LONG', risk = 1.25 * c.b.atr;
      if(!(risk > 0)) continue;
      const o = +kb[i + 1][1];
      const entry = o * (1 + (long ? 1 : -1) * CFG.btSlipBps / 10000);
      const pos = { side, entry, sl: long ? entry - risk : entry + risk, trailLvl: 0 };
      pos.tp = long ? entry + CFG.btRR * risk : entry - CFG.btRR * risk; const reg = v12RegimeOf(c.b, c.h); let mae = 0, mfe = 0;
      let exit = null, why = 'TIME', iOut = -1;
      for(let q = i + 1; q < Math.min(iTo, i + 1 + CFG.btMaxHoldBars); q++){
        const h = +kb[q][2], l = +kb[q][3], c2 = +kb[q][4];
        const adv = (long ? (l - entry) : (entry - h)) / risk, fav = (long ? (h - entry) : (entry - l)) / risk; if(adv < mae) mae = adv; if(fav > mfe) mfe = fav;
        const hit = CORE.evalBar(pos, h, l); if(hit){ exit = hit.price; why = hit.why; iOut = q; break; }
        CORE.trail(pos, c2); exit = c2; iOut = q;
      }
      if(exit == null || iOut >= iTo) continue;
      const net = coreNet((long ? exit - entry : entry - exit) / risk, iOut - i, entry, exit, risk, why, (8 * 3600000) / ms);
      trades.push({ side, score: sc, r: net, why, reg, mae: +mae.toFixed(2), mfe: +mfe.toFixed(2) });
      busy = iOut;
    }
    return trades;
  };
  let best = null; const folds = CFG.btFolds, warm2 = 210; const oosLen = Math.floor((n - warm2) / (folds + 1)); const foldResults = [], allAll = [];
  for(const msx of [55, 60, 65, 70, 75, 80]){
    const tr = sim(msx, 210, warm2 + oosLen);
    if(tr.length < Math.max(5, Math.floor(CFG.btMinTrades / 2))) continue;
    const st = v12Stats(tr);
    if(!best || st.expectancy > best.st.expectancy) best = { ms: msx, st };
  }
  if(!best){
    const all = sim(55, 210, nT);
    return { erro: 'Treino sem amostra suficiente para calibrar o minScore com honestidade', ativo: opt.symbol, perfil: prof.nome, velas: n, tradesNoTreino: all.length, flowModel: 'PROXY candle/volume' };
  }
  for(let f = 0; f < folds; f++){
    const oosFrom = warm2 + oosLen * (f + 1), oosTo = f === folds - 1 ? n : oosFrom + oosLen;
    if(oosTo - oosFrom < 20) continue;
    let bestF = null;
    for(const msx of [55, 60, 65, 70, 75, 80]){
      const trF = sim(msx, 210, oosFrom);
      if(trF.length < Math.max(5, Math.floor(CFG.btMinTrades / 2))) continue;
      const stF = v12Stats(trF);
      if(!bestF || stF.expectancy > bestF.st.expectancy) bestF = { ms: msx, st: stF };
    }
    const msUse = bestF ? bestF.ms : (best ? best.ms : 55);
    const trO = sim(msUse, oosFrom, oosTo);
    trO.forEach(t => { t.fold = f + 1; });
    allAll.push(...trO);
    foldResults.push({ fold: f + 1, velasOOS: oosTo - oosFrom, minScoreTreino: msUse, amostraTreino: bestF ? bestF.st.trades : 0, trades: trO.length, winRate: trO.length ? Math.round(100 * trO.filter(t => t.r > 0).length / trO.length) + '%' : '--', pnlR: +trO.reduce((s, t) => s + t.r, 0).toFixed(2) });
  }
  const tot = v12Stats(allAll);
  return { ativo: opt.symbol, perfil: prof.nome, velas: n, dias: days, flowModel: 'PROXY candle/volume', aviso: 'Fluxo histórico é proxy candle/volume; o vivo usa trades reais Bybit', dados: { ...(metaK || {}), fechadas: kb.length }, walkForwardRolling: { folds: CFG.btFolds, resultados: foldResults, total: tot, breakdown: v12Breakdown(allAll), calibracao: v12Calibration(allAll) }, config: { feeBps: CFG.btFeeBps, slippageBps: CFG.btSlipBps, fundingBpsPor8h: CFG.btFundBps, rr: CFG.btRR, maxHoldBars: CFG.btMaxHoldBars } };
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
  http.createServer(async (req, res) => {
    if(req.url.startsWith('/selftest')){
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      try { res.end(JSON.stringify(await runSelfTest(), null, 2)); } catch(e){ res.end(JSON.stringify({ erro: 'selftest: ' + e.message }, null, 2)); }
      return;
    }
    if(req.url.startsWith('/backtest')){
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      try{
        const u = new URL(req.url, 'http://x');
        const sym = (u.searchParams.get('symbol') || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9_]/g, '');
        const d = Math.min(365, Math.max(7, Number(u.searchParams.get('days')) || CFG.btDays));
        const p = u.searchParams.get('profile') || CFG.profile;
        log('🔬 V12 backtest: ' + sym + ' · ' + d + ' dias · ' + p + ' (coleta profunda pode levar alguns segundos)');
        if(u.searchParams.get('multi')){
          const syms = u.searchParams.get('multi').split(',').map(s => s.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '')).filter(Boolean).slice(0, 6);
          log('📊 comparativo por ativo: ' + syms.join(', '));
          const comp = [];
          for(const s2 of syms){
            try{ const r2 = await v12Backtest({ symbol: s2, days: d, profile: p }); comp.push(r2.erro ? { ativo: s2, erro: r2.erro } : { ativo: s2, dados: r2.dados, total: r2.walkForwardRolling.total, breakdown: r2.walkForwardRolling.breakdown }); } catch(e){ comp.push({ ativo: s2, erro: e.message }); }
            await sleep(1200);
          }
          res.end(JSON.stringify({ comparativoPorAtivo: comp }, null, 2));
          return;
        }
        if(u.searchParams.get('allProfiles')){
          const comps = [];
          for(const p2 of ['padrao', 'scalp', 'swing']){
            try{ const r2 = await v12Backtest({ symbol: sym, days: d, profile: p2 }); comps.push(r2.erro ? { perfil: p2, erro: r2.erro } : { perfil: p2, dados: r2.dados, total: r2.walkForwardRolling.total }); } catch(e){ comps.push({ perfil: p2, erro: e.message }); }
            await sleep(1000);
          }
          res.end(JSON.stringify({ comparativoPorTimeframe: comps }, null, 2));
          return;
        }
        res.end(JSON.stringify(await v12Backtest({ symbol: sym, days: d, profile: p }), null, 2));
      }catch(e){ res.end(JSON.stringify({ erro: 'backtest: ' + e.message }, null, 2)); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      bot: 'VINGADOR BOT 24H',
      perfil: PROFILES[CFG.profile].nome, tfs: PROFILES[CFG.profile].tfs,
      ativos: CFG.watchlist, cicloMin: CFG.intervalMin, gateV11: CFG.gateOn,
      iniciado: new Date(state.startedAt).toISOString(),
      ultimaVarredura: state.lastScan ? new Date(state.lastScan).toISOString() : null,
      ciclos: state.cycles, alertasEnviados: state.alertsSent,
      placar: scoreSummary(), sinais: state.signals.slice(-20).reverse(),
      vereditos: state.verdicts, robo: roboSummary(),
      backtest: { disponivel: true, exemplo: '/backtest?symbol=BTCUSDT&days=90', multi: '/backtest?multi=BTCUSDT,SOLUSDT,SUIUSDT&days=90', porTimeframe: '/backtest?symbol=BTCUSDT&days=90&allProfiles=1', folds: CFG.btFolds, auto: CFG.btAuto }, selfTest: { arg: 'node bot.js --selftest', url: '/selftest' }
    }, null, 2));
  }).listen(CFG.port, () => log('🌐 Status HTTP na porta ' + CFG.port));
}

/* ---------------- boot ---------------- */
if(isNode){
  loadState();
  if(process.argv.includes('--selftest')){
    runSelfTest().then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }).catch(e => { console.error('selfTest falhou: ' + e.message); process.exit(1); });
  }
  log('🤖 VINGADOR BOT 24H iniciado · perfil ' + PROFILES[CFG.profile].nome + ' (' + PROFILES[CFG.profile].tfs.join('/') + ') · ' + CFG.watchlist.length + ' ativos · ciclo ' + CFG.intervalMin + 'min' + (CFG.gateOn ? ' · selo V11 ON' : ' · selo V11 OFF'));
  // Diagnóstico de credenciais (mascarado — nunca imprime o token completo):
  if(CFG.tgToken){
    const okFormat = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/.test(CFG.tgToken);
    log('🔑 Telegram: token recebido (' + CFG.tgToken.length + ' chars, começa com "' + CFG.tgToken.slice(0, 8) + '...") · formato ' + (okFormat ? 'válido' : 'INVÁLIDO — deve ser 123456789:AA...') + ' · chat ' + (CFG.tgChat || 'VAZIO!'));
  } else {
    log('❌ Telegram: TELEGRAM_TOKEN vazio — confira a variável no Render → Environment');
  }
  if(CFG.bybitDemo && !process.argv.includes('--selftest')){
    if(!cryptoMod) log('❌ Bybit demo: módulo crypto indisponível');
    else if(CFG.bybitKey && CFG.bybitSecret){
      log('🟨 Bybit DEMO: validando chaves em api-demo.bybit.com...');
      (async () => {
        await demoSync();
        log('🟨 Bybit DEMO: clock sincronizado com a Bybit (offset ' + DEMO_OFF + 'ms)');
        try{
          const r = await demoApi('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' });
          const n = ((r && r.list) || []).length;
          log('🟨 Bybit DEMO conectada ✅ · chaves válidas · ' + n + ' posição(ões) aberta(s) no demo');
          if(CFG.tgToken && CFG.tgChat) sendTelegram('🟨 CONTA DEMO conectada ✅\nChaves válidas (Read validado na Bybit)\nPosições demo abertas: ' + n + '\nModo: ordens REAIS em conta demo (dinheiro virtual)\nDomínio: api-demo.bybit.com\nSL/TP registrados na Bolsa — disparam sozinhos');
        } catch(e){ log('❌ Bybit demo FALHOU: ' + e.message + ' — confira BYBIT_API_KEY/SECRET e permissões (Read+Trade, sem restrição de IP)'); }
      })();
    } else log('⚠ BYBIT_DEMO=1 mas chaves vazias — modo demo inativo (configure BYBIT_API_KEY/SECRET no Render)');
  }
  if(!process.argv.includes('--selftest')) startServer();
  if(CFG.btAuto){
    setTimeout(async () => {
      log('🔬 V12: BACKTEST_AUTO=1 — rodando walk-forward nos 3 primeiros ativos (coleta profunda)');
      for(const sym of CFG.watchlist.slice(0, 3)){
        try{
          const r = await v12Backtest({ symbol: sym });
          log('🔬 V12 ' + sym + ': ' + (r.erro ? 'ERRO — ' + r.erro : 'folds ' + r.walkForwardRolling.folds + ' · OOS ' + r.walkForwardRolling.total.trades + ' trades · WR ' + r.walkForwardRolling.total.winRate + ' · pnl ' + r.walkForwardRolling.total.pnlR + 'R · exp ' + r.walkForwardRolling.total.expectancy));
          await sleep(3000);
        }catch(e){ log('🔬 V12 ' + sym + ': ' + e.message); }
      }
    }, 25000);
  }
  if(CFG.tgToken && CFG.tgChat){
    if(!process.argv.includes('--selftest')) sendTelegram('🤖 VINGADOR BOT 24H online ✅\nPerfil: ' + PROFILES[CFG.profile].nome + ' (' + PROFILES[CFG.profile].tfs.join('/') + ')\nAtivos: ' + CFG.watchlist.join(', ') + '\nCiclo: a cada ' + CFG.intervalMin + 'min\n🛡 Selo V11: ' + (CFG.gateOn ? 'ativo' : 'desligado'));
  }
  if(!process.argv.includes('--selftest')) runScanCycle().catch(e => log('ciclo inicial: ' + e.message));
  setInterval(() => runScanCycle().catch(e => log('ciclo: ' + e.message)), CFG.intervalMin * 60000);
  setInterval(() => scoreTick().catch(() => {}), 30000);
  if(CFG.robo){
    roboEnsure();
    log('🧪 ROBÔ PAPER ativo · equity virtual ' + fmtV(CFG.roboEq) + ' · risco ' + (CFG.roboRisk * 100) + '%/trade · máx ' + CFG.roboMaxPos + ' posições · kill diário -' + (CFG.roboDailyStop * 100) + '% · futuros ' + CFG.roboLev + 'x');
    if(CFG.tgToken && CFG.tgChat && !process.argv.includes('--selftest')) sendTelegram('🧪 ROBÔ PAPER ativo ✅\nEquity virtual: ' + fmtV(CFG.roboEq) + ' · risco ' + (CFG.roboRisk * 100) + '% por trade\nFuturos Bybit · alavancagem ' + CFG.roboLev + 'x · máx ' + CFG.roboMaxPos + ' posições\nKill switch diário -' + (CFG.roboDailyStop * 100) + '%\nComandos: PAUSAR · RETOMAR · FECHAR TUDO · STATUS');
    setInterval(() => roboTick().catch(e => log('roboTick: ' + e.message)), 30000);
    setInterval(() => roboCmd().catch(() => {}), 20000);
    if(CFG.bybitDemo) setInterval(() => demoTick().catch(e => log('demoTick: ' + e.message)), 20000);
  }
} else {
  globalThis.vgScan = runScanCycle;
  globalThis.vgVerdicts = () => state.verdicts;
  globalThis.vgSignals = () => state.signals;
  globalThis.vgState = () => state;
}

// Virtual trading only. No exchange account credentials or order endpoints.
export const RULES = Object.freeze({fee:0.001, slip:0.001, risk:2, totalRisk:4, cap:50, positions:2, weakRisk:1, weakCap:30});
const valid = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
export function quoteValid(q, now=Date.now()) {
  return q && valid(q.bid) && valid(q.ask) && q.ask >= q.bid &&
    Number.isFinite(q.at) && now-q.at >= -5000 && now-q.at <= 30000;
}
export function sell(wallet, symbol, q, reason, now=Date.now()) {
  if (!quoteValid(q,now)) throw Error('QUOTE_INVALID');
  const p=wallet.positions.find(p=>p.symbol===symbol);
  if (!p) throw Error('POSITION_MISSING');
  const price=q.bid*(1-RULES.slip), gross=p.qty*price, fee=gross*RULES.fee;
  const net=gross-fee, pnl=net-p.cost;
  wallet.cash+=net; wallet.realized+=pnl;
  wallet.positions=wallet.positions.filter(x=>x.symbol!==symbol);
  return {side:'SELL',symbol,qty:p.qty,price,fee,pnl,reason,at:new Date(now).toISOString()};
}
export function buy(wallet, action, candidate, q, now=Date.now(), weakMarket=false) {
  if (wallet.paused) throw Error('PAUSED');
  if (!candidate?.scenario_allowed || candidate.symbol!==action.symbol) throw Error('CANDIDATE_BLOCKED');
  if (!quoteValid(q,now)) throw Error('QUOTE_INVALID');
  if (wallet.positions.length>=(weakMarket?1:RULES.positions) || wallet.positions.some(p=>p.symbol===action.symbol)) throw Error('POSITION_LIMIT');
  const h=candidate.four_hour;
  if (!h || !(h.close>h.ema20 && h.close>h.ema50)) throw Error('CLOSE_UNCONFIRMED');
  if (weakMarket && (!(candidate.score>=70) || !(h.ema20>h.ema50))) throw Error('WEAK_MARKET_CANDIDATE');
  if (typeof action.stop!=='number' || typeof action.target!=='number') throw Error('LEVEL_INVALID');
  const entry=q.ask*(1+RULES.slip), {stop,target}=action;
  if (!(valid(stop) && valid(target) && stop<entry && target>entry)) throw Error('LEVEL_INVALID');
  if (Math.abs(entry/candidate.price-1)>0.02) throw Error('PRICE_MOVED');
  const spread=(q.ask-q.bid)/((q.ask+q.bid)/2);
  if (spread>0.005) throw Error('SPREAD_WIDE');
  const lossPerUnit=entry*(1+RULES.fee)-stop*(1-RULES.slip)*(1-RULES.fee);
  const gainPerUnit=target*(1-RULES.slip)*(1-RULES.fee)-entry*(1+RULES.fee);
  if (!(gainPerUnit/lossPerUnit>=1.5)) throw Error('REWARD_RISK_LOW');
  const availableRisk=RULES.totalRisk-wallet.positions.reduce((s,p)=>s+p.risk,0);
  const qty=Math.min(Math.min(weakMarket?RULES.weakRisk:RULES.risk,availableRisk)/lossPerUnit,
    Math.min(weakMarket?RULES.weakCap:RULES.cap,wallet.cash)/(entry*(1+RULES.fee)));
  const cost=qty*entry*(1+RULES.fee);
  if (!(qty>0 && cost>=10 && cost<=wallet.cash+1e-8)) throw Error('BUDGET_INVALID');
  const p={symbol:action.symbol,qty,entry,stop,target,cost,risk:qty*lossPerUnit,opened:new Date(now).toISOString()};
  wallet.cash=Math.max(0,wallet.cash-cost); wallet.positions.push(p);
  return {side:'BUY',...p,fee:qty*entry*RULES.fee,reason:action.reason,at:p.opened};
}
export function checkStops(wallet, quotes, now=Date.now()) {
  const events=[];
  for (const p of [...wallet.positions]) {
    const q=quotes[p.symbol];
    if (!quoteValid(q,now)) continue;
    p.mark=q.bid; p.marked_at=new Date(q.at).toISOString();
    // Execution uses the observed bid, never a retroactive fill at the stop.
    if (q.bid<=p.stop || q.bid>=p.target) events.push(sell(wallet,p.symbol,q,q.bid<=p.stop?'STOP':'TARGET',now));
  }
  return events;
}

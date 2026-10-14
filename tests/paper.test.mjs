import test from 'node:test';
import assert from 'node:assert/strict';
import {buy,checkStops} from '../cloud/src/paper.mjs';
const wallet=()=>({cash:10000,realized:0,positions:[],paused:false});
const q=()=>({bid:100,ask:100.01,at:Date.now()});
const c=symbol=>({symbol,scenario_allowed:true,price:100,four_hour:{close:100,ema20:98,ema50:97}});
const a=symbol=>({symbol,stop:95,target:112,reason:'test'});
test('fees included, max 50 planned risk and 1000 spend per position',()=>{
  const w=wallet();const t=buy(w,a('BTCUSDT'),c('BTCUSDT'),q());
  assert.ok(t.risk<=50+1e-8);assert.ok(t.cost<=1000+1e-8);assert.ok(w.cash>=9000);assert.ok(t.fee>0);
});
test('cannot buy a third position or add to an existing one',()=>{
  const w=wallet();for(const s of ['BTCUSDT','ETHUSDT'])buy(w,a(s),c(s),q());
  assert.throws(()=>buy(w,a('SOLUSDT'),c('SOLUSDT'),q()),/POSITION_LIMIT/);
  assert.throws(()=>buy(w,a('BTCUSDT'),c('BTCUSDT'),q()),/POSITION_LIMIT/);
});
test('bad model levels, stale quotes and missing close confirmation block trades',()=>{
  assert.throws(()=>buy(wallet(),{...a('BTCUSDT'),stop:NaN},c('BTCUSDT'),q()),/LEVEL_INVALID/);
  assert.throws(()=>buy(wallet(),a('BTCUSDT'),c('BTCUSDT'),{...q(),at:Date.now()-60000}),/QUOTE_INVALID/);
  assert.throws(()=>buy(wallet(),a('BTCUSDT'),{...c('BTCUSDT'),four_hour:{close:96,ema20:98,ema50:97}},q()),/CLOSE_UNCONFIRMED/);
});
test('stop gaps execute at observed bid and can lose more than planned risk; repeat cannot sell twice',()=>{
  const w=wallet();buy(w,a('BTCUSDT'),c('BTCUSDT'),q());w.paused=true;
  const events=checkStops(w,{BTCUSDT:{bid:85,ask:85.01,at:Date.now()}});
  assert.equal(events.length,1);assert.ok(events[0].price<85);assert.ok(events[0].pnl < -50);
  assert.equal(checkStops(w,{BTCUSDT:q()}).length,0);assert.equal(w.positions.length,0);
});

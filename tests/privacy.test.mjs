import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{equal,reportQuote,basis} from '../cloud/src/worker.mjs';
const token='x'.repeat(48);
const env={DASHBOARD_TOKEN:token,INGEST_TOKEN:'y'.repeat(48),DB:{prepare(){throw Error('SECRET_WALLET_SHOULD_NOT_BE_READ');}}};
test('all personal endpoints reject anonymous readers before accessing database',async()=>{
  for(const path of ['/api/dashboard','/internal/context','/api/report','/api/backup','/private.db']){
    const r=await worker.fetch(new Request('https://example.test'+path),env);
    assert.ok([401,404].includes(r.status));assert.equal((await r.text()).includes('SECRET'),false);
  }
});
test('dashboard key does not authorize ingestion',async()=>{
  const r=await worker.fetch(new Request('https://example.test/internal/report',{method:'POST',headers:{Authorization:'Bearer '+token},body:'{}'}),env);
  assert.equal(r.status,401);
});
test('cross-origin control and login are denied',async()=>{
  for(const path of ['/api/login','/api/pause','/api/reset-paper']){
    const r=await worker.fetch(new Request('https://example.test'+path,{method:'POST',headers:{Cookie:'sp_session='+token,Origin:'https://evil.test'},body:'{}'}),env);
    assert.equal(r.status,403);
  }
});
test('valid login uses HttpOnly cookie and never returns the secret in JSON',async()=>{
  const r=await worker.fetch(new Request('https://example.test/api/login',{method:'POST',headers:{Origin:'https://example.test'},body:JSON.stringify({token})}),env);
  assert.equal(r.status,200);assert.match(r.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Strict/);assert.equal((await r.text()).includes(token),false);
});
test('short and absent configured tokens cannot authenticate',async()=>{
  assert.equal(await equal('',undefined),false);assert.equal(await equal('abc','abc'),false);
});
test('private exception messages never reach clients',async()=>{
  const r=await worker.fetch(new Request('https://example.test/api/dashboard',{headers:{Cookie:'sp_session='+token}}),env);
  assert.equal(r.status,400);assert.equal((await r.text()).includes('SECRET'),false);assert.equal(r.headers.get('Cache-Control'),'no-store');
});
test('authenticated runner quote backup requires exact symbol, source and freshness',()=>{
  const now=1_800_000_000_000;
  const item={symbol:'ALTUSDT',bid:1,ask:1.001,at:now-1000,source:'Binance spot'};
  assert.deepEqual(reportQuote({execution_quotes:[item]},'ALTUSDT',now),
    {bid:item.bid,ask:item.ask,at:item.at,source:item.source});
  assert.equal(reportQuote({execution_quotes:[item]},'BTCUSDT',now),null);
  assert.equal(reportQuote({execution_quotes:[{...item,source:'unknown'}]},'ALTUSDT',now),null);
  assert.equal(reportQuote({execution_quotes:[{...item,at:now-30001}]},'ALTUSDT',now),null);
  assert.equal(reportQuote({execution_quotes:[{...item,ask:0.5}]},'ALTUSDT',now),null);
  assert.equal(reportQuote({execution_quotes:[item,item]},'ALTUSDT',now),null);
});
test('paper BUY executes with fresh runner quote when Worker market fetch fails',async()=>{
  const now=Date.now();
  const wallet={cash:200,realized:0,paused:false,positions:[]};
  const db={wallet,version:0,report:null,
    prepare(sql){const statement={sql,args:[],bind(...args){this.args=args;return this;},
      async first(){if(sql.startsWith('SELECT id FROM reports'))return db.report?{id:db.report.id}:null;
        return {version:db.version,body:JSON.stringify(db.wallet)};}};return statement;},
    async batch(statements){const [update,...rest]=statements;
      db.wallet=JSON.parse(update.args[0]);db.version++;
      db.report=JSON.parse(rest.find(s=>s.sql.startsWith('INSERT INTO reports')).args[2]);
      return [{meta:{changes:1}}];}};
  const report={id:'cycle-'+now,wallet_basis:basis(wallet),price_time:new Date(now).toISOString(),
    analysis:{summary:'Test',detail:'Synthetic paper test',actions:[
      {side:'BUY',symbol:'ALTUSDT',stop:0.9,target:1.4,reason:'Synthetic test'}]},
    candidates:[{symbol:'ALTUSDT',price:1,score:90,scenario_allowed:true,
      four_hour:{close:1.1,ema20:1,ema50:0.9,last_closed:now-3600000}}],
    btc:{four_hour:{close:2,ema20:1.5,ema50:1,last_closed:now-3600000}},blocked:false,
    execution_quotes:[{symbol:'ALTUSDT',bid:1,ask:1.001,at:now,source:'Binance spot'}]};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('Worker market unavailable');};
  try{
    const response=await worker.fetch(new Request('https://example.test/internal/report',
      {method:'POST',headers:{Authorization:'Bearer '+env.INGEST_TOKEN},body:JSON.stringify(report)}),
      {...env,DB:db});
    assert.equal(response.status,200);
    assert.equal(db.report.outcomes[0].status,'EXECUTED');
    assert.equal(db.wallet.positions.length,1);
    assert.ok(db.wallet.cash<200);
  }finally{globalThis.fetch=originalFetch;}
});

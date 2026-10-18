import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{equal,reportQuote} from '../cloud/src/worker.mjs';
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

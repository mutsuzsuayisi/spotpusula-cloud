import {buy,sell,checkStops} from './paper.mjs';

const HEADERS={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
function reply(value,status=200,headers={}) {return Response.json(value,{status,headers:{...HEADERS,...headers}});}
export async function equal(a,b) {
  if (typeof a!=='string'||typeof b!=='string'||b.length<32||a.length>512) return false;
  const enc=new TextEncoder();
  const [x,y]=await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',enc.encode(s))));
  const xx=new Uint8Array(x), yy=new Uint8Array(y); let d=0;
  for(let i=0;i<xx.length;i++) d|=xx[i]^yy[i];
  return d===0;
}
function cookie(req){return (req.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('sp_session='))?.slice(11)||'';}
function sameOrigin(req){return req.headers.get('Origin')===new URL(req.url).origin;}
async function body(req,max=350000) {
  // Stream limit protects endpoints even when Content-Length is absent.
  if(Number(req.headers.get('Content-Length')||0)>max) throw Error('BODY_LIMIT');
  const reader=req.body?.getReader(); if(!reader) throw Error('BODY_EMPTY');
  const chunks=[]; let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('BODY_LIMIT');}chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(all));
}
async function read(env){const r=await env.DB.prepare('SELECT version,body FROM wallet WHERE id=1').first();if(!r)throw Error('NOT_INITIALIZED');return {version:r.version,wallet:JSON.parse(r.body)};}
export function basis(w){return JSON.stringify({cash:w.cash,realized:w.realized,paused:w.paused,positions:w.positions.map(({symbol,qty,entry,stop,target,cost,risk})=>({symbol,qty,entry,stop,target,cost,risk}))});}
async function save(env,old,w,events=[],report=null) {
  const token=crypto.randomUUID(), when=new Date().toISOString();
  const query='UPDATE wallet SET body=?,version=version+1,token=? WHERE id=1 AND version=?'+(report?' AND NOT EXISTS(SELECT 1 FROM reports WHERE id=?)':'');
  const args=[JSON.stringify(w),token,old.version];if(report)args.push(report.id);
  const stmts=[env.DB.prepare(query).bind(...args)];
  for(const e of events)stmts.push(env.DB.prepare('INSERT INTO events(id,created,kind,body) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM wallet WHERE token=?)').bind(crypto.randomUUID(),when,e.side||'STATUS',JSON.stringify({at:when,...e}),token));
  if(report)stmts.push(env.DB.prepare('INSERT INTO reports(id,created,body) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM wallet WHERE token=?)').bind(report.id,when,JSON.stringify(report),token));
  const result=await env.DB.batch(stmts);return result[0].meta.changes===1;
}
async function quotes(symbols) {
  const out={};
  await Promise.all([...new Set(symbols)].map(async symbol=>{
    if(!/^[A-Z0-9]{2,26}USDT$/.test(symbol))throw Error('SYMBOL_INVALID');
    const start=Date.now();
    const r=await fetch('https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol='+symbol,{signal:AbortSignal.timeout(8000),cache:'no-store'});
    if(!r.ok)throw Error('MARKET_UNAVAILABLE');const q=await r.json();
    if(q.symbol!==symbol)throw Error('SYMBOL_MISMATCH');
    out[symbol]={bid:Number(q.bidPrice),ask:Number(q.askPrice),at:start};
  }));return out;
}
async function health(env,message){for(let i=0;i<2;i++){const old=await read(env);old.wallet.health=message;if(await save(env,old,old.wallet))return;}}
async function tick(env){
  try {
    for(let attempt=0;attempt<2;attempt++){
      const old=await read(env), w=old.wallet;
      const q=await quotes(w.positions.map(p=>p.symbol));
      const now=Date.now(), gap=w.last_check&&now-Date.parse(w.last_check)>180000;
      const events=checkStops(w,q,now);
      if(gap&&w.positions.length)events.push({side:'GAP',reason:'Kontrol aralığı 3 dakikayı aştı; geçmiş fiyattan dolum yapılmadı.'});
      w.last_check=new Date(now).toISOString();w.health='Çalışıyor';
      if(await save(env,old,w,events))return;
    }
  } catch {await health(env,'Fiyat kontrolü tamamlanamadı; son fiyat zamanı kontrol edilmeli.');}
}
function validateReport(r){
  if(!r||!/^cycle-\d{10,13}$/.test(r.id)||typeof r.wallet_basis!=='string'||!r.analysis)throw Error('REPORT_INVALID');
  if(typeof r.analysis.summary!=='string'||r.analysis.summary.length>600||typeof r.analysis.detail!=='string'||r.analysis.detail.length>20000)throw Error('REPORT_INVALID');
  if(!Array.isArray(r.analysis.actions)||r.analysis.actions.length>2||!Array.isArray(r.candidates)||r.candidates.length>50)throw Error('REPORT_INVALID');
  for(const a of r.analysis.actions){if(!['BUY','SELL'].includes(a.side)||typeof a.symbol!=='string'||typeof a.reason!=='string'||a.reason.length>600)throw Error('ACTION_INVALID');}
  const age=Date.now()-Date.parse(r.price_time);
  if(!Number.isFinite(age)||age< -30000||age>600000)throw Error('REPORT_STALE');
}
async function ingest(env,r){
  validateReport(r);
  for(let attempt=0;attempt<3;attempt++){
    if(await env.DB.prepare('SELECT id FROM reports WHERE id=?').bind(r.id).first())return reply({ok:true,duplicate:true});
    const old=await read(env), w=old.wallet, outcomes=[], events=[];
    const compatible=basis(w)===r.wallet_basis;
    const allowed=compatible&&!w.paused;
    let q={};
    if(allowed){try{q=await quotes([...w.positions.map(p=>p.symbol),...r.analysis.actions.map(a=>a.symbol)]);}catch{outcomes.push({status:'REJECTED',code:'MARKET_UNAVAILABLE'});}}
    // Stop/target checks take priority over discretionary model actions.
    events.push(...checkStops(w,q));
    for(const a of r.analysis.actions){
      try{
        if(!compatible)throw Error('WALLET_CHANGED');if(w.paused)throw Error('PAUSED');
        const c=r.candidates.find(c=>c.symbol===a.symbol);
        if(a.side==='BUY'){
          if(r.blocked)throw Error('SCAN_BLOCKED');
          const btc=r.btc?.four_hour;
          if(!btc||!(btc.close>btc.ema20&&btc.close>btc.ema50))throw Error('BTC_UNCONFIRMED');
          if(Date.now()-btc.last_closed>5*3600000||Date.now()-(c?.four_hour?.last_closed||0)>5*3600000)throw Error('CANDLE_STALE');
          events.push(buy(w,a,c,q[a.symbol]));
        }else{events.push(sell(w,a.symbol,q[a.symbol],a.reason));}
        outcomes.push({symbol:a.symbol,side:a.side,status:'EXECUTED'});
      }catch(e){const codes=['WALLET_CHANGED','PAUSED','SCAN_BLOCKED','BTC_UNCONFIRMED','CANDLE_STALE','QUOTE_INVALID','CANDIDATE_BLOCKED','POSITION_LIMIT','CLOSE_UNCONFIRMED','LEVEL_INVALID','PRICE_MOVED','SPREAD_WIDE','REWARD_RISK_LOW','BUDGET_INVALID','POSITION_MISSING'];outcomes.push({symbol:a.symbol,status:'REJECTED',code:codes.includes(e.message)?e.message:'ACTION_INVALID'});}
    }
    const report={id:r.id,price_time:r.price_time,analysis:r.analysis,outcomes,model:r.model||'',generated:new Date().toISOString(),
      evidence:{candidates:r.candidates,btc:r.btc,wallet_basis:r.wallet_basis,blocked:r.blocked}};
    w.last_analysis=report.generated;w.health='Analiz tamamlandı';
    if(await save(env,old,w,events,report))return reply({ok:true});
  }
  return reply({error:'RETRY_LATER'},409);
}
export async function handle(req,env){
  const url=new URL(req.url),path=url.pathname;
  if(req.method==='POST'&&path==='/api/login'){
    if(!sameOrigin(req))return reply({error:'FORBIDDEN'},403);
    const data=await body(req,2048);
    if(!await equal(data.token,env.DASHBOARD_TOKEN))return reply({error:'Giriş başarısız'},401);
    return reply({ok:true},200,{'Set-Cookie':'sp_session='+data.token+'; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'});
  }
  if(path.startsWith('/internal/')){
    if(!await equal((req.headers.get('Authorization')||'').replace(/^Bearer /,''),env.INGEST_TOKEN))return reply({error:'UNAUTHORIZED'},401);
    if(path==='/internal/context'&&req.method==='GET'){const {wallet}=await read(env);return reply({wallet,basis:basis(wallet)});}
    if(path==='/internal/report'&&req.method==='POST')return ingest(env,await body(req));
    if(path==='/internal/failure'&&req.method==='POST'){await health(env,'Son analiz tamamlanamadı. Ayrıntılı teknik hata public günlüğe yazılmadı.');return reply({ok:true});}
    return reply({error:'NOT_FOUND'},404);
  }
  if(path.startsWith('/api/')){
    if(!await equal(cookie(req),env.DASHBOARD_TOKEN))return reply({error:'UNAUTHORIZED'},401);
    if(req.method!=='GET'&&!sameOrigin(req))return reply({error:'FORBIDDEN'},403);
    if(path==='/api/logout'&&req.method==='POST')return reply({ok:true},200,{'Set-Cookie':'sp_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    if(path==='/api/dashboard'&&req.method==='GET'){
      const {wallet}=await read(env);
      const reports=await env.DB.prepare("SELECT id,created AS generated,json_extract(body,'$.analysis.summary') AS summary FROM reports ORDER BY created DESC LIMIT 20").all();
      const events=await env.DB.prepare('SELECT body FROM events ORDER BY created DESC LIMIT 100').all();
      return reply({wallet,reports:reports.results,events:events.results.map(r=>JSON.parse(r.body))});
    }
    if(path==='/api/report'&&req.method==='GET'){
      const r=await env.DB.prepare('SELECT body FROM reports WHERE id=?').bind(url.searchParams.get('id')||'').first();
      return r?reply(JSON.parse(r.body)):reply({error:'NOT_FOUND'},404);
    }
    if(path==='/api/pause'&&req.method==='POST'){
      const data=await body(req,1000);if(typeof data.paused!=='boolean')return reply({error:'INVALID'},400);
      for(let i=0;i<3;i++){const old=await read(env);old.wallet.paused=data.paused;if(await save(env,old,old.wallet,[{side:'CONTROL',reason:data.paused?'Model işlemleri durduruldu. Stop takibi sürüyor.':'Otomatik sanal yönetim etkinleştirildi.'}]))return reply({ok:true});}
      return reply({error:'RETRY_LATER'},409);
    }
    return reply({error:'NOT_FOUND'},404);
  }
  if(req.method==='GET'&&['/','/app.js','/style.css'].includes(path)){
    const r=await env.ASSETS.fetch(req);const headers=new Headers(r.headers);for(const [k,v] of Object.entries(HEADERS))headers.set(k,v);
    return new Response(r.body,{status:r.status,headers});
  }
  return reply({error:'NOT_FOUND'},404);
}
export default {
  async fetch(req,env){try{return await handle(req,env);}catch{return reply({error:'REQUEST_FAILED'},400);}},
  async scheduled(event,env,ctx){ctx.waitUntil(tick(env).catch(()=>{}));}
};

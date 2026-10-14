const $=id=>document.getElementById(id);
let paused=true;
const money=n=>Number(n).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2})+' USDT';
const date=x=>x?new Date(x).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul'}):'Henüz yok';
function node(tag,text){const n=document.createElement(tag);n.textContent=text;return n;}
async function api(path,data){const r=await fetch(path,{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});if(r.status===401){$('dashboard').hidden=true;$('login').hidden=false;throw Error('Giriş yapmalısın.');}if(!r.ok)throw Error('İşlem tamamlanamadı; yeniden dene.');return r.json();}
function report(r){const box=document.createElement('details');box.append(node('summary',date(r.generated)+' · '+r.summary+' · Detayı aç'));let loaded=false;box.addEventListener('toggle',async()=>{if(!box.open||loaded)return;loaded=true;try{const full=await api('/api/report?id='+encodeURIComponent(r.id));box.append(node('pre',full.analysis.detail));for(const o of full.outcomes)box.append(node('p',(o.symbol||'')+' '+(o.side||'')+' · '+(o.status==='EXECUTED'?'Sanal işlem gerçekleşti':'Uygulanmadı: '+o.code)));}catch{box.append(node('p','Ayrıntı yüklenemedi. Sayfayı yenileyerek tekrar dene.'));}});return box;}
async function refresh(){
  try{const d=await api('/api/dashboard'),w=d.wallet;paused=w.paused;$('login').hidden=true;$('dashboard').hidden=false;$('notice').textContent='';
    $('cash').textContent=money(w.cash);$('pnl').textContent=money(w.realized);
    const missing=w.positions.some(p=>!Number.isFinite(p.mark));
    $('equity').textContent=missing?'Fiyat bekleniyor':money(w.cash+w.positions.reduce((s,p)=>s+p.qty*p.mark,0));
    const stale=!w.last_check||Date.now()-Date.parse(w.last_check)>180000;
    $('health').textContent=(stale?'⚠ Takip güncel değil. ':'')+w.health+(paused?' · Model işlemleri duraklatıldı. Stop takibi sürer.':' · Otomatik sanal yönetim açık.');
    $('pause').textContent=paused?'Sanal yönetimi başlat':'Model işlemlerini durdur';
    $('times').textContent='Son fiyat kontrolü: '+date(w.last_check)+' · Son analiz: '+date(w.last_analysis);
    $('latest').replaceChildren(node('p',d.reports[0]?.summary||'İlk analiz bekleniyor.'));
    if(d.reports[0])$('latest').append(report(d.reports[0]));
    $('positions').replaceChildren(...w.positions.map(p=>node('p',p.symbol+' · '+p.qty.toPrecision(6)+' adet · Stop '+p.stop+' · Hedef '+p.target+' · Fiyat zamanı '+date(p.marked_at))));
    if(!w.positions.length)$('positions').append(node('p','Açık pozisyon yok.'));
    $('reports').replaceChildren(...d.reports.slice(1).map(report));
    $('events').replaceChildren(...d.events.map(e=>node('p',date(e.at)+' · '+e.side+' '+(e.symbol||'')+' · '+(e.reason||'')+(e.pnl!==undefined?' · '+money(e.pnl):''))));
  }catch(e){$('notice').textContent=e.message;}
}
$('login').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{token:$('token').value});$('token').value='';await refresh();}catch(e){$('notice').textContent=e.message;}});
$('refresh').onclick=refresh;
$('pause').onclick=async()=>{try{await api('/api/pause',{paused:!paused});await refresh();}catch(e){$('notice').textContent=e.message;}};
$('logout').onclick=async()=>{await api('/api/logout',{});$('dashboard').hidden=true;$('login').hidden=false;for(const id of ['latest','positions','reports','events'])$(id).replaceChildren();};
refresh();setInterval(()=>{if(!$('dashboard').hidden)refresh();},60000);

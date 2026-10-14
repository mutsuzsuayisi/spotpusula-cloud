import threading
from concurrent.futures import ThreadPoolExecutor
import time
import json
from datetime import datetime
import engine
import providers
import store

STABLE={'USDC','FDUSD','TUSD','USDP','DAI','BUSD','UST','USTC','AEUR','EURI','PAX','USD1','USDD','USDE','EUR','TRY','BRL','ARS','PLN','RUB','UAH','BIDR','IDRT','GBP','AUD'}
lock=threading.Lock(); cancel=threading.Event()
job={'running':False,'phase':'Hazır','done':0,'total':0,'error':None}

def status():
    with lock: return dict(job)

def update(**kw):
    with lock: job.update(kw)

def start():
    with lock:
        if job['running']: raise ValueError('Tarama zaten devam ediyor.')
        job.update(running=True,phase='Piyasa verileri alınıyor',done=0,total=0,error=None)
    cancel.clear(); threading.Thread(target=scan,daemon=True).start()

def scan():
    try:
        s=store.settings(); begin=store.now(); warnings=[]
        now_ms=providers.market('time')['serverTime']
        info=providers.market('exchangeInfo'); initial_price_time=store.now(); ticks=providers.market('ticker/24hr'); books=providers.market('ticker/bookTicker')
        tickmap={t['symbol']:t for t in ticks}; bookmap={t['symbol']:t for t in books}
        universe=[]; excluded=0
        for m in info['symbols']:
            sym=m['symbol']; base=m['baseAsset']; t=tickmap.get(sym); b=bookmap.get(sym)
            if m['quoteAsset']!='USDT' or m['status']!='TRADING' or not m.get('isSpotTradingAllowed',False): continue
            if base in STABLE or base in {b+suffix for b in ('BTC','ETH','BNB','XRP','LINK','ADA','DOT','LTC','EOS','TRX','SUSHI','UNI','YFI') for suffix in ('UP','DOWN','BULL','BEAR')} or not t or not b:
                excluded+=1; continue
            bid=float(b['bidPrice']); ask=float(b['askPrice'])
            spread=(ask-bid)/((ask+bid)/2)*100 if bid>0 and ask>=bid else 999
            if float(t['quoteVolume'])<s['min_volume'] or spread>s['max_spread']:
                excluded+=1; continue
            universe.append((sym,float(t['quoteVolume']),spread))
        universe.sort(key=lambda x:x[1],reverse=True)
        eligible=len(universe); universe=universe[:s['max_symbols']]
        held={p['symbol'] for mode in ('real','paper') for p in store.account(mode)['positions']}
        for sym in sorted(held|{'BTCUSDT','ETHUSDT'}):
            if sym in tickmap and sym not in {u[0] for u in universe}:
                universe.append((sym,float(tickmap[sym]['quoteVolume']),None))
        results=[]; failed=[]; consecutive=0
        update(total=len(universe),phase='Kapanmış günlük mumlar inceleniyor')
        def daily(entry):
            sym,volume,spread=entry
            try:
                raw=providers.market('klines',symbol=sym,interval='1d',limit=121)
                rows=engine.candles(raw,now_ms)
                if not rows or now_ms-rows[-1]['end']>26*3600000: raise ValueError('Günlük mumlar güncel değil.')
                item=engine.analyze(sym,rows,tickmap[sym]); item['spread_pct']=spread
                if spread is None:
                    item['risks'].append('Portföy/BTC referansı: evren filtresi dışında'); item['status']='İzle'
                return item,None
            except Exception as e:
                return None,{'symbol':sym,'reason':str(e)}
        with ThreadPoolExecutor(max_workers=4) as pool:
            for idx in range(0,len(universe),4):
                if cancel.is_set(): raise ValueError('Tarama iptal edildi; önceki tamamlanmış veri korundu.')
                update(done=idx,phase=universe[idx][0]+' ve sonraki pariteler · günlük analiz')
                for item,error in pool.map(daily,universe[idx:idx+4]):
                    if error:
                        failed.append(error); consecutive+=1
                    else:
                        results.append(item); consecutive=0
                if consecutive>=5: raise ValueError('Ardışık veri hataları; tarama durduruldu. '+failed[-1]['reason'])
                time.sleep(.5)
        if not results: raise ValueError('Analiz edilebilir coin bulunamadı; filtreleri kontrol edin.')
        btc=next((r for r in results if r['symbol']=='BTCUSDT'),None)
        for r in results:
            r['relative_btc7']=r['change7']-btc['change7'] if btc else None
        results.sort(key=lambda r:r['score'],reverse=True)
        deep={r['symbol'] for r in results[:s['deep_count']]}|held|{'BTCUSDT','ETHUSDT'}
        for r in results:
            if r['symbol'] not in deep: continue
            if cancel.is_set(): raise ValueError('Tarama iptal edildi; önceki veri korundu.')
            update(phase=r['symbol']+' · 4 saat teyidi')
            try:
                rows=engine.candles(providers.market('klines',symbol=r['symbol'],interval='4h',limit=90),now_ms)
                if len(rows)<60 or now_ms-rows[-1]['end']>5*3600000: raise ValueError('4 saat verisi eksik/eski.')
                c=[x['c'] for x in rows]
                r['four_hour']={'rsi':engine.rsi(c),'ema20':engine.ema(c,20),'ema50':engine.ema(c,50),'close':c[-1],'last_closed':rows[-1]['end']}
            except ValueError as e: r['four_hour_error']=str(e)
            time.sleep(.15)
        update(phase='Haber başlıkları alınıyor',done=len(universe))
        news,errors=providers.news(); warnings.extend(errors)
        if cancel.is_set(): raise ValueError('Tarama iptal edildi; önceki veri korundu.')
        if eligible>s['max_symbols']: warnings.append(f'{eligible} uygun paritenin hacme göre ilk {s["max_symbols"]} tanesi tarandı; diğerleri kapsam dışı.')
        update(phase='Son fiyatlar ve alış/satış farkları yenileniyor')
        refreshed=True; price_time=store.now()
        try:
            final_ticks=providers.market('ticker/24hr')
            final_books=providers.market('ticker/bookTicker')
            tickmap={t['symbol']:t for t in final_ticks}
            bookmap={t['symbol']:t for t in final_books}
        except Exception as e:
            refreshed=False; price_time=initial_price_time
            warnings.append('Son fiyat yenilemesi başarısız; eski fiyatlar korunuyor, senaryo üretimi kapalı: '+str(e))
        if cancel.is_set(): raise ValueError('Tarama iptal edildi; önceki veri korundu.')
        final_ms=int(datetime.now().timestamp()*1000)
        for r in results:
            book=bookmap.get(r['symbol'],{}); bid=float(book.get('bidPrice',0)); ask=float(book.get('askPrice',0))
            spread=(ask-bid)/((ask+bid)/2)*100 if ask>=bid>0 else None
            engine.reconcile(r,tickmap.get(r['symbol']),spread,s,final_ms,refreshed)
        # Scores of unchecked coins are provisional, not an excuse to outrank checked candidates.
        results.sort(key=lambda r:(r['scenario_allowed'],bool(r.get('four_hour')),r['score']),reverse=True)
        btc=next((r for r in results if r['symbol']=='BTCUSDT'),None)
        daily_regime=('Yukarı trend' if btc['close']>btc['ema20']>btc['ema50'] else 'Karışık / zayıf') if btc else 'Veri yok'
        current_regime=('Gün içi teyit eksik' if btc.get('verification_gaps') else ('Gün içi zayıflama' if btc['risks'] else 'Gün içi teyit olumlu')) if btc else 'Veri yok'
        scan={'created':store.now(),'started':begin,'source':'Binance public spot / USDT','engine':engine.VERSION,'universe_count':len(universe),'eligible_count':eligible,'excluded_count':excluded,'failed':failed,'items':results,'news':news,'warnings':warnings,'config':s,'prices':{sym:float(t['lastPrice']) for sym,t in tickmap.items() if sym.endswith('USDT')},'price_time':price_time,'prices_refreshed':refreshed,'btc_regime':daily_regime,'btc_current':current_regime}
        store.save_scan(scan); update(phase=f'{len(results)} coin incelendi',done=len(universe))
    except Exception as e: update(error=str(e),phase='Tarama tamamlanamadı')
    finally: update(running=False)

def decision_summary(scan, account=None):
    age=max(0,(datetime.now().astimezone()-datetime.fromisoformat(scan['price_time'])).total_seconds())
    legacy=scan.get('engine')!=engine.VERSION
    candidates=sum(bool(r.get('scenario_allowed')) for r in scan['items'])
    blocked=legacy or age>3600 or not scan.get('prices_refreshed',False)
    if legacy: message='Bu tarama eski sürümden. Güncel fiyat teyidi için yeniden tara; eski kayıt değişmedi.'
    elif age>3600: message='Fiyat bir saatten eski. Yeni işlem değerlendirmeden önce yeniden tara.'
    elif not scan.get('prices_refreshed'): message='Son fiyat yenilenemedi. Miktar/işlem senaryoları kapalı; tekrar tara.'
    elif not candidates: message='Şu an tüm teknik kontrolleri geçen aday yok. İşlem açmadan bekle veya sonraki taramayı incele.'
    else: message=f'{candidates} aday teknik kontrolleri geçti. Önce gerekçelerini ve haber eksiklerini incele; ardından danışman raporu oluştur. Bu bir alım listesi değildir.'
    return {'price_age_minutes':round(age/60,1),'stale':age>3600,'legacy':legacy,'scenario_blocked':blocked,'candidate_count':candidates,'message':message,'wallet_note':('SANAL CÜZDAN — hesaplar gerçek yatırım bakiyene ait değildir.' if account and account['mode']=='paper' else 'Manuel portföy kayıtları; borsa bakiyesi doğrulanmaz.')}

def package(mode):
    scan=store.latest()
    if not scan: raise ValueError('Önce piyasa taraması yapın.')
    s=store.settings(); a=store.account(mode,scan=scan); held={p['symbol']:p for p in a['positions']}
    summary=decision_summary(scan,a)
    selected=list(scan['items'][:s['deep_count']])
    chosen={r['symbol'] for r in selected}
    selected += [r for r in scan['items'] if r['symbol'] in held and r['symbol'] not in chosen]
    def pack(r):
        x={k:v for k,v in r.items() if k!='candles'}
        x['daily_ohlcv_last30']=r.get('candles',[])[-30:]
        allowed=r.get('scenario_allowed',False) and not summary['scenario_blocked'] and a['equity'] is not None
        x['scenario']=engine.scenario(r,a['equity'],a['cash'],s['risk_pct'],s['cap_pct'],(held.get(r['symbol'],{}).get('value') or 0),s['fee_pct'],s['slip_pct']) if allowed else None
        x['scenario_note']='Varsayımsal eğitim hesabı; süre/getiri tahmini yok.' if allowed else 'Teyit eksik/zayıf, eski sürüm/fiyat veya portföy değerlemesi eksik: miktar üretilmedi.'
        return x
    context={sym:next((pack(r) for r in scan['items'] if r['symbol']==sym),None) for sym in ('BTCUSDT','ETHUSDT')}
    warnings=list(scan['warnings'])
    for sym,value in context.items():
        if value is None: warnings.append(sym+' referans verisi eksik; piyasa görünümü tam doğrulanamaz.')
    payload={'schema':'spotpusula.analysis.v1.1','engine':scan.get('engine'),'generated':store.now(),'scan_id':scan['id'],'scan_time':scan['created'],'price_time':scan['price_time'],'age_minutes':summary['price_age_minutes'],'stale':summary['stale'],'decision_summary':summary,'source':scan['source'],'btc_regime':scan['btc_regime'],'btc_current':scan.get('btc_current','Teyit yok'),'market_context':context,'portfolio':a,'risk_settings':{k:s[k] for k in ('risk_pct','cap_pct','fee_pct','slip_pct')},'coverage':{'scanned':scan['universe_count'],'eligible':scan['eligible_count'],'successful':len(scan['items']),'failed':scan['failed']},'candidates_and_holdings':[pack(r) for r in selected],'news_headlines':scan['news'],'warnings':warnings,'limitations':['Teknik puan başarı olasılığı değildir; strateji doğrulanmamıştır.','4 saat teyidi yapılmayan coinler Teyit eksik olarak gösterilir; otomatik aday sayılmaz.','RSS başlıkları tam makale değildir; resmî kaynak teyidi yapılmamıştır.','Piyasa değeri, zincir üstü akış, kilit açılımı, sosyal medya ve delist verisi yok.','Aday seçimi teknik filtreye dayanır; yalnız haberle hareketlenecek coin kaçabilir.','Her senaryo bağımsızdır; tutarları toplayarak eşzamanlı işlem yapılmaz.','Mekanik 2R/3R seviyeleri beklenen kazanç veya 30 günlük tahmin değildir.','Gecelik takip yok; fiyatlar price_time anlık görüntüsüne aittir.','Spot emir büyüklüğü/lot kuralları uygulanmaz; gerçek işlemde borsadan kontrol gerekir.']}
    return engine.PROMPT+'\n\n```json\n'+json.dumps(payload,ensure_ascii=False,indent=2,allow_nan=False)+'\n```',scan['id']

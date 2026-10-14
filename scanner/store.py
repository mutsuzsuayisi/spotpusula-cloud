import json
import os
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from engine import number

def now(): return datetime.now(timezone.utc).isoformat()
ROOT=Path(os.environ.get('SPOTPUSULA_DATA', str(Path(os.environ.get('LOCALAPPDATA',Path.home()/'.local/share'))/'SpotPusula')))
DEFAULTS={'min_volume':1000000,'max_spread':.5,'max_symbols':500,'deep_count':20,'risk_pct':.5,'cap_pct':10,'fee_pct':.1,'slip_pct':.1,'api_base':'https://generativelanguage.googleapis.com/v1beta/openai','api_model':'','paper_initial':10000,'real_initial':0,'paper_epoch':0}

def connect():
    ROOT.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(ROOT/'spotpusula.sqlite3',timeout=15)
    db.row_factory=sqlite3.Row
    return db

def init():
    with connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY, created TEXT NOT NULL, mode TEXT NOT NULL, action TEXT NOT NULL, symbol TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paper_requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, created TEXT NOT NULL, scan_id INTEGER, mode TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, response TEXT, usage TEXT);
''')
        db.execute('INSERT OR IGNORE INTO settings VALUES (1,?)',(json.dumps(DEFAULTS),))
        # Keep identifiers unique after deleting the newest row.
        for table in ('trades','scans','reports'):
            sql=db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()[0]
            if 'AUTOINCREMENT' not in sql:
                new_sql=sql.replace('CREATE TABLE '+table,'CREATE TABLE '+table+'_upgrade',1).replace('id INTEGER PRIMARY KEY','id INTEGER PRIMARY KEY AUTOINCREMENT',1)
                db.execute(new_sql)
                db.execute(f'INSERT INTO {table}_upgrade SELECT * FROM {table}')
                db.execute(f'DROP TABLE {table}')
                db.execute(f'ALTER TABLE {table}_upgrade RENAME TO {table}')


def settings():
    with connect() as db: return DEFAULTS | json.loads(db.execute('SELECT payload FROM settings WHERE id=1').fetchone()[0])

def save_settings(data):
    s=settings()
    bounds={'min_volume':(10000,1e12),'max_spread':(.01,5),'max_symbols':(20,1000),'deep_count':(1,50),'risk_pct':(.01,5),'cap_pct':(1,100),'fee_pct':(0,5),'slip_pct':(0,10),'paper_initial':(0,1e10),'real_initial':(0,1e10)}
    for k,(lo,hi) in bounds.items():
        if k in data: s[k]=number(data[k],lo,hi)
    for k in ('max_symbols','deep_count'): s[k]=int(s[k])
    for k in ('api_base','api_model'):
        if k in data: s[k]=str(data[k]).strip()[:300]
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        old=json.loads(db.execute('SELECT payload FROM settings WHERE id=1').fetchone()[0])
        for mode in ('paper','real'):
            if s[mode+'_initial'] != old.get(mode+'_initial',DEFAULTS[mode+'_initial']) and db.execute('SELECT 1 FROM trades WHERE mode=? LIMIT 1',(mode,)).fetchone():
                raise ValueError('İşlem kaydı olan cüzdanın başlangıç bakiyesi değiştirilemez. Nakit ekle/çıkar kullanın.')
        db.execute('UPDATE settings SET payload=? WHERE id=1',(json.dumps(s),))
    return s

def latest():
    with connect() as db: r=db.execute('SELECT id,payload FROM scans ORDER BY id DESC LIMIT 1').fetchone()
    return (json.loads(r['payload'])|{'id':r['id']}) if r else None

def save_scan(scan):
    with connect() as db:
        cur=db.execute('INSERT INTO scans(created,payload) VALUES (?,?)',(scan['created'],json.dumps(scan,ensure_ascii=False,allow_nan=False)))
        return cur.lastrowid

def ledger(mode, db=None):
    if mode not in ('paper','real'): raise ValueError('Geçersiz cüzdan.')
    if db is not None: return [dict(r) for r in db.execute('SELECT * FROM trades WHERE mode=? ORDER BY id',(mode,))]
    with connect() as c: return ledger(mode,c)

def account(mode, trades=None, scan=None, config=None):
    config=config or settings(); cash=config[mode+'_initial']; holdings={}; realized=0
    for t in (ledger(mode) if trades is None else trades):
        if t['action']=='deposit': cash+=t['qty']; continue
        if t['action']=='withdraw': cash-=t['qty']; continue
        sym=t['symbol']; p=holdings.setdefault(sym,{'qty':0,'cost':0})
        value=t['qty']*t['price']
        if t['action']=='buy': cash-=value+t['fee']; p['qty']+=t['qty']; p['cost']+=value+t['fee']
        else:
            cost=p['cost']/p['qty']*t['qty'] if p['qty'] else 0
            realized+=value-t['fee']-cost; cash+=value-t['fee']; p['qty']-=t['qty']; p['cost']-=cost
    if abs(cash)<1e-8: cash=0.0
    marks=(scan or {}).get('prices',{}); positions=[]; marked=0; unknown=0
    for sym,p in holdings.items():
        if p['qty']<1e-12: continue
        price=marks.get(sym); value=price*p['qty'] if price is not None else None
        marked+=value or 0
        if value is None: unknown+=1
        positions.append(dict(symbol=sym,quantity=p['qty'],average=p['cost']/p['qty'],cost=p['cost'],price=price,value=value,pnl=value-p['cost'] if value is not None else None))
    return dict(mode=mode,cash=cash,equity=cash+marked if not unknown else None,known_value=cash+marked,unknown_prices=unknown,positions=positions,realized=realized,priced_at=(scan or {}).get('price_time'))

def trade(data):
    mode=data.get('mode'); action=data.get('action'); symbol=str(data.get('symbol','')).upper().strip()
    if action not in ('buy','sell','deposit','withdraw'): raise ValueError('Geçersiz işlem.')
    qty=number(data.get('qty'),1e-12,1e12); price=0 if action in ('deposit','withdraw') else number(data.get('price'),1e-12)
    fee=number(data.get('fee',0),0); note=str(data.get('note',''))[:500]
    if action in ('buy','sell') and (not symbol.endswith('USDT') or not symbol.isalnum() or len(symbol)>30): raise ValueError('Parite örneği: SOLUSDT.')
    if action in ('deposit','withdraw'): symbol='USDT'; fee=0
    with connect() as db:
        db.execute('BEGIN IMMEDIATE'); a=account(mode,ledger(mode,db))
        if action=='buy' and qty*price+fee>a['cash']+1e-8: raise ValueError('Nakit bakiye yetersiz.')
        if action=='withdraw' and qty>a['cash']+1e-8: raise ValueError('Nakit bakiye yetersiz.')
        if action=='sell':
            available=next((p['quantity'] for p in a['positions'] if p['symbol']==symbol),0)
            if qty>available+1e-12: raise ValueError('Satış miktarı mevcut pozisyondan büyük.')
            if fee>qty*price: raise ValueError('Komisyon satış tutarından büyük olamaz.')
        db.execute('INSERT INTO trades(created,mode,action,symbol,qty,price,fee,note) VALUES (?,?,?,?,?,?,?,?)',(now(),mode,action,symbol,qty,price,fee,note))

def save_report(scan_id,mode,kind,payload,response=None,usage=None):
    with connect() as db:
        cur=db.execute('INSERT INTO reports(created,scan_id,mode,kind,payload,response,usage) VALUES (?,?,?,?,?,?,?)',(now(),scan_id,mode,kind,payload,response,json.dumps(usage or {})))
        return cur.lastrowid

def history():
    with connect() as db:
        return {'scans':[dict(r) for r in db.execute('SELECT id,created FROM scans ORDER BY id DESC LIMIT 50')], 'reports':[dict(r) for r in db.execute('SELECT id,created,kind,mode,scan_id FROM reports ORDER BY id DESC LIMIT 50')]}

def report_by_id(i):
    with connect() as db: r=db.execute('SELECT * FROM reports WHERE id=?',(int(i),)).fetchone()
    if not r: raise ValueError('Rapor bulunamadı.')
    return dict(r)

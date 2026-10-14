import json
import time
import re
import urllib.request
import urllib.error
import urllib.parse
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone

BASE='https://data-api.binance.vision'
FEEDS=[('CoinDesk','https://www.coindesk.com/arc/outboundfeeds/rss/'),('Cointelegraph','https://cointelegraph.com/rss')]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**kw): return None

def request(url, payload=None, key=None, timeout=18):
    headers={'User-Agent':'SpotPusula/1.0 personal research','Accept':'application/json, application/xml, text/xml, */*'}
    if payload is not None: headers['Content-Type']='application/json'
    if key: headers['Authorization']='Bearer '+key
    req=urllib.request.Request(url,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
    for attempt in range(3):
        try:
            with (urllib.request.build_opener(NoRedirect()) if key or payload is not None else urllib.request.build_opener()).open(req,timeout=timeout) as r:
                data=r.read(32_000_001)
                if len(data)>32_000_000: raise ValueError('Yanıt boyutu sınırı aşıldı.')
                return data
        except urllib.error.HTTPError as e:
            # Never repeat charged POSTs automatically.
            if payload is None and e.code in (429,500,502,503,504) and attempt<2:
                delay=min(30,max(1,int(e.headers.get('Retry-After','3'))))
                time.sleep(delay); continue
            raise ValueError(f'Kaynak HTTP {e.code} döndürdü: {urllib.parse.urlsplit(url).hostname}. Erişim/kota durumunu kontrol edin.') from None
        except (urllib.error.URLError,TimeoutError,OSError):
            raise ValueError(f'Bağlantı kurulamadı: {urllib.parse.urlsplit(url).hostname}. İnternet bağlantısını kontrol edin.') from None

def market(path, **params):
    return json.loads(request(BASE+'/api/v3/'+path+('?' + urllib.parse.urlencode(params) if params else '')))

def news():
    out=[]; errors=[]; seen=set(); cutoff=time.time()-7*86400
    for name,url in FEEDS:
        try:
            root=ET.fromstring(request(url))
            for item in root.findall('.//item')[:70]:
                title=re.sub('<[^>]+>','',item.findtext('title','')).strip()
                link=item.findtext('link','').strip(); date=item.findtext('pubDate','')
                try: dt=parsedate_to_datetime(date).astimezone(timezone.utc)
                except (ValueError,TypeError): continue
                if not cutoff<=dt.timestamp()<=time.time()+300 or not link.startswith('https://'): continue
                norm=re.sub(r'\W','',title.casefold())
                if not title or norm in seen: continue
                seen.add(norm)
                out.append(dict(title=title[:500],url=link,published=dt.isoformat(),source=name,verified=False))
        except Exception as e: errors.append(f'{name}: {e}')
    return sorted(out,key=lambda x:x['published'],reverse=True)[:60],errors

def ask(base, model, key, prompt):
    u=urllib.parse.urlsplit(base)
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('API adresi kullanıcı/parola içermeyen HTTPS adresi olmalı.')
    if not model.strip() or not key.strip(): raise ValueError('Model adı ve API anahtarı gerekli.')
    body={'model':model.strip(),'messages':[{'role':'user','content':prompt}]}
    data=json.loads(request(base.rstrip('/')+'/chat/completions',body,key,timeout=120))
    try: answer=data['choices'][0]['message']['content']
    except (KeyError,IndexError,TypeError): raise ValueError('Sağlayıcıdan geçerli metin yanıtı alınamadı.')
    if not isinstance(answer,str) or not answer.strip(): raise ValueError('Model boş yanıt döndürdü.')
    return answer, data.get('usage',{})

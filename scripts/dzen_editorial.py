#!/usr/bin/env python3
from __future__ import annotations
import datetime as dt, html, json, os, re, sys, urllib.parse, urllib.request, urllib.error, xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
DOCS=ROOT/"docs"; ARTICLES=DOCS/"articles"; RSS=DOCS/"rss.xml"
CFG=json.loads((ROOT/"dzen/config.json").read_text(encoding="utf-8"))
TZ=ZoneInfo(CFG["timezone"])
BASE=os.getenv("PAGES_BASE_URL","https://sitnervs.github.io/osint-auto-publisher").rstrip("/")
CATS={
"compliance":{"label":"Комплаенс","query":"Russia international compliance AML KYC sanctions anti-corruption corporate compliance regulatory changes latest","focus":"KYC/KYB, ПОД/ФТ, санкционный контроль, антикоррупция, внутренний контроль, корпоративные расследования и регуляторные изменения. Разделяй нормы закона и практические рекомендации."},
"antifraud":{"label":"Антифрод","query":"latest fraud trends financial payment fraud social engineering corporate fraud Russia international","focus":"Схемы мошенничества, признаки, механика, контрольные процедуры, мониторинг операций, расследования и предотвращение потерь. Не давай инструкций для совершения преступлений."},
"osint":{"label":"OSINT","query":"OSINT open source intelligence corporate investigations digital footprint verification latest cases","focus":"Законные методы OSINT, проверка компаний и цифрового следа, верификация источников, поиск связей, расследовательские кейсы и ограничения открытых данных. Не раскрывай частные персональные данные."},
"russia_news":{"label":"Новости России","query":"Russia latest important news economy business technology regulation cybersecurity law","focus":"Значимые новости России с последствиями для бизнеса, финансов, технологий, регулирования и безопасности. Объясни контекст и последствия, а не пересказывай ленту."},
"world_news":{"label":"Мировые новости","query":"latest world news geopolitics economy technology cybersecurity regulation international","focus":"Значимые мировые события с влиянием на бизнес, экономику, технологии, безопасность и международную среду. Разделяй факты, заявления и оценки."}}
def post(url,payload,headers):
 req=urllib.request.Request(url,data=json.dumps(payload,ensure_ascii=False).encode(),headers={"Content-Type":"application/json",**headers},method="POST")
 try:
  with urllib.request.urlopen(req,timeout=75) as r:return json.loads(r.read().decode())
 except urllib.error.HTTPError as e:raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8','replace')[:1000]}")
def slot_for(now):
 if os.getenv("GITHUB_EVENT_NAME")=="workflow_dispatch" and os.getenv("ARTICLE_CATEGORY"):
  key=os.environ["ARTICLE_CATEGORY"]
  if key not in CATS:raise RuntimeError("Unknown ARTICLE_CATEGORY")
  return key,next(x for x in CFG["schedule"] if x["category"]==key)
 local=now.astimezone(TZ)
 slot=min(CFG["schedule"],key=lambda x:abs((dt.datetime.combine(local.date(),dt.time.fromisoformat(x["local"]),TZ)-local).total_seconds()))
 if abs((dt.datetime.combine(local.date(),dt.time.fromisoformat(slot["local"]),TZ)-local).total_seconds())>90*60:raise RuntimeError("Outside scheduled publication window")
 return slot["category"],slot
def sources_for(cat,now):
 key=os.getenv("TAVILY_API_KEY")
 if not key:raise RuntimeError("Missing TAVILY_API_KEY GitHub Actions secret")
 q=CATS[cat]["query"]+(" published in the last 48 hours" if cat.endswith("_news") else " recent developments")
 d=post("https://api.tavily.com/search",{"query":q,"topic":"news" if cat.endswith("_news") else "general","search_depth":"advanced","max_results":12,"include_answer":False,"include_raw_content":False,"days":2 if cat.endswith("_news") else 7},{"Authorization":"Bearer "+key})
 out=[];domains=set();urls=set()
 for x in d.get("results",[]):
  u=str(x.get("url","")).strip(); title=str(x.get("title","")).strip(); desc=str(x.get("content","")).strip()
  p=urllib.parse.urlparse(u); domain=(p.hostname or "").lower().removeprefix("www.")
  if p.scheme not in ("http","https") or not domain or domain in domains or u in urls or not title or not desc:continue
  domains.add(domain);urls.add(u);out.append({"title":title[:220],"url":u,"domain":domain,"date":str(x.get("published_date") or ""),"summary":desc[:2000]})
 if len(out)<3:raise RuntimeError(f"Only {len(out)} independent source domains; need at least 3")
 return out[:8]
def generate(cat,now,src):
 key=os.getenv("GEMINI_API_KEY")
 if not key:raise RuntimeError("Missing GEMINI_API_KEY GitHub Actions secret")
 prompt=f"""Ты — главный редактор аналитического медиа OSINTNER. Напиши самостоятельную полноценную статью для Дзена на русском языке.
Рубрика: {CATS[cat]['label']}. Фокус: {CATS[cat]['focus']}
Дата и время Москва: {now.isoformat()}
Исходные материалы (используй только подтверждённые сведения):
{json.dumps(src,ensure_ascii=False,indent=2)}
Требования:
- 5 000–9 000 символов без разметки; не заметка и не компиляция заголовков.
- Конкретный точный заголовок до 100 символов, сильный лид, 4–7 подзаголовков, логичный вывод.
- Анализируй причины, механизм, контекст, последствия и практическое значение.
- Не выдумывай цифры, даты, цитаты, должности, документы, заявления и кейсы. Любое конкретное утверждение должно подтверждаться источниками.
- Используй минимум три домена из списка, укажи их URL в source_urls. Не приписывай источнику неподтверждённое.
- В новостях отделяй дату события от даты публикации; не называй старое событие сегодняшним.
- В правовых темах указывай юрисдикцию и актуальность, отделяй закон от мнения.
- Нейтральный тон. Без кликбейта, пропаганды, манипуляций, неподтверждённых обвинений, рекламы, эмодзи и хештегов.
- Не копируй источники, не используй таблицы. Не выдавай статью за юридическую консультацию.
Верни только JSON: {{"title":"...","dek":"...","excerpt":"...","body_markdown":"...","source_urls":["..."],"editorial_note":"...","keywords":["..."]}}"""
 d=post(f"https://generativelanguage.googleapis.com/v1beta/models/{os.getenv('GEMINI_MODEL','gemini-2.5-flash')}:generateContent?key={urllib.parse.quote(key)}",{"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0.35,"maxOutputTokens":10000,"responseMimeType":"application/json"}},{})
 raw="".join(p.get("text","") for p in d.get("candidates",[{}])[0].get("content",{}).get("parts",[]))
 try:return json.loads(raw)
 except Exception:
  m=re.search(r"\{.*\}",raw,re.S)
  if not m:raise RuntimeError("Gemini returned invalid JSON")
  return json.loads(m.group())
def inline(s):
 s=html.escape(s,quote=True)
 s=re.sub(r"\*\*(.+?)\*\*",r"<strong>\1</strong>",s)
 s=re.sub(r"\*(.+?)\*",r"<em>\1</em>",s)
 s=re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)",r'<a href="\2" rel="nofollow noopener">\1</a>',s)
 return s
def render(md):
 out=[];para=[];listing=False
 def flush():
  if para:out.append("<p>"+" ".join(inline(x) for x in para)+"</p>");para.clear()
 def close():
  nonlocal listing
  if listing:out.append("</ul>");listing=False
 for line in md.splitlines():
  s=line.strip()
  if not s:flush();close()
  elif s.startswith("## "):flush();close();out.append("<h2>"+inline(s[3:])+"</h2>")
  elif s.startswith("### "):flush();close();out.append("<h3>"+inline(s[4:])+"</h3>")
  elif re.match(r"^[-*]\s+",s):
   flush()
   if not listing:out.append("<ul>");listing=True
   out.append("<li>"+inline(re.sub(r"^[-*]\s+","",s))+"</li>")
  else:close();para.append(s)
 flush();close();return "\n".join(out)
def slug(s):
 s=s.lower().replace("ё","e");s=re.sub(r"[^a-zа-я0-9]+","-",s,flags=re.I).strip("-")
 return s[:65].strip("-") or "article"
def build_rss():
 root=ET.Element("rss",{"version":"2.0","xmlns:content":"http://purl.org/rss/1.0/modules/content/"})
 ch=ET.SubElement(root,"channel")
 for tag,val in [("title",CFG["feed"]["title"]),("link",BASE),("description",CFG["feed"]["description"]),("language","ru"),("lastBuildDate",dt.datetime.now(dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000"))]:ET.SubElement(ch,tag).text=val
 items=[]
 for p in ARTICLES.glob("*.json"):
  try:items.append(json.loads(p.read_text(encoding="utf-8")))
  except Exception as e:print("Skip",p,e,file=sys.stderr)
 for x in sorted(items,key=lambda z:z["published_at"],reverse=True)[:100]:
  it=ET.SubElement(ch,"item")
  ET.SubElement(it,"title").text=x["title"];ET.SubElement(it,"link").text=x["url"]
  ET.SubElement(it,"guid",{"isPermaLink":"true"}).text=x["url"]
  when=dt.datetime.fromisoformat(x["published_at"]).astimezone(dt.timezone.utc)
  ET.SubElement(it,"pubDate").text=when.strftime("%a, %d %b %Y %H:%M:%S +0000")
  ET.SubElement(it,"description").text=x["excerpt"]
  ET.SubElement(it,"{http://purl.org/rss/1.0/modules/content/}encoded").text=x["full_html"]
  ET.SubElement(it,"category").text=x["category_label"]
 ET.indent(root,space="  ");RSS.write_bytes(ET.tostring(root,encoding="utf-8",xml_declaration=True))
def main():
 now=dt.datetime.now(TZ);cat,slot=slot_for(now)
 if os.getenv("DRY_RUN","false").lower()=="true":
  print(json.dumps({"dry_run":True,"category":cat,"slot":slot,"time":now.isoformat()},ensure_ascii=False));return
 ARTICLES.mkdir(parents=True,exist_ok=True)
 day=now.strftime("%Y%m%d");ident=f"{day}-{slot['local'].replace(':','')}-{cat}"
 meta=ARTICLES/(ident+".json")
 if meta.exists():print("Already generated:",ident);build_rss();return
 src=sources_for(cat,now);a=generate(cat,now,src)
 title=str(a.get("title","")).strip();body=str(a.get("body_markdown","")).strip()
 plain=re.sub(r"\s+"," ",re.sub(r"[*_#>\[\]()!-]"," ",body)).strip()
 if not title or len(title)>120:raise RuntimeError("Invalid title")
 if len(plain)<int(CFG["article"]["min_chars"]):raise RuntimeError(f"Too short: {len(plain)} chars")
 if len(plain)>int(CFG["article"]["max_chars"]):raise RuntimeError(f"Too long: {len(plain)} chars")
 if len(re.findall(r"(?m)^##?\s+",body))<4:raise RuntimeError("Need at least four section headings")
 srcmap={s["url"]:s for s in src};urls=[]
 for u in a.get("source_urls",[]):
  if u in srcmap and u not in urls:urls.append(u)
 if len(urls)<3 or len({srcmap[u]["domain"] for u in urls})<3:raise RuntimeError("Need three cited source domains")
 published=now.replace(second=0,microsecond=0);stamp=published.isoformat()
 slugname=slug(title)+"-"+ident;url=f"{BASE}/articles/{slugname}.html"
 bodyhtml=render(body)
 sources_html="".join(f'<li><a href="{html.escape(u,quote=True)}" rel="nofollow noopener">{html.escape(urllib.parse.urlparse(u).netloc)}</a></li>' for u in urls)
 full=f'<h1>{html.escape(title)}</h1><p><em>{html.escape(str(a.get("dek","")))}</em></p>{bodyhtml}<h2>Источники</h2><ul>{sources_html}</ul>'
 page=f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)} — OSINTNER</title><meta name="description" content="{html.escape(str(a.get('excerpt','')),quote=True)}"><link rel="canonical" href="{url}"><style>body{{margin:0;background:#f5f5f2;color:#202321;font:18px/1.72 Georgia,serif}}main{{max-width:780px;margin:40px auto;padding:0 22px}}header{{font:600 13px Arial,sans-serif;letter-spacing:.12em;color:#52645b}}h1{{font:700 clamp(32px,6vw,48px)/1.15 Arial,sans-serif}}.dek{{font:21px/1.5 Arial,sans-serif;color:#555}}.meta{{font:13px Arial,sans-serif;color:#777;margin:24px 0 34px}}h2,h3{{font-family:Arial,sans-serif;line-height:1.3;margin-top:1.8em}}a{{color:#176044}}</style></head><body><main><header>OSINTNER · {CATS[cat]['label']}</header><h1>{html.escape(title)}</h1><div class="dek">{html.escape(str(a.get('dek','')))}</div><div class="meta">{published.strftime('%d.%m.%Y · %H:%M')} · Москва</div><article>{bodyhtml}</article><h2>Источники</h2><ul>{sources_html}</ul></main></body></html>"""
 pagepath=ARTICLES/(slugname+".html")
 if pagepath.exists():raise RuntimeError("Refusing to overwrite existing article")
 pagepath.write_text(page,encoding="utf-8")
 record={"id":ident,"title":title,"excerpt":str(a.get("excerpt","")),"category_label":CATS[cat]["label"],"published_at":stamp,"url":url,"source_urls":urls,"plain_chars":len(plain),"full_html":full}
 meta.write_text(json.dumps(record,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
 build_rss()
 print(json.dumps({"created":True,"title":title,"category":CATS[cat]["label"],"chars":len(plain),"sources":urls,"article":url,"rss":BASE+"/rss.xml"},ensure_ascii=False,indent=2))
if __name__=="__main__":
 try:main()
 except Exception as e:print("EDITORIAL PIPELINE FAILED:",e,file=sys.stderr);sys.exit(1)

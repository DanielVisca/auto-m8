// The live-architecture overlay, run inside a code tile's sandbox (see tileBridge.ts). The parent
// posts {perch:'arch', payload:{sections}} (server/archmap.ts); this finds each section in the tile's
// own drawing and puts a ring and a badge on it, a hover card (PRs, findings, time vs assumed) and a
// drill-in panel on click. It needs nothing from the tile's code: a part is found by
// [data-section="key"], or by the first text in the drawing that starts with the section's match text
// (for SVG text, the smallest box around it). Kept as plain JS in a string: it runs in the iframe.
const CSS = `
.am-ring{position:fixed;pointer-events:none;border-radius:10px;z-index:2147483000;transition:box-shadow .2s}
.am-badge{position:fixed;z-index:2147483001;display:flex;gap:4px;align-items:center;font:600 10.5px/1 -apple-system,system-ui,sans-serif;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:3px 6px;cursor:pointer;white-space:nowrap;box-shadow:0 1px 4px #0004}
.am-badge b{font-weight:700}.am-dot{width:7px;height:7px;border-radius:50%}
.am-card{font-family:-apple-system,system-ui,sans-serif;position:fixed;z-index:2147483002;max-width:340px;min-width:240px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px #0006;font-size:12px;line-height:1.4;pointer-events:none}
.am-card h4,.am-panel h4{margin:0 0 4px;font-size:13px}.am-mut{color:var(--muted)}.am-sec{margin-top:8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.am-pr,.am-f{display:flex;gap:6px;align-items:baseline;margin-top:3px}.am-pr a{color:var(--fg);text-decoration:none}.am-pr a:hover{text-decoration:underline}
.am-ph{font-size:10.5px;padding:0 5px;border-radius:6px;border:1px solid var(--line);white-space:nowrap;color:var(--muted)}
.am-f{display:block;border-left:3px solid var(--warn);padding-left:6px;margin-top:6px}.am-f.wrong{border-color:var(--bad)}.am-f.confirmed{border-color:var(--ok)}
.am-panel{font-family:-apple-system,system-ui,sans-serif;position:fixed;top:0;right:0;bottom:0;width:min(380px,92vw);z-index:2147483003;background:var(--bg);border-left:1px solid var(--line);box-shadow:-6px 0 24px #0005;padding:12px 14px;overflow:auto;font-size:12.5px}
.am-x{float:right;cursor:pointer;background:none;border:0;color:var(--muted);font-size:16px}
.am-tog{position:fixed;left:6px;bottom:6px;z-index:2147483001;font:600 10.5px -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:3px 7px;cursor:pointer}
.am-bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:3px}.am-bar i{display:block;height:100%}
`
export const ARCH_OVERLAY = String.raw`(()=>{
let A=null,on=true,open=null,hits=[],pin=null;
const css=document.createElement('style');css.textContent=__CSS__;document.head.appendChild(css);
const layer=document.createElement('div');document.body.appendChild(layer);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ms=v=>v==null?'?':v>=1000?(v/1000).toFixed(v>=10000?0:1)+' s':Math.round(v)+' ms';
const COL={wrong:'var(--bad)',slow:'var(--warn)',attention:'var(--warn)',building:'var(--accent)',ok:'var(--ok)',idle:'var(--line)'};
const WHY={wrong:'an assumption broke',slow:'slower than assumed',attention:'a PR needs you',building:'PRs in flight',ok:'on track',idle:'no signal yet'};
const PH=p=>/needs you|CI red|changes/.test(p)?'var(--bad)':/ready/.test(p)?'var(--ok)':/verified|proven/.test(p)?'var(--ok)':/merged|live/.test(p)?'var(--accent)':'var(--muted)';
function boxOf(s){
  let el=document.querySelector('[data-section="'+CSS.escape(s.key)+'"]');
  if(el)return el;
  const want=String(s.match||s.label||s.key).trim().toLowerCase();if(!want)return null;
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);let t=null,n;
  while((n=walker.nextNode())){if(layer.contains(n)||n.tagName==='SCRIPT'||n.tagName==='STYLE')continue;
    const own=[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.textContent).join('').trim().toLowerCase();
    if(own&&own.startsWith(want)){t=n;break}}
  if(!t)return null;
  const svg=t.ownerSVGElement;
  if(svg){const r=t.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let best=null,area=1/0;
    svg.querySelectorAll('rect,path,polygon').forEach(b=>{const q=b.getBoundingClientRect(),a=q.width*q.height;
      if(q.left<=r.left+1&&q.right>=r.right-1&&q.top<=cy&&q.bottom>=cy&&a<area&&q.width>r.width&&q.height>r.height*1.2){best=b;area=a}});
    return best||t}
  let p=t;for(let i=0;i<4&&p.parentElement&&p.parentElement!==document.body;i++){p=p.parentElement;const st=getComputedStyle(p);if(st.borderTopWidth!=='0px'||st.backgroundColor!=='rgba(0, 0, 0, 0)')break}
  return p}
function spark(r,exp){if(!r||r.length<2)return'';const v=r.map(x=>x.value),mx=Math.max(...v,exp||0)*1.1,w=200,h=34;
  const pts=v.map((y,i)=>(i/(v.length-1)*w).toFixed(1)+','+(h-y/mx*h).toFixed(1)).join(' ');
  const e=exp?'<line x1="0" x2="'+w+'" y1="'+(h-exp/mx*h)+'" y2="'+(h-exp/mx*h)+'" stroke="var(--muted)" stroke-dasharray="3 3"/>':'';
  return '<svg width="'+w+'" height="'+h+'" style="display:block;margin-top:4px">'+e+'<polyline fill="none" stroke="var(--accent)" stroke-width="1.5" points="'+pts+'"/></svg>'}
function timingHtml(s,full){const t=s.timing;if(!t)return'';if(t.error)return '<div class="am-sec">Time</div><div class="am-mut">'+esc(t.error)+'</div>';
  const pct=t.expected_ms?Math.min(100,t.value/t.expected_ms*50):null;
  return '<div class="am-sec">'+esc(t.what||'Time')+(s.bottleneck?' · <b style="color:var(--bad)">bottleneck</b>':'')+'</div>'+
  '<div><b>'+ms(t.value)+'</b>'+(t.p95!=null?' <span class="am-mut">p95 '+ms(t.p95)+'</span>':'')+(t.expected_ms?' <span class="am-mut">· assumed '+ms(t.expected_ms)+'</span>':'')+(s.share!=null?' <span class="am-mut">· '+Math.round(s.share*100)+'% of measured time</span>':'')+'</div>'+
  (pct!=null?'<div class="am-bar"><i style="width:'+pct+'%;background:'+(s.ratio>1.5?'var(--bad)':s.ratio>1.15?'var(--warn)':'var(--ok)')+'"></i></div>':'')+(full?spark(s.readings,t.expected_ms):'')}
function findHtml(f,full){return '<div class="am-f '+esc(f.kind)+'"><b>'+esc(f.kind==='wrong'?'Wrong assumption':f.kind[0].toUpperCase()+f.kind.slice(1))+'</b>'+(f.auto?' <span class="am-mut">(measured)</span>':'')+': '+esc(f.title)+
  (f.expected||f.observed?'<div class="am-mut">'+(f.expected?'expected '+esc(f.expected):'')+(f.expected&&f.observed?' → ':'')+(f.observed?'observed '+esc(f.observed):'')+'</div>':'')+
  (full&&f.evidence?'<div>'+(/^https?:/.test(f.evidence)?'<a href="'+esc(f.evidence)+'" target="_blank">evidence</a>':esc(f.evidence))+'</div>':'')+'</div>'}
function prHtml(p){const n=p.url.replace('https://github.com/','').replace('/pull/','#');return '<div class="am-pr"><span class="am-ph" style="color:'+PH(p.phase)+'">'+esc(p.phase)+'</span><a href="'+esc(p.url)+'" target="_blank" title="'+esc(n)+'">'+esc(p.title||n)+'</a></div>'}
function body(s,full){const lim=full?99:4;let h='<h4>'+esc(s.label)+'</h4><div class="am-mut">'+esc(WHY[s.state]||'')+(s.about?' · '+esc(s.about):'')+'</div>';
  h+=timingHtml(s,full);
  if(s.findings.length)h+='<div class="am-sec">Findings ('+s.findings.length+')</div>'+s.findings.slice(0,lim).map(f=>findHtml(f,full)).join('')+(s.findings.length>lim?'<div class="am-mut">+'+(s.findings.length-lim)+' more · click</div>':'');
  if(s.prs.length)h+='<div class="am-sec">PRs ('+s.prs.length+')</div>'+s.prs.slice(0,lim).map(prHtml).join('')+(s.prs.length>lim?'<div class="am-mut">+'+(s.prs.length-lim)+' more · click</div>':'');
  if(s.workstream){const w=s.workstream;h+='<div class="am-sec">Workstream</div><div>'+esc(w.name)+(w.current!=null?' · now '+esc(w.current)+(w.unit?' '+esc(w.unit):''):'')+(w.target!=null?' → '+esc(w.target):'')+(w.gate==='blocked'?' · <span style="color:var(--warn)">blocked</span>':'')+'</div>'}
  if(full&&s.agents.length)h+='<div class="am-sec">Agents</div>'+s.agents.map(a=>'<div>'+esc(a.name)+' <span class="am-mut">'+esc(a.status||'')+'</span></div>').join('');
  if(!s.prs.length&&!s.findings.length&&!s.timing)h+='<div class="am-mut" style="margin-top:6px">Nothing linked yet.</div>';
  return h}
function draw(){layer.innerHTML='';hits=[];if(!A||!A.sections.length)return;
  const tog=document.createElement('button');tog.className='am-tog';tog.textContent=on?'◉ live: on':'○ live: off';tog.title='Show PRs, findings and timings on the diagram';tog.onclick=()=>{on=!on;draw()};layer.appendChild(tog);
  if(!on)return;
  for(const s of A.sections){const el=boxOf(s);if(!el)continue;const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
    const c=COL[s.state]||COL.idle;hits.push({s,r});
    const ring=document.createElement('div');ring.className='am-ring';Object.assign(ring.style,{left:r.left-2+'px',top:r.top-2+'px',width:r.width+4+'px',height:r.height+4+'px',boxShadow:'0 0 0 '+(s.bottleneck?3:2)+'px '+c+(s.bottleneck?', 0 0 18px 2px '+c:'')});layer.appendChild(ring);
    const b=document.createElement('div');b.className='am-badge';
    b.innerHTML='<span class="am-dot" style="background:'+c+'"></span>'+(s.timing&&s.timing.value!=null?'<b>'+ms(s.timing.value)+'</b>':'')+(s.findings.length?'<span style="color:var(--bad)">⚠'+s.findings.length+'</span>':'')+(s.prs.length?'<span>'+s.prs.length+' PR</span>':'')+(s.bottleneck?'<span style="color:var(--bad)">slowest</span>':'');
    const small=r.height<34;Object.assign(b.style,small?{left:r.right+6+'px',top:r.top+r.height/2+'px',transform:'translateY(-50%)'}:{left:Math.max(2,r.right-8)+'px',top:Math.max(2,r.top-9)+'px',transform:'translateX(-100%)'});
    b.onclick=e=>{e.stopPropagation();panel(s)};layer.appendChild(b)}
  if(pin)panel(A.sections.find(x=>x.key===pin))}
let card=null;
addEventListener('mousemove',e=>{if(!on||!hits.length)return;const h=hits.filter(x=>e.clientX>=x.r.left&&e.clientX<=x.r.right&&e.clientY>=x.r.top&&e.clientY<=x.r.bottom).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0];
  if(!h||document.querySelector('.am-panel')&&e.target.closest&&e.target.closest('.am-panel')){if(card){card.remove();card=null}return}
  if(!card){card=document.createElement('div');card.className='am-card';layer.appendChild(card)}
  if(card.dataset.k!==h.s.key){card.dataset.k=h.s.key;card.innerHTML=body(h.s,false)+'<div class="am-mut" style="margin-top:6px">Click for details</div>'}
  const w=card.offsetWidth,ht=card.offsetHeight;card.style.left=Math.min(innerWidth-w-6,e.clientX+14)+'px';card.style.top=Math.min(innerHeight-ht-6,e.clientY+14)+'px'},{passive:true});
addEventListener('mouseleave',()=>{if(card){card.remove();card=null}});
addEventListener('click',e=>{if(!on||e.target.closest&&(e.target.closest('.am-panel')||e.target.closest('a,button,input,select')))return;
  const h=hits.filter(x=>e.clientX>=x.r.left&&e.clientX<=x.r.right&&e.clientY>=x.r.top&&e.clientY<=x.r.bottom).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0];if(h)panel(h.s)},true);
function panel(s){document.querySelectorAll('.am-panel').forEach(p=>p.remove());if(!s){pin=null;return}pin=s.key;if(card){card.remove();card=null}
  const p=document.createElement('div');p.className='am-panel';p.innerHTML='<button class="am-x" title="Close">×</button>'+body(s,true);p.querySelector('.am-x').onclick=()=>{pin=null;p.remove()};layer.appendChild(p)}
let raf=0;const again=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(draw)};
addEventListener('resize',again);addEventListener('scroll',again,true);
new MutationObserver(m=>{if(m.some(x=>!layer.contains(x.target)))again()}).observe(document.body,{subtree:true,childList:true,characterData:true});
addEventListener('message',e=>{const m=e.data||{};if(m.perch==='arch'){A=m.payload;again()}});
})()`.replace('__CSS__', JSON.stringify(CSS))

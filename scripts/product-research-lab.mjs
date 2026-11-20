// Disposable fixture for research integration tests. No telemetry leaves this process.
// Start with: node scripts/product-research-lab.mjs [port]
import { createServer } from 'node:http'
const port = Number(process.argv[2] || 4792)
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Observability Lab</title><style>
body{margin:0;font:15px system-ui;background:#f4f6f8;color:#172a3a}nav{background:#172a3a;padding:20px;color:white;display:flex;gap:24px}a{color:inherit}main{max-width:960px;margin:40px auto;padding:24px}section{background:white;border:1px solid #dbe1e6;border-radius:12px;padding:24px;margin:16px 0}button,input{font:inherit;padding:10px;border:1px solid #c6ced6;border-radius:6px}button{cursor:pointer;background:#e8f0fc}label{display:block;margin:12px 0}table{width:100%;text-align:left}th,td{padding:12px;border-bottom:1px solid #eee}.error{color:#ad2323}.ok{color:#167344}.muted{color:#687887}dialog{border:1px solid #bbb;border-radius:12px;padding:28px}svg{width:100%;height:120px}
</style></head><body><nav><b>Observability Lab</b><a href="/">Services</a><a href="/traces">Traces</a><a href="/alerts">Alerts</a><a href="/onboarding">Setup</a></nav><main id="app"></main><script>
const app=document.getElementById('app');
const traces=[{id:'trace-1',service:'checkout',duration:840,error:'Database timeout'},{id:'trace-2',service:'catalog',duration:42,error:''}];
if(location.pathname==='/onboarding'){
 app.innerHTML='<h1>Connect your first service</h1><section><label>Service name <input id="service" aria-label="Service name"></label><button id="connect">Connect service</button><p id="result"></p></section>';
 document.getElementById('connect').onclick=()=>{const s=document.getElementById('service').value.trim();document.getElementById('result').textContent=s?'Connected '+s+'. First trace received.':'Enter a service name';if(s)localStorage.setItem('lab-service',s)};
}else if(location.pathname==='/alerts'){
 app.innerHTML='<h1>Alerts</h1><section><label>Alert name <input id="name" aria-label="Alert name"></label><button id="create">Create alert</button><p id="validation" role="status"></p></section><section><h2>Saved alerts</h2><div id="saved"></div></section>';
 const render=()=>{const s=document.getElementById('saved');s.textContent='';for(const n of JSON.parse(localStorage.getItem('lab-alerts')||'[]')){const p=document.createElement('p');p.textContent=n+' — Monitoring';s.append(p)}};render();
 document.getElementById('create').onclick=()=>{const n=document.getElementById('name').value.trim();const v=document.getElementById('validation');if(!n){v.className='error';v.textContent='Alert name is required';return}const a=JSON.parse(localStorage.getItem('lab-alerts')||'[]');if(!a.includes(n))a.push(n);localStorage.setItem('lab-alerts',JSON.stringify(a));v.className='ok';v.textContent='Alert saved';render()};
}else if(location.pathname.startsWith('/traces')){
 app.innerHTML='<h1>Trace explorer</h1><section><label>Filter service <input aria-label="Filter service" id="filter"></label><p id="loading">Loading traces…</p><table><thead><tr><th>Service</th><th>Duration</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></section><dialog id="detail"><h2>Trace detail</h2><p>checkout → postgres</p><p>Database timeout · 840ms</p><svg viewBox="0 0 500 120"><rect x="0" y="10" width="480" height="22" fill="#5b85d6"/><rect x="40" y="48" width="430" height="22" fill="#d65b65"/></svg><button id="close">Close details</button></dialog>';
 const draw=()=>{const f=document.getElementById('filter').value;document.getElementById('rows').innerHTML=traces.filter(t=>t.service.includes(f)).map(t=>'<tr><td><button data-id="'+t.id+'">'+t.service+'</button></td><td>'+t.duration+'ms</td><td>'+ (t.error||'Success')+'</td></tr>').join('');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>document.getElementById('detail').showModal())};
 setTimeout(()=>{document.getElementById('loading').textContent='2 traces loaded';draw()},450);document.getElementById('filter').oninput=draw;document.getElementById('close').onclick=()=>document.getElementById('detail').close();
}else{
 app.innerHTML='<h1>Services</h1><p class="muted">Synthetic data for testing the product research agent. This is not vendor evidence.</p><section><h2>checkout</h2><p>2 services · 2 traces · 1 error</p><a href="/traces">Investigate slow checkout</a></section><section><h2>Try the workflow</h2><p>Connect a service, filter traces, inspect a span, create an alert, then reload to verify it persists.</p><a href="/onboarding">Start setup</a></section>';
}
</script></body></html>`
createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html)}).listen(port,'127.0.0.1',()=>console.log('Research lab: http://127.0.0.1:'+port))

// The sandbox every tile runs in: a code tile on a canvas, or a tile written into a chat message.
// The page has an opaque origin (sandbox without same-origin), so it can't read perch's cookies or
// call perch directly. Its only door is the bridge below: perch.data(...) asks perch, which serves
// it (see /api/canvas/data). Variables reach it as perch.vars and change through the 'vars' message.

export const BRIDGE = (theme: Record<string, string>, state: any, vars: Record<string, unknown> = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>:root{${Object.entries(theme).map(([k, v]) => `${k}:${v}`).join(';')}}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-size:12.5px}body,button,input,select{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif!important}a{color:var(--accent)}</style>
<script>(()=>{let n=0;const wait=new Map();const subs=[];
addEventListener('message',e=>{const m=e.data||{};if(m.perch==='reply'){const w=wait.get(m.id);if(w){wait.delete(m.id);m.error?w[1](new Error(m.error)):w[0](m.data)}}if(m.perch==='refresh')subs.forEach(f=>{try{f()}catch(err){report(err)}});if(m.perch==='vars'){window.perch.vars=m.payload||{};subs.forEach(f=>{try{f()}catch(err){report(err)}})}});
const call=(type,payload)=>new Promise((ok,bad)=>{const id=++n;wait.set(id,[ok,bad]);parent.postMessage({perch:type,id,payload},'*')});
const report=err=>parent.postMessage({perch:'error',payload:String(err&&err.message||err)},'*');
let lastActivity=0;['pointerdown','pointermove','keydown','wheel'].forEach(type=>addEventListener(type,e=>{if(e.isTrusted&&Date.now()-lastActivity>1000){lastActivity=Date.now();parent.postMessage({perch:'activity'},'*')}},{passive:true,capture:true}));
addEventListener('error',e=>report(e.message));addEventListener('unhandledrejection',e=>report(e.reason));
window.perch={state:${JSON.stringify(state ?? null)},vars:${JSON.stringify(vars)},data:q=>call('data',q),save:o=>{window.perch.state=o;return call('save',o)},onRefresh:f=>subs.push(f),ok:()=>parent.postMessage({perch:'ok'},'*')};})()</script></head><body>`

// The page's colour variables, copied into every tile so it matches light and dark.
export function tileTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  return Object.fromEntries(['--bg', '--fg', '--muted', '--line', '--accent', '--ok', '--bad', '--warn'].map(k => [k, css.getPropertyValue(k).trim()]))
}

const CHAT_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com; font-src https://cdnjs.cloudflare.com data:; img-src data: blob:; connect-src 'none'"
// A tile written into a chat message. connect-src 'none' stops it sending anything out itself,
// so its data leaves only through perch's bridge. Full documents are flattened into the bridge page.
export function inlineDoc(theme: Record<string, string>, vars: Record<string, unknown>, body: string) {
  const frag = body.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?(html|head|body)\b[^>]*>/gi, '')
  return BRIDGE(theme, null, vars).replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CHAT_CSP}">`) + frag + '</body></html>'
}

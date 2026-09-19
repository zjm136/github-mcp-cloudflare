// ============================================================
//  GitHub MCP + API Key 管理后台（单文件）
//  管理员登录 → 生成/撤销 每用户的独立 Key
// ============================================================

const UPSTREAM = 'https://api.githubcopilot.com/mcp/';

// ---------- 简单 KV 替代：用 Workers KV 绑定 `KEYS` ----------
// 若没绑 KV，回退到内存 Map（注意：内存会随实例重置，生产务必绑 KV）

// 工具：读/写 key 列表（存成 JSON 字符串）
async function loadKeys(env) {
  if (env.KEYS) { // KV namespace
    const v = await env.KEYS.get('keylist');
    return v ? JSON.parse(v) : [];
  }
  return globalThis.__keys || [];
}
async function saveKeys(env, list) {
  if (env.KEYS) {
    await env.KEYS.put('keylist', JSON.stringify(list));
  } else {
    globalThis.__keys = list;
  }
}

// 生成随机 key
function genKey() {
  const a = crypto.getRandomValues(new Uint8Array(24));
  return 'sk_' + [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// HTML：登录页 + 管理后台（同一份，靠 JS 切换）
const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP Key 管理</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;background:#0f1115;color:#e6e6e6}
  h1{font-size:20px} input,button{font-size:14px;padding:10px;border-radius:6px;border:1px solid #333;background:#1a1d24;color:#fff}
  button{background:#2f81f7;cursor:pointer;border:none;margin:2px}
  button.del{background:#c53030} .box{background:#171a21;padding:20px;border-radius:10px;margin:16px 0}
  .key{font-family:monospace;background:#0b0d11;padding:8px 10px;border-radius:5px;word-break:break-all}
  .ok{color:#4ade80}.err{color:#f87171}
</style></head>
<body>
<div id="app"></div>
<script>
const API = location.pathname.replace(/\\/$/,'') ; // base
async function post(path, body){
  const r = await fetch(API+path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})});
  return r.json();
}
function render(state, data){
  const el = document.getElementById('app');
  if(!state.loggedIn){
    el.innerHTML = \`<h1>🔐 MCP API Key 管理后台</h1>
      <div class="box"><input id="pwd" type="password" placeholder="管理密码" style="width:70%">
      <button onclick="login()">登录</button></div><div id="msg"></div>\`;
    return;
  }
  let html = \`<h1>✅ 已登录 · 你好，\${state.name||'admin'}</h1>
    <div class="box">备注：<input id="note" placeholder="如：给张三 / 给李四的智能体">
    <button onclick="create()">＋ 生成新 API Key</button></div>\`;
  (data.keys||[]).forEach(k=>{
    html += \`<div class="box"><div class="key">\${k.key}</div>
      <div>备注：\${k.note||'(无)'} · 创建：\${new Date(k.created).toLocaleString()}</div>
      <button class="del" onclick="revoke('\${k.key}')">撤销</button></div>\`;
  });
  html += \`<button onclick="logout()">退出</button>\`;
  el.innerHTML = html;
}
async function login(){
  const r = await post('/api/login', {password:document.getElementById('pwd').value});
  if(r.ok){ sessionStorage.setItem('tok', r.token); location.reload(); }
  else document.getElementById('msg').innerHTML = '<p class="err">密码错误</p>';
}
async function create(){
  const note = document.getElementById('note').value;
  const r = await post('/api/keys/create', {token:sessionStorage.getItem('tok'), note});
  if(r.ok){ alert('新 Key：'+r.key+'\\n\\n请发给对方，仅显示一次'); location.reload(); }
  else alert('失败：'+ (r.error||''));
}
async function revoke(key){
  if(!confirm('确定撤销？该用户将立即失效')) return;
  await post('/api/keys/revoke', {token:sessionStorage.getItem('tok'), key});
  location.reload();
}
function logout(){ sessionStorage.removeItem('tok'); location.reload(); }

// 启动：用 cookie/token 换取状态
(async()=>{
  const tok = sessionStorage.getItem('tok');
  const r = await fetch(API+'/api/state', {headers:{'Authorization':'Bearer '+tok}}).then(x=>x.json());
  const data = await fetch(API+'/api/keys/list', {headers:{'Authorization':'Bearer '+tok}}).then(x=>x.json()).catch(()=>({}));
  render(r, data);
})();
</script></body></html>`;

// 简易 token：密码正确后签发，存于内存映射（生产建议短期 JWT，此处够用）
const sessions = new Map(); // token -> true

function auth(req) {
  const h = req.headers.get('Authorization') || '';
  const tok = h.replace('Bearer ', '');
  return sessions.has(tok);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

    // ---- 健康检查 ----
    if (p === '/health') return json({ ok: true });

    // ---- 登录：校验管理密码 ----
    if (p === '/api/login' && request.method === 'POST') {
      const { password } = await request.json();
      if (!env.ADMIN_PASSWORD) return json({ error: '管理员密码未配置(GITHUB_TOKEN/ADMIN_PASSWORD 需在 CF Variables 设置)' }, 500);
      // 常量时间比较，防时序攻击
      const ok = password && env.ADMIN_PASSWORD && password.length === env.ADMIN_PASSWORD.length
        && crypto.subtle ? await safeEqual(password, env.ADMIN_PASSWORD) : password === env.ADMIN_PASSWORD;
      if (ok) {
        const token = genKey();
        sessions.set(token, true);
        return json({ ok: true, token });
      }
      return json({ error: '密码错误' }, 401);
    }

    // ---- 状态 ----
    if (p === '/api/state') return json({ loggedIn: auth(request) });

    // ---- 以下均需登录 ----
    const guard = () => auth(request) || json({ error: '未登录' }, 401);

    if (p === '/api/keys/list') {
      if (!auth(request)) return json({ error: '未登录' }, 401);
      const keys = await loadKeys(env);
      return json({ keys: keys.map(k => ({ key: k.key, note: k.note, created: k.created })) });
    }

    if (p === '/api/keys/create' && request.method === 'POST') {
      if (!auth(request)) return json({ error: '未登录' }, 401);
      const { note } = await request.json();
      const keys = await loadKeys(env);
      const k = { key: genKey(), note: note || '', created: Date.now() };
      keys.push(k);
      await saveKeys(env, keys);
      return json({ ok: true, key: k.key }); // 仅此刻返回完整 key
    }

    if (p === '/api/keys/revoke' && request.method === 'POST') {
      if (!auth(request)) return json({ error: '未登录' }, 401);
      const { key } = await request.json();
      let keys = await loadKeys(env);
      keys = keys.filter(x => x.key !== key);
      await saveKeys(env, keys);
      return json({ ok: true });
    }

    // ---- 管理后台页面（任何未匹配 GET 走页面，需登录可见完整功能）----
    if (request.method === 'GET') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
    }

    // ---- MCP 代理（需有效 API Key）----
    const clientKey = request.headers.get('X-API-Key') || '';
    const keys = await loadKeys(env);
    const valid = keys.some(k => k.key === clientKey);
    if (!valid) return json({ error: 'invalid api key' }, 401);

    // 转发到 GitHub MCP
    if (!p.startsWith('/mcp')) return json({ error: 'not found' }, 404);
    const upstreamUrl = UPSTREAM + p.replace('/mcp', '') + url.search;
    const init = {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': request.headers.get('Content-Type') || 'application/json',
        'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
        'User-Agent': 'github-mcp-worker/2.0',
      },
      redirect: 'follow',
    };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
    try {
      const resp = await fetch(upstreamUrl, init);
      const headers = new Headers(resp.headers); headers.delete('transfer-encoding');
      return new Response(resp.body, { status: resp.status, headers });
    } catch (err) {
      return json({ error: 'upstream_failed', msg: err.message }, 502);
    }
  },
};

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

// Vercel Edge Middleware — パスワード認証（Cookie方式）
// 環境変数 BASIC_AUTH_PASSWORD が設定されている場合のみ有効
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };

async function sha256hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Write</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;width:100%;max-width:360px}
h1{font-size:1.25rem;margin-bottom:.5rem}
p{font-size:.875rem;color:#888;margin-bottom:1.5rem}
input{width:100%;padding:.625rem .75rem;background:#0a0a0a;border:1px solid #444;border-radius:8px;color:#e5e5e5;font-size:.9375rem;outline:none}
input:focus{border-color:#6366f1}
button{width:100%;margin-top:1rem;padding:.625rem;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:.9375rem;cursor:pointer}
button:hover{background:#5558e6}
button:disabled{opacity:.6;cursor:default}
.e{color:#ef4444;font-size:.8125rem;margin-top:.5rem;display:none}
</style></head><body>
<div class="c"><h1>The Write</h1><p>パスワードを入力してください</p>
<form id="f"><input type="password" id="pw" placeholder="パスワード" autofocus required>
<div class="e" id="e">パスワードが正しくありません</div>
<button type="submit" id="b">ログイン</button></form></div>
<script>
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();
const pw=document.getElementById('pw'),err=document.getElementById('e'),btn=document.getElementById('b');
err.style.display='none';btn.disabled=true;btn.textContent='...';
try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
if(r.ok){location.reload()}else{err.style.display='block';btn.disabled=false;btn.textContent='ログイン'}}
catch(x){err.textContent='接続エラー';err.style.display='block';btn.disabled=false;btn.textContent='ログイン'}});
</script></body></html>`;

export default async function middleware(request) {
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!password) return; // 未設定なら認証スキップ

  const url = new URL(request.url);

  // ログインAPIは認証不要
  if (url.pathname === '/api/login') return;

  // Cookie認証チェック
  const token = getCookie(request.headers.get('cookie'), 'auth-token');
  const expected = await sha256hex(password);
  if (token === expected) return; // 認証OK

  // APIリクエストには401 JSONを返す
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // それ以外はログインページを表示
  return new Response(LOGIN_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

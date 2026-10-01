"""Public front door for the WhatsApp MCP stack on Railway.

Everything except /health sits behind a secret path prefix (ACCESS_KEY):

  /health                     -> 200 "ok" (Railway health check; reveals nothing)
  /<ACCESS_KEY>/mcp           -> proxied to the MCP server (streamable HTTP)
  /<ACCESS_KEY>/link          -> page to link WhatsApp by scanning a QR code
  /<ACCESS_KEY>/link/state    -> JSON polled by that page

The bridge (127.0.0.1:8080) and MCP server (127.0.0.1:8000) never listen
publicly; only this gateway does.
"""
import hmac
import os
from pathlib import Path

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from starlette.routing import Route

ACCESS_KEY = os.environ.get("ACCESS_KEY", "").strip()
if len(ACCESS_KEY) < 24:
    raise SystemExit("ACCESS_KEY must be set to a random string of at least 24 characters")

STORE = Path(os.environ.get("STORE_DIR", "/data/store"))
MCP_UPSTREAM = "http://127.0.0.1:8000"
BRIDGE = "http://127.0.0.1:8080"

client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0))

HOP = {"host", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
       "upgrade", "proxy-authorization", "proxy-authenticate", "origin", "content-length"}


def key_ok(request: Request) -> bool:
    return hmac.compare_digest(request.path_params.get("key", ""), ACCESS_KEY)


def not_found() -> Response:
    return PlainTextResponse("Not found", status_code=404)


async def health(_: Request) -> Response:
    return PlainTextResponse("ok")


async def mcp_proxy(request: Request) -> Response:
    if not key_ok(request):
        return not_found()
    rest = request.path_params.get("rest", "")
    url = f"{MCP_UPSTREAM}/mcp{('/' + rest) if rest else ''}"
    if request.url.query:
        url += "?" + request.url.query
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    headers["host"] = "127.0.0.1:8000"
    body = await request.body()
    try:
        upstream = await client.send(
            client.build_request(request.method, url, headers=headers, content=body), stream=True
        )
    except httpx.HTTPError:
        return JSONResponse({"error": "WhatsApp MCP server is starting or unavailable"}, status_code=503)
    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP and k.lower() != "content-encoding"}
    return StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code, headers=out_headers,
        background=BackgroundTask(upstream.aclose),
    )


def bridge_token() -> str:
    env = os.environ.get("WHATSAPP_BRIDGE_TOKEN", "").strip()
    if env:
        return env
    try:
        return (STORE / ".bridge-token").read_text().strip()
    except OSError:
        return ""


async def link_state(request: Request) -> Response:
    if not key_ok(request):
        return not_found()
    qr_file = STORE / "pairing-qr.txt"
    qr = qr_file.read_text().strip() if qr_file.exists() else None
    connected = False
    try:
        r = await client.get(f"{BRIDGE}/api/health", headers={"Authorization": f"Bearer {bridge_token()}"}, timeout=5)
        connected = r.status_code == 200 and r.json().get("connected") is True
    except Exception:
        pass
    if connected:
        state = "linked"
    elif qr:
        state = "waiting_for_scan"
    else:
        state = "starting"
    return JSONResponse({"state": state, "qr": None if connected else qr},
                        headers={"Cache-Control": "no-store"})


LINK_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Link WhatsApp</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f5f2;color:#1c2b22;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#fff;border-radius:16px;padding:32px;max-width:380px;width:calc(100% - 32px);box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
 h1{font-size:20px;margin:0 0 8px} p{color:#4b5a51;line-height:1.5;font-size:15px}
 #qr{display:inline-block;padding:12px;background:#fff;margin:12px 0}
 .ok{font-size:48px} ol{text-align:left;color:#4b5a51;font-size:14px;line-height:1.6;padding-left:20px}
</style></head><body><div class="card">
<h1>Link WhatsApp to the cloud</h1>
<div id="body"><p>Checking status…</p></div>
</div>
<script>
let last=null;
async function tick(){
  try{
    const r=await fetch('state',{cache:'no-store'}); const s=await r.json();
    const b=document.getElementById('body');
    if(s.state==='linked'){b.innerHTML='<div class="ok">✅</div><p><b>Linked.</b> WhatsApp is running in the cloud. You can close this page.</p>';last=null;return;}
    if(s.state==='waiting_for_scan'&&s.qr){
      if(s.qr!==last){
        b.innerHTML='<ol><li>Open WhatsApp on your phone</li><li>Settings → Linked devices → Link a device</li><li>Scan this code</li></ol><div id="qr"></div><p style="font-size:13px">The code refreshes automatically.</p>';
        new QRCode(document.getElementById('qr'),{text:s.qr,width:256,height:256,correctLevel:QRCode.CorrectLevel.L});
        last=s.qr;
      }
    } else { b.innerHTML='<p>Preparing a fresh QR code… this usually takes under 30 seconds and the page updates on its own.</p>'; last=null; }
  }catch(e){}
}
tick(); setInterval(tick,3000);
</script></body></html>"""


async def link_page(request: Request) -> Response:
    if not key_ok(request):
        return not_found()
    return HTMLResponse(LINK_PAGE, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


METHODS = ["GET", "POST", "DELETE", "OPTIONS", "HEAD"]
app = Starlette(routes=[
    Route("/health", health),
    Route("/{key}/mcp", mcp_proxy, methods=METHODS),
    Route("/{key}/mcp/{rest:path}", mcp_proxy, methods=METHODS),
    Route("/{key}/link", lambda r: Response(status_code=307, headers={"Location": f"/{r.path_params['key']}/link/"}) if key_ok(r) else not_found()),
    Route("/{key}/link/", link_page),
    Route("/{key}/link/state", link_state),
])

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8088")), proxy_headers=True,
                forwarded_allow_ips="*", log_level="info")

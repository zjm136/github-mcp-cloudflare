const UPSTREAM = 'https://api.githubcopilot.com/mcp/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 可选网关鉴权（防被扫配额）。没设 API_KEY 或设为 disabled 则跳过
    if (env.API_KEY && env.API_KEY !== 'disabled') {
      const clientKey = request.headers.get('X-API-Key') || '';
      if (clientKey !== env.API_KEY) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // 仅放行 MCP 路径
    if (!url.pathname.startsWith('/mcp')) {
      return new Response('not found', { status: 404 });
    }

    const upstreamUrl = UPSTREAM + url.pathname.replace('/mcp', '') + url.search;
    const init = {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': request.headers.get('Content-Type') || 'application/json',
        'Accept': request.headers.get('Accept') || 'application/json, text/event-stream',
        'User-Agent': 'github-mcp-worker/1.0',
      },
      redirect: 'follow',
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = await request.arrayBuffer();
    }

    try {
      const resp = await fetch(upstreamUrl, init);
      const headers = new Headers(resp.headers);
      headers.delete('transfer-encoding');
      return new Response(resp.body, { status: resp.status, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream_failed', msg: err.message }),
        { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  },
};

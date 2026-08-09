/**
 * Extra-Booster — Phase 1: 통과 전용(pass-through) 프록시
 *
 * 이 파일이 하는 일은 딱 하나입니다.
 *   들어온 요청을 하나도 건드리지 않고 api.anthropic.com 으로 그대로 넘기고,
 *   돌아온 응답을 하나도 건드리지 않고 그대로 돌려준다.
 *
 * NVIDIA 전환도, 이어쓰기도 여기 없습니다. Phase 1의 목적은 오직 하나,
 * "Claude Pro 구독 로그인이 중간에 프록시를 하나 끼워도 통과하는가?"
 * 를 확인하는 것입니다. 이 질문에 NO 가 나오면 이후 설계가 전부 무의미하므로,
 * 다른 어떤 코드도 넣지 않은 상태에서 먼저 확인합니다.
 *
 * 의존성 없는 단일 파일로 작성했습니다. 빌드 도구 없이 Cloudflare 대시보드
 * 편집기에 그대로 붙여넣어도 동작합니다 — 확인 단계에서 실패 지점을 하나라도
 * 줄이는 편이 낫기 때문입니다. (PLAN.md 는 TypeScript 를 적어 두었지만,
 * 타입과 빌드 파이프라인은 실제 로직이 생기는 Phase 2 에서 도입합니다.)
 */

const UPSTREAM_HOST = "api.anthropic.com";
const MARKER = "phase1-passthrough";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 사람이 브라우저로 주소를 열었을 때. 배포가 살아 있는지 눈으로 확인하는 용도.
    if (url.pathname === "/" || url.pathname === "/__eb/health") {
      return statusPage(url);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const startedAt = Date.now();

    const upstreamUrl = new URL(url);
    upstreamUrl.protocol = "https:";
    upstreamUrl.hostname = UPSTREAM_HOST;
    upstreamUrl.port = "";

    // Host 는 "이 요청이 어느 서버로 가는가"를 뜻하므로, 목적지가 바뀌면
    // 원본 값을 그대로 들고 가면 안 됩니다. 나머지 헤더(Authorization,
    // x-api-key, anthropic-version, anthropic-beta ...)는 손대지 않습니다.
    const headers = new Headers(request.headers);
    headers.delete("host");

    let upstream;
    try {
      upstream = await fetch(
        new Request(upstreamUrl, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
    } catch (err) {
      log({
        path: url.pathname,
        method: request.method,
        status: 0,
        ms: Date.now() - startedAt,
        auth: authKind(request),
        error: String(err && err.message ? err.message : err),
      });
      return jsonError(
        502,
        "upstream_unreachable",
        "Anthropic 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }

    log({
      path: url.pathname,
      method: request.method,
      status: upstream.status,
      ms: Date.now() - startedAt,
      auth: authKind(request),
      // Phase 3에서 전환 판정에 쓸 신호들. 지금은 관찰만 합니다.
      retryAfter: upstream.headers.get("retry-after"),
      rlRequests: upstream.headers.get("anthropic-ratelimit-requests-remaining"),
      rlTokens: upstream.headers.get("anthropic-ratelimit-tokens-remaining"),
    });

    const responseHeaders = new Headers(upstream.headers);

    // 프록시를 실제로 거쳤다는 증거. 이게 없으면 설정이 무시된 것입니다.
    responseHeaders.set("x-extra-booster", MARKER);

    // 런타임이 본문을 이미 압축 해제한 뒤 넘겨주므로, 원본의 압축/길이 헤더를
    // 그대로 두면 클라이언트가 깨진 본문을 받게 됩니다. 스트리밍(SSE) 응답이
    // 중간에 버퍼링되는 것도 같은 이유로 막습니다.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    // 본문은 읽지 않고 스트림 그대로 흘려보냅니다. 여기서 한 번이라도
    // await response.text() 를 하면 스트리밍이 죽고 답변이 한 번에 뭉쳐 나옵니다.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

/**
 * 어떤 방식으로 인증했는지만 기록합니다. Phase 1이 답하려는 질문이
 * 바로 이것이기 때문입니다 — Pro 구독은 oauth, API 키는 api-key 로 찍힙니다.
 * 토큰 값 자체는 절대 기록하지 않습니다.
 */
function authKind(request) {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    return authorization.toLowerCase().startsWith("bearer ") ? "oauth" : "other";
  }
  if (request.headers.get("x-api-key")) return "api-key";
  return "none";
}

function log(fields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "authorization, x-api-key, anthropic-version, anthropic-beta, content-type",
    "access-control-max-age": "86400",
  };
}

function jsonError(status, type, message) {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "x-extra-booster": MARKER,
      },
    },
  );
}

function statusPage(url) {
  const html = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extra-Booster — 작동 중</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:2rem 1.25rem; font: 16px/1.7 -apple-system, BlinkMacSystemFont,
         "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  .ok { color: #4b7f16; font-weight: 700; }
  code { background: rgba(128,128,128,.16); padding: .15em .4em; border-radius: 4px;
         font-size: .85em; word-break: break-all; }
  ol { padding-left: 1.2rem; }
  li { margin-bottom: .5rem; }
  .muted { opacity: .7; font-size: .9rem; }
</style></head><body><main>
<h1><span class="ok">✅</span> Extra-Booster 작동 중</h1>
<p class="muted">Phase 1 · 통과 전용 프록시 · 아직 NVIDIA는 연결되어 있지 않습니다.</p>
<p>이 화면이 보인다면 <strong>배포는 성공</strong>입니다. 다만 아직 진짜 확인은 끝나지 않았습니다.</p>
<h2 style="font-size:1.05rem">다음 할 일</h2>
<ol>
<li>이 주소를 복사하세요:<br><code>${escapeHtml(url.origin)}</code></li>
<li>Claude Code 환경변수 <code>ANTHROPIC_BASE_URL</code> 에 넣으세요.</li>
<li>Claude Code를 켜고 아무거나 물어보세요.</li>
<li>로그에 줄이 찍히면 <strong>Pro 구독이 프록시를 통과한 것</strong>입니다.</li>
</ol>
<p class="muted">자세한 절차는 저장소의 <code>DEPLOY.md</code>를 보세요.</p>
</main></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-extra-booster": MARKER,
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

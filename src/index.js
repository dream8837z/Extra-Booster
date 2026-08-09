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

    // 자가진단. 휴대폰 브라우저만으로 "프록시 경로가 실제로 뚫려 있는가"를
    // 판정하기 위한 것입니다. 인증 정보 없이 자기 자신의 /v1/messages 를 호출해
    // 브라우저 → Worker → Anthropic → 되돌아오기 까지 전 구간을 한 번에 지나갑니다.
    if (url.pathname === "/__eb/selftest") {
      return selfTest(url);
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

/**
 * 인증 정보 없이 자기 자신의 /v1/messages 를 호출합니다.
 *
 * 열쇠를 안 넣었으니 Anthropic 은 반드시 401 authentication_error 를 돌려줍니다.
 * 바로 그 401 이 "우리가 원하는 정답"입니다 — 그 응답이 돌아왔다는 것은
 * 요청이 Worker 를 지나 진짜 Anthropic 서버까지 갔다가 온전히 돌아왔다는 뜻이니까요.
 *
 * 사용자의 로그인 정보는 하나도 필요하지 않고, 어디에도 남지 않습니다.
 */
async function selfTest(url) {
  const startedAt = Date.now();
  const checks = [];
  let verdict = "fail";

  try {
    const probe = await fetch(`${url.origin}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    const elapsed = Date.now() - startedAt;
    const raw = await probe.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* JSON 이 아니면 아래에서 실패로 잡힙니다 */
    }

    const marker = probe.headers.get("x-extra-booster");
    const errorType = parsed?.error?.type ?? null;

    checks.push({
      ok: marker === MARKER,
      label: "요청이 이 프록시를 통과했는가",
      detail: marker ? `표식 확인됨 (${marker})` : "표식 없음 — 프록시를 안 거쳤습니다",
    });

    checks.push({
      ok: probe.status === 401,
      label: "Anthropic 서버까지 도달했는가",
      detail: `응답 코드 ${probe.status}${probe.status === 401 ? " (열쇠를 안 넣었으니 정상)" : ""}`,
    });

    checks.push({
      ok: errorType === "authentication_error",
      label: "Anthropic 이 보낸 응답이 온전히 돌아왔는가",
      detail: errorType
        ? `error.type = ${errorType}`
        : "Anthropic 형식의 응답이 아닙니다",
    });

    checks.push({
      ok: elapsed < 10000,
      label: "왕복 속도",
      detail: `${elapsed}ms`,
    });

    verdict = checks.every((c) => c.ok) ? "pass" : "fail";

    log({ path: "/__eb/selftest", verdict, status: probe.status, ms: elapsed });
  } catch (err) {
    checks.push({
      ok: false,
      label: "Anthropic 서버 연결",
      detail: String(err && err.message ? err.message : err),
    });
    log({ path: "/__eb/selftest", verdict: "fail", error: String(err) });
  }

  return selfTestPage(url, verdict, checks);
}

function selfTestPage(url, verdict, checks) {
  const passed = verdict === "pass";
  const rows = checks
    .map(
      (c) => `<li class="${c.ok ? "y" : "n"}">
        <span class="mk">${c.ok ? "✅" : "❌"}</span>
        <span><strong>${escapeHtml(c.label)}</strong><br>
        <span class="d">${escapeHtml(c.detail)}</span></span></li>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extra-Booster 자가진단</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:2rem 1.25rem 4rem; font: 16px/1.7 -apple-system, BlinkMacSystemFont,
         "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
  .sub { opacity:.7; font-size:.9rem; margin:0 0 1.5rem; }
  ul { list-style:none; padding:0; margin:0 0 1.75rem; }
  li { display:flex; gap:.7rem; align-items:flex-start; padding:.8rem 0;
       border-bottom:1px solid rgba(128,128,128,.22); }
  .mk { flex:none; }
  .d { opacity:.65; font-size:.87rem; }
  .box { border-radius:10px; padding:1.1rem 1.15rem; margin-bottom:1.5rem; }
  .pass { background:rgba(75,127,22,.13); border:1px solid rgba(75,127,22,.4); }
  .fail { background:rgba(168,84,28,.13); border:1px solid rgba(168,84,28,.4); }
  .box h2 { font-size:1.05rem; margin:0 0 .4rem; }
  .box p { margin:0; font-size:.93rem; }
  code { background:rgba(128,128,128,.16); padding:.15em .4em; border-radius:4px;
         font-size:.85em; word-break:break-all; }
  a.btn { display:inline-block; padding:.7rem 1.1rem; border-radius:8px;
          border:1px solid rgba(128,128,128,.4); text-decoration:none; color:inherit;
          font-size:.92rem; }
</style></head><body><main>
<h1>${passed ? "✅ 자가진단 통과" : "❌ 자가진단 실패"}</h1>
<p class="sub">브라우저 → 이 프록시 → Anthropic → 되돌아오기 전 구간 점검</p>

<ul>${rows}</ul>

<div class="box ${passed ? "pass" : "fail"}">
${
  passed
    ? `<h2>프록시는 정상입니다</h2>
       <p>요청이 이 프록시를 지나 Anthropic 서버까지 갔다가 온전히 돌아왔습니다.
       <strong>배관은 뚫렸습니다.</strong></p>
       <p style="margin-top:.6rem">아직 확인되지 않은 것: <strong>Claude Code가 이 주소를 실제로 사용하는가.</strong>
       그건 Claude Code를 실행하면서 확인해야 합니다.</p>`
    : `<h2>어딘가 막혀 있습니다</h2>
       <p>위에서 ❌ 가 붙은 줄을 그대로 Claude에게 보여주세요.
       어디서 막혔는지 짚어드리겠습니다.</p>`
}
</div>

<a class="btn" href="/">← 상태 화면으로</a>
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
  a.btn { display:inline-block; padding:.8rem 1.2rem; border-radius:8px;
          border:1px solid rgba(128,128,128,.45); text-decoration:none; color:inherit;
          font-size:1rem; font-weight:600; }
</style></head><body><main>
<h1><span class="ok">✅</span> Extra-Booster 작동 중</h1>
<p class="muted">Phase 1 · 통과 전용 프록시 · 아직 NVIDIA는 연결되어 있지 않습니다.</p>
<p>이 화면이 보인다면 <strong>배포는 성공</strong>입니다. 다만 아직 진짜 확인은 끝나지 않았습니다.</p>

<p style="margin:1.5rem 0"><a class="btn" href="/__eb/selftest">🔍 자가진단 실행하기</a></p>
<p class="muted">버튼을 누르면 이 프록시가 Anthropic 서버까지 제대로 연결되는지
휴대폰만으로 확인할 수 있습니다. 로그인 정보는 필요하지 않습니다.</p>

<h2 style="font-size:1.05rem">그다음</h2>
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

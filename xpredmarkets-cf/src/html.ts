export function landingPage(opts: {
  botName: string;
  botUsername: string;
  whoami: unknown;
  recent: unknown[];
}): string {
  const { botName, botUsername, whoami, recent } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(botName)} — X Bot</title>
  <style>
    :root {
      --bg: #0a0a0b;
      --card: #141416;
      --border: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #1d9bf0;
      --green: #22c55e;
      --red: #ef4444;
      --yes: #22c55e;
      --no: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1e3a5f33, transparent),
                  radial-gradient(900px 500px at 100% 0%, #3b076433, transparent),
                  var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
    }
    main { max-width: 720px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    h1 { font-size: 1.75rem; margin: 0 0 0.25rem; letter-spacing: -0.02em; }
    .sub { color: var(--muted); margin-bottom: 1.75rem; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.15rem 1.25rem;
      margin-bottom: 1rem;
    }
    .row { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
    .pill {
      display: inline-flex; align-items: center; gap: 0.4rem;
      font-size: 0.8rem; padding: 0.25rem 0.65rem;
      border-radius: 999px; border: 1px solid var(--border);
      color: var(--muted);
    }
    .pill.ok { border-color: #166534; color: var(--green); background: #052e16; }
    .pill.err { border-color: #7f1d1d; color: #fca5a5; background: #450a0a; }
    .pill.open { border-color: #14532d; color: var(--green); background: #052e16; }
    .pill.locked { border-color: #713f12; color: #fbbf24; background: #422006; }
    .pill.resolved { border-color: #1e3a5f; color: #93c5fd; background: #0c1a2e; }
    .pill.voided { border-color: #3f3f46; color: #a1a1aa; background: #18181b; }
    pre {
      margin: 0.75rem 0 0;
      padding: 0.85rem 1rem;
      background: #09090b;
      border-radius: 10px;
      border: 1px solid var(--border);
      overflow: auto;
      font-size: 0.8rem;
      color: #d4d4d8;
    }
    label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.35rem; }
    textarea, input, select {
      width: 100%;
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text);
      padding: 0.75rem 0.9rem;
      font: inherit;
      margin-bottom: 0.75rem;
    }
    textarea { min-height: 100px; resize: vertical; }
    select { cursor: pointer; }
    button {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 999px;
      padding: 0.6rem 1.25rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    button.danger {
      background: transparent;
      border: 1px solid #7f1d1d;
      color: #fca5a5;
    }
    .posts { list-style: none; padding: 0; margin: 0; }
    .posts li {
      border-top: 1px solid var(--border);
      padding: 0.85rem 0;
    }
    .posts li:first-child { border-top: none; padding-top: 0; }
    .meta { font-size: 0.8rem; color: var(--muted); }
    .msg { margin-top: 0.75rem; font-size: 0.9rem; }
    #msg { margin-top: 0.75rem; font-size: 0.9rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
    h2 { font-size: 1.05rem; margin: 0 0 0.75rem; }
    .warn {
      background: #422006;
      border: 1px solid #713f12;
      color: #fbbf24;
      border-radius: 10px;
      padding: 0.75rem 0.9rem;
      font-size: 0.85rem;
      margin: 0.5rem 0 0.75rem;
    }
    .key-box {
      background: #09090b;
      border: 1px solid #713f12;
      border-radius: 10px;
      padding: 0.75rem 0.9rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      word-break: break-all;
      color: #fbbf24;
      margin-top: 0.5rem;
      display: none;
    }
    .markets { list-style: none; padding: 0; margin: 0; }
    .markets li {
      border-top: 1px solid var(--border);
      padding: 0.9rem 0;
    }
    .markets li:first-child { border-top: none; padding-top: 0; }
    .market-q { font-weight: 600; margin-bottom: 0.35rem; }
    .market-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.5rem; }
    .prob-bar {
      display: flex;
      height: 8px;
      border-radius: 999px;
      overflow: hidden;
      background: #27272a;
      margin: 0.35rem 0;
    }
    .prob-bar .yes { background: var(--yes); height: 100%; }
    .prob-bar .no { background: var(--no); height: 100%; }
    .prob-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .prob-labels .y { color: var(--yes); }
    .prob-labels .n { color: var(--no); }
    .market-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      color: var(--muted);
      cursor: pointer;
    }
    .market-id:hover { color: var(--accent); }
    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    @media (max-width: 520px) {
      .field-row { grid-template-columns: 1fr; }
    }
    .section-note { color: var(--muted); font-size: 0.85rem; margin: -0.35rem 0 0.75rem; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(botName)}</h1>
    <p class="sub">
      Automated X poster for
      <a href="https://x.com/${escapeHtml(botUsername)}" target="_blank" rel="noopener">@${escapeHtml(botUsername)}</a>
      · play-money prediction markets
    </p>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <strong>Bot status</strong>
        <span id="status-pill" class="pill">checking…</span>
      </div>
      <pre id="whoami">${escapeHtml(JSON.stringify(whoami, null, 2))}</pre>
    </div>

    <!-- Markets list -->
    <div class="card">
      <div class="row" style="justify-content:space-between; margin-bottom:0.5rem">
        <h2 style="margin:0">Markets</h2>
        <button id="markets-refresh" class="secondary" type="button">Refresh</button>
      </div>
      <p class="section-note">Play-money credits · constant-product AMM · prices as implied P(YES)</p>
      <ul class="markets" id="markets-list">
        <li class="meta">Loading markets…</li>
      </ul>
    </div>

    <!-- Register -->
    <div class="card">
      <h2>Register</h2>
      <p class="section-note">Create a user account. You get <strong>1000 credits</strong> to trade. Your API key is shown <strong>once</strong> — save it.</p>
      <label for="reg-name">Display name</label>
      <input id="reg-name" type="text" placeholder="alice" autocomplete="off" />
      <button id="reg-btn" type="button">Create account</button>
      <div id="reg-msg" class="msg"></div>
      <div id="reg-key" class="key-box"></div>
    </div>

    <!-- Create market -->
    <div class="card">
      <h2>Create market</h2>
      <p class="section-note">Admin only. Starts open at ~50% with equal YES/NO pools.</p>
      <label for="create-token">Admin token</label>
      <input id="create-token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" />
      <label for="create-q">Question</label>
      <input id="create-q" type="text" placeholder="Will X happen by Friday?" />
      <div class="field-row">
        <div>
          <label for="create-liq">Liquidity (optional)</label>
          <input id="create-liq" type="number" min="10" step="1" placeholder="100" />
        </div>
        <div>
          <label for="create-desc">Description (optional)</label>
          <input id="create-desc" type="text" placeholder="Resolution rules…" />
        </div>
      </div>
      <button id="create-btn" type="button">Create market</button>
      <div id="create-msg" class="msg"></div>
    </div>

    <!-- Trade -->
    <div class="card">
      <h2>Trade</h2>
      <p class="section-note">Buy or sell YES/NO shares with your user API key. Key is stored in this browser only.</p>
      <label for="trade-key">User API key</label>
      <input id="trade-key" type="password" placeholder="xpm_…" autocomplete="off" />
      <label for="trade-market">Market id</label>
      <input id="trade-market" type="text" placeholder="mkt_…" autocomplete="off" />
      <div class="field-row">
        <div>
          <label for="trade-action">Action</label>
          <select id="trade-action">
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </div>
        <div>
          <label for="trade-side">Side</label>
          <select id="trade-side">
            <option value="yes">YES</option>
            <option value="no">NO</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div>
          <label for="trade-amount">Amount (credits, for buy)</label>
          <input id="trade-amount" type="number" min="0" step="0.01" placeholder="10" />
        </div>
        <div>
          <label for="trade-shares">Shares (for sell)</label>
          <input id="trade-shares" type="number" min="0" step="0.00000001" placeholder="5" />
        </div>
      </div>
      <div class="row">
        <button id="trade-btn" type="button">Submit trade</button>
        <button id="quote-btn" class="secondary" type="button">Quote only</button>
      </div>
      <div id="trade-msg" class="msg"></div>
    </div>

    <!-- Resolve -->
    <div class="card">
      <h2>Resolve</h2>
      <p class="section-note">Admin only. Pays 1 credit per winning share. Void refunds 0.5× shares held.</p>
      <label for="resolve-token">Admin token</label>
      <input id="resolve-token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" />
      <label for="resolve-market">Market id</label>
      <input id="resolve-market" type="text" placeholder="mkt_…" autocomplete="off" />
      <label for="resolve-outcome">Outcome</label>
      <select id="resolve-outcome">
        <option value="yes">YES</option>
        <option value="no">NO</option>
        <option value="void">VOID</option>
      </select>
      <button id="resolve-btn" class="danger" type="button">Resolve market</button>
      <div id="resolve-msg" class="msg"></div>
    </div>

    <!-- Compose post (existing) -->
    <div class="card">
      <h2>Compose post</h2>
      <p class="meta" style="margin-top:0">Requires admin token (set as header or below). Never share this token publicly.</p>
      <label for="token">Admin token</label>
      <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off" />
      <label for="text">Post text</label>
      <textarea id="text" maxlength="280" placeholder="What's happening?"></textarea>
      <label for="reply">Reply to tweet id (optional)</label>
      <input id="reply" type="text" placeholder="e.g. 1234567890" />
      <div class="row">
        <button id="post-btn" type="button">Post to X</button>
        <button id="refresh-btn" class="secondary" type="button">Refresh</button>
      </div>
      <div id="msg"></div>
    </div>

    <div class="card">
      <h2>Recent posts (via this API)</h2>
      <ul class="posts" id="posts">
        ${renderPosts(recent)}
      </ul>
    </div>

    <div class="card">
      <h2>API</h2>
      <pre>GET  /status                          — bot identity + counts
GET  /whoami                          — X account (OAuth)
GET  /posts?limit=20                  — posts logged in D1
POST /post                            — { "text": "..." } + Authorization: Bearer &lt;ADMIN_TOKEN&gt;
GET  /mentions?limit=10               — live mentions (admin)  &amp;persist=1 to store
GET  /mentions/cached?limit=50        — mentions from D1 cache
GET  /health                          — liveness

— Prediction markets (play-money credits) —
POST /users                           — { "display_name" } → api_key once + 1000 credits
GET  /me                              — user profile (api key)
GET  /me/positions                    — your positions (api key)
GET  /markets?status=&amp;limit=          — list markets
GET  /markets/:id                     — market detail + recent trades
GET  /markets/:id/trades?limit=       — trade history
POST /markets                         — create (admin) { question, liquidity? }
POST /markets/:id/quote               — { side, action, amount?|shares? } (api key)
POST /markets/:id/buy                 — { side: "yes"|"no", amount } (api key)
POST /markets/:id/sell                — { side: "yes"|"no", shares } (api key)
POST /markets/:id/lock                — lock trading (admin)
POST /markets/:id/resolve             — { outcome: "yes"|"no"|"void" } (admin)
POST /users/:id/credit                — { amount } top-up (admin)

Auth: Admin → Authorization: Bearer &lt;ADMIN_TOKEN&gt;
      User  → Authorization: Bearer &lt;api_key&gt;  or  X-Api-Key: &lt;api_key&gt;</pre>
    </div>
  </main>
  <script>
    const pill = document.getElementById('status-pill');
    const whoamiEl = document.getElementById('whoami');
    const postsEl = document.getElementById('posts');
    const msg = document.getElementById('msg');
    const tokenInput = document.getElementById('token');
    const createTokenInput = document.getElementById('create-token');
    const resolveTokenInput = document.getElementById('resolve-token');
    const tradeKeyInput = document.getElementById('trade-key');
    const marketsList = document.getElementById('markets-list');

    function loadToken() {
      try {
        const t = localStorage.getItem('xpred_admin_token') || '';
        tokenInput.value = t;
        createTokenInput.value = t;
        resolveTokenInput.value = t;
      } catch {}
    }
    function saveToken(from) {
      try {
        const v = (from || tokenInput).value;
        localStorage.setItem('xpred_admin_token', v);
        // keep admin token fields in sync
        tokenInput.value = v;
        createTokenInput.value = v;
        resolveTokenInput.value = v;
      } catch {}
    }
    function loadUserKey() {
      try { tradeKeyInput.value = localStorage.getItem('xpred_user_key') || ''; } catch {}
    }
    function saveUserKey(key) {
      try {
        if (key !== undefined) tradeKeyInput.value = key;
        localStorage.setItem('xpred_user_key', tradeKeyInput.value);
      } catch {}
    }
    loadToken();
    loadUserKey();

    function setMsg(el, text, kind) {
      el.textContent = text;
      el.style.color = kind === 'ok' ? 'var(--green)' : kind === 'err' ? 'var(--red)' : 'var(--muted)';
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Markets list ──────────────────────────────────────────
    function pct(p) {
      const n = Number(p);
      if (!Number.isFinite(n)) return 50;
      return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 10;
    }
    function statusPill(status) {
      const s = String(status || 'open');
      return '<span class="pill ' + escapeHtml(s) + '">' + escapeHtml(s) + '</span>';
    }
    function renderMarket(m) {
      const py = pct(m.p_yes);
      const pn = Math.round((100 - py) * 10) / 10;
      const res = m.resolution ? ' · resolved: ' + escapeHtml(m.resolution) : '';
      const vol = m.volume != null ? ' · vol ' + Number(m.volume).toFixed(1) : '';
      return '<li data-id="' + escapeHtml(m.id) + '">' +
        '<div class="market-q">' + escapeHtml(m.question || '') + '</div>' +
        '<div class="market-meta">' +
          statusPill(m.status) +
          '<span class="market-id" title="Click to use in Trade / Resolve" data-copy="' + escapeHtml(m.id) + '">' + escapeHtml(m.id) + '</span>' +
          '<span class="meta">' + vol + res + '</span>' +
        '</div>' +
        '<div class="prob-bar"><div class="yes" style="width:' + py + '%"></div><div class="no" style="width:' + pn + '%"></div></div>' +
        '<div class="prob-labels"><span class="y">YES ' + py + '%</span><span class="n">NO ' + pn + '%</span></div>' +
      '</li>';
    }
    async function loadMarkets() {
      marketsList.innerHTML = '<li class="meta">Loading markets…</li>';
      try {
        const r = await fetch('/markets?limit=50');
        const j = await r.json();
        if (!r.ok || !j.ok) {
          marketsList.innerHTML = '<li class="meta">Error: ' + escapeHtml(JSON.stringify(j.error || j)) + '</li>';
          return;
        }
        const list = j.markets || [];
        if (!list.length) {
          marketsList.innerHTML = '<li class="meta">No markets yet — create one below.</li>';
          return;
        }
        marketsList.innerHTML = list.map(renderMarket).join('');
        marketsList.querySelectorAll('.market-id').forEach(function (el) {
          el.onclick = function () {
            const id = el.getAttribute('data-copy') || el.textContent;
            document.getElementById('trade-market').value = id;
            document.getElementById('resolve-market').value = id;
          };
        });
      } catch (e) {
        marketsList.innerHTML = '<li class="meta">Failed to load markets</li>';
      }
    }
    document.getElementById('markets-refresh').onclick = loadMarkets;

    // ── Register ──────────────────────────────────────────────
    document.getElementById('reg-btn').onclick = async () => {
      const name = document.getElementById('reg-name').value.trim();
      const regMsg = document.getElementById('reg-msg');
      const regKey = document.getElementById('reg-key');
      regKey.style.display = 'none';
      if (!name) { setMsg(regMsg, 'Enter a display name', 'err'); return; }
      setMsg(regMsg, 'Creating account…', 'muted');
      try {
        const r = await fetch('/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: name }),
        });
        const j = await r.json();
        if (r.ok && j.ok && j.user) {
          const key = j.user.api_key || '';
          setMsg(regMsg, 'Account created. Balance: ' + j.user.balance + ' credits. SAVE YOUR API KEY — it is only shown once.', 'ok');
          regKey.style.display = 'block';
          regKey.innerHTML = '<div class="warn" style="margin:0 0 0.5rem">⚠ Copy this key now. It will not be shown again.</div>' +
            escapeHtml(key);
          if (key) saveUserKey(key);
        } else {
          setMsg(regMsg, 'Error: ' + JSON.stringify(j.error || j), 'err');
        }
      } catch (e) {
        setMsg(regMsg, 'Request failed', 'err');
      }
    };

    // ── Create market ─────────────────────────────────────────
    document.getElementById('create-btn').onclick = async () => {
      const createMsg = document.getElementById('create-msg');
      saveToken(createTokenInput);
      const token = createTokenInput.value.trim();
      const question = document.getElementById('create-q').value.trim();
      const liqRaw = document.getElementById('create-liq').value.trim();
      const desc = document.getElementById('create-desc').value.trim();
      if (!token) { setMsg(createMsg, 'Enter admin token', 'err'); return; }
      if (!question) { setMsg(createMsg, 'Enter a question', 'err'); return; }
      const body = { question };
      if (liqRaw) body.liquidity = Number(liqRaw);
      if (desc) body.description = desc;
      setMsg(createMsg, 'Creating…', 'muted');
      try {
        const r = await fetch('/markets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          const id = (j.market && j.market.id) || '';
          setMsg(createMsg, 'Created ' + id, 'ok');
          document.getElementById('create-q').value = '';
          if (id) {
            document.getElementById('trade-market').value = id;
            document.getElementById('resolve-market').value = id;
          }
          loadMarkets();
        } else {
          setMsg(createMsg, 'Error: ' + JSON.stringify(j.error || j), 'err');
        }
      } catch (e) {
        setMsg(createMsg, 'Request failed', 'err');
      }
    };

    // ── Trade / Quote ─────────────────────────────────────────
    async function doTrade(quoteOnly) {
      const tradeMsg = document.getElementById('trade-msg');
      saveUserKey();
      const key = tradeKeyInput.value.trim();
      const marketId = document.getElementById('trade-market').value.trim();
      const action = document.getElementById('trade-action').value;
      const side = document.getElementById('trade-side').value;
      const amount = Number(document.getElementById('trade-amount').value);
      const shares = Number(document.getElementById('trade-shares').value);
      if (!key) { setMsg(tradeMsg, 'Enter user API key', 'err'); return; }
      if (!marketId) { setMsg(tradeMsg, 'Enter market id', 'err'); return; }
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'X-Api-Key': key,
      };
      let path, body;
      if (quoteOnly) {
        path = '/markets/' + encodeURIComponent(marketId) + '/quote';
        body = { side, action };
        if (action === 'buy') body.amount = amount;
        else body.shares = shares;
      } else if (action === 'buy') {
        if (!(amount > 0)) { setMsg(tradeMsg, 'Enter amount > 0 for buy', 'err'); return; }
        path = '/markets/' + encodeURIComponent(marketId) + '/buy';
        body = { side, amount };
      } else {
        if (!(shares > 0)) { setMsg(tradeMsg, 'Enter shares > 0 for sell', 'err'); return; }
        path = '/markets/' + encodeURIComponent(marketId) + '/sell';
        body = { side, shares };
      }
      setMsg(tradeMsg, quoteOnly ? 'Quoting…' : 'Trading…', 'muted');
      try {
        const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        const j = await r.json();
        if (r.ok && j.ok) {
          setMsg(tradeMsg, JSON.stringify(j, null, 2), 'ok');
          if (!quoteOnly) loadMarkets();
        } else {
          setMsg(tradeMsg, 'Error: ' + JSON.stringify(j.error || j), 'err');
        }
      } catch (e) {
        setMsg(tradeMsg, 'Request failed', 'err');
      }
    }
    document.getElementById('trade-btn').onclick = () => doTrade(false);
    document.getElementById('quote-btn').onclick = () => doTrade(true);

    // ── Resolve ───────────────────────────────────────────────
    document.getElementById('resolve-btn').onclick = async () => {
      const resolveMsg = document.getElementById('resolve-msg');
      saveToken(resolveTokenInput);
      const token = resolveTokenInput.value.trim();
      const marketId = document.getElementById('resolve-market').value.trim();
      const outcome = document.getElementById('resolve-outcome').value;
      if (!token) { setMsg(resolveMsg, 'Enter admin token', 'err'); return; }
      if (!marketId) { setMsg(resolveMsg, 'Enter market id', 'err'); return; }
      if (!confirm('Resolve ' + marketId + ' as ' + outcome.toUpperCase() + '? This cannot be undone.')) return;
      setMsg(resolveMsg, 'Resolving…', 'muted');
      try {
        const r = await fetch('/markets/' + encodeURIComponent(marketId) + '/resolve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
          body: JSON.stringify({ outcome }),
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          setMsg(resolveMsg, 'Resolved. Payouts: ' + (j.payouts != null ? j.payouts : 'ok') + '\\n' + JSON.stringify(j, null, 2), 'ok');
          loadMarkets();
        } else {
          setMsg(resolveMsg, 'Error: ' + JSON.stringify(j.error || j), 'err');
        }
      } catch (e) {
        setMsg(resolveMsg, 'Request failed', 'err');
      }
    };

    // ── Existing bot status / posts ───────────────────────────
    async function refresh() {
      try {
        const r = await fetch('/status');
        const j = await r.json();
        if (j.ok && j.user) {
          pill.textContent = 'online @' + j.user.username;
          pill.className = 'pill ok';
          whoamiEl.textContent = JSON.stringify(j, null, 2);
        } else {
          pill.textContent = 'auth error';
          pill.className = 'pill err';
          whoamiEl.textContent = JSON.stringify(j, null, 2);
        }
        const p = await fetch('/posts?limit=20');
        const pj = await p.json();
        postsEl.innerHTML = (pj.posts || []).map(renderPostClient).join('') || '<li class="meta">No posts yet</li>';
      } catch (e) {
        pill.textContent = 'offline';
        pill.className = 'pill err';
      }
    }

    function renderPostClient(p) {
      const when = p.created_at ? new Date(p.created_at * 1000).toLocaleString() : '';
      const url = p.url || ('https://x.com/i/status/' + p.tweet_id);
      return '<li><div>' + escapeHtml(p.text) + '</div><div class="meta"><a href="' + url + '" target="_blank" rel="noopener">' + (p.tweet_id || '') + '</a> · ' + when + '</div></li>';
    }

    document.getElementById('refresh-btn').onclick = refresh;
    document.getElementById('post-btn').onclick = async () => {
      saveToken(tokenInput);
      const text = document.getElementById('text').value.trim();
      const reply = document.getElementById('reply').value.trim();
      const token = tokenInput.value.trim();
      if (!text) { msg.textContent = 'Enter post text'; msg.style.color = 'var(--red)'; return; }
      if (!token) { msg.textContent = 'Enter admin token'; msg.style.color = 'var(--red)'; return; }
      msg.textContent = 'Posting…'; msg.style.color = 'var(--muted)';
      const body = { text };
      if (reply) body.reply_to = reply;
      const r = await fetch('/post', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        msg.innerHTML = 'Posted: <a href="' + j.url + '" target="_blank" rel="noopener">' + j.url + '</a>';
        msg.style.color = 'var(--green)';
        document.getElementById('text').value = '';
        refresh();
      } else {
        msg.textContent = 'Error: ' + JSON.stringify(j.error || j);
        msg.style.color = 'var(--red)';
      }
    };

    // set pill from SSR whoami
    try {
      const w = ${JSON.stringify(whoami)};
      if (w && w.user) {
        pill.textContent = 'online @' + w.user.username;
        pill.className = 'pill ok';
      } else if (w && w.error) {
        pill.textContent = 'auth error';
        pill.className = 'pill err';
      }
    } catch {}

    // load markets on page open
    loadMarkets();
  </script>
</body>
</html>`;
}

function renderPosts(recent: unknown[]): string {
  if (!recent?.length) return `<li class="meta">No posts yet</li>`;
  return recent
    .map((raw) => {
      const p = raw as {
        text?: string;
        tweet_id?: string;
        url?: string;
        created_at?: number;
      };
      const when = p.created_at
        ? new Date(p.created_at * 1000).toLocaleString()
        : "";
      const url = p.url || `https://x.com/i/status/${p.tweet_id}`;
      return `<li>
        <div>${escapeHtml(p.text || "")}</div>
        <div class="meta"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(String(p.tweet_id || ""))}</a> · ${escapeHtml(when)}</div>
      </li>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

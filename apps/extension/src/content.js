import { DEFAULT_MARKET_ORIGIN } from "./config.js";

const HOST_ATTRIBUTE = "data-signal-market-card";
const EMBED_VERSION_ATTRIBUTE = "data-xmarket-embed-version";
const EMBED_VERSION = "0.3.4";
let processedAnchors = new WeakSet();
let processedArticleText = new WeakMap();
let scanScheduled = false;
let configuredOrigin = DEFAULT_MARKET_ORIGIN;

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const ISOLATED_INTERACTION_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
];

function isolateCardInteractions(host) {
  for (const eventName of ISOLATED_INTERACTION_EVENTS) {
    host.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function pageUsesDarkTheme() {
  const candidates = [document.body, document.querySelector("#react-root"), document.documentElement];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = getComputedStyle(candidate).backgroundColor.match(/[\d.]+/g)?.map(Number);
    if (!match || match.length < 3 || (match.length > 3 && match[3] === 0)) continue;
    const luminance = (match[0] * 299 + match[1] * 587 + match[2] * 114) / 1000;
    return luminance < 128;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncCardTheme(host) {
  host.dataset.theme = pageUsesDarkTheme() ? "dark" : "light";
}

function removeStaleEmbeds() {
  document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).forEach((host) => {
    if (host.getAttribute(EMBED_VERSION_ATTRIBUTE) !== EMBED_VERSION) host.remove();
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function marketIdFromCandidate(candidate) {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, window.location.href);
    const configured = new URL(configuredOrigin);
    if (url.origin !== configured.origin) return null;
    const match = url.pathname.match(/^\/market\/([A-Za-z0-9_-]{3,100})\/?$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function findMarketId(anchor) {
  const candidates = [
    anchor.href,
    anchor.getAttribute("data-expanded-url"),
    anchor.getAttribute("title"),
    anchor.getAttribute("aria-label"),
    anchor.textContent?.trim(),
  ];
  for (const candidate of candidates) {
    const id = marketIdFromCandidate(candidate);
    if (id) return id;
  }
  return null;
}

function marketIdsFromText(text) {
  if (!text) return [];
  const escapedOrigin = configuredOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedOrigin}/market/([A-Za-z0-9_-]{3,100})`, "g");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function cardStyles() {
  return `
    :host { color-scheme: light; display:block; width:100%; margin:12px 0 4px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; --card-pad:20px; --surface:#fff; --surface-2:#f7f9f9; --ink:#0f1419; --muted:#536471; --line:#cfd9de; --soft-line:#eff3f4; --inverse:#fff; --positive:#00ba7c; --negative:#f4212e; }
    :host([data-theme="dark"]) { color-scheme:dark; --surface:#000; --surface-2:#080808; --ink:#e7e9ea; --muted:#71767b; --line:#2f3336; --soft-line:#16181c; --inverse:#0f1419; --positive:#00ba7c; --negative:#f4212e; }
    * { box-sizing: border-box; }
    .card { width:100%; background:var(--surface); color:var(--ink); border:1px solid var(--line); border-radius:16px; overflow:hidden; }
    .loading { min-height:118px; display:flex; align-items:center; gap:12px; padding:20px; color:var(--muted); font-size:13px; font-weight:500; }
    .spinner { width:17px; height:17px; border:2px solid var(--line); border-top-color:var(--ink); border-radius:50%; animation:spin .8s linear infinite; }
    .top { padding:var(--card-pad); }
    h3 { max-width:100%; font-size:19px; line-height:1.22; letter-spacing:-.45px; font-weight:800; margin:0; overflow-wrap:anywhere; }
    .market-line { display:grid; grid-template-columns:105px 1fr; align-items:end; gap:18px; margin-top:18px; }
    .chance strong { display:block; font-size:39px; line-height:.9; letter-spacing:-2.4px; font-weight:900; }.chance span { display:block; margin-top:7px; color:var(--muted); font-size:8px; font-weight:800; text-transform:uppercase; letter-spacing:.8px; }
    .bar { height:4px; background:var(--soft-line); overflow:hidden; }.bar span { display:block; height:100%; background:var(--ink); }.market-stats { display:flex; gap:15px; color:var(--muted); font-size:9px; font-weight:600; margin-top:9px; }
    .trade { border-top:1px solid var(--line); padding:18px var(--card-pad) 20px; background:var(--surface-2); }
    .order-type { display:grid; grid-template-columns:1fr 1fr; gap:3px; padding:3px; margin-bottom:7px; border-radius:999px; background:var(--soft-line); }.order-type button { height:27px; border:0; border-radius:999px; background:transparent; color:var(--muted); font-size:9px; font-weight:800; }.order-type button.selected { background:var(--surface); color:var(--ink); box-shadow:0 1px 3px rgba(15,20,25,.14); }
    .side-row, .amount-row { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    button { font:inherit; cursor:pointer; }.side { min-height:39px; border:1px solid var(--line); border-radius:8px; padding:0 12px; display:flex; justify-content:space-between; align-items:center; background:var(--surface); color:var(--ink); font-size:10px; font-weight:900; letter-spacing:.5px; }.side strong { font-size:12px; }.side.selected { background:var(--ink); color:var(--inverse); border-color:var(--ink); }.side.selected.yes strong { color:var(--positive); }.side.selected.no strong { color:var(--negative); }
    .amount-row { grid-template-columns:repeat(5,1fr); margin-top:6px; }.amount { border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:7px; height:31px; font-size:9px; font-weight:800; }.amount:hover { color:var(--ink); border-color:var(--ink); }.amount.selected { background:var(--ink); color:var(--inverse); border-color:var(--ink); }.custom { padding:0 5px; }
    .summary { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; min-width:0; }.estimate { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.4px; }.estimate strong { color:var(--ink); }.actions { display:flex; gap:6px; align-items:center; flex:none; }.open { text-decoration:none; border:1px solid var(--line); background:var(--surface); color:var(--ink); border-radius:999px; padding:8px 11px; font-size:9px; font-weight:800; }.open:hover { border-color:var(--ink); }.preview { border:1px solid var(--line); border-radius:999px; padding:8px 12px; background:var(--soft-line); color:var(--muted); font-size:9px; font-weight:900; cursor:not-allowed; }.preview.sign-in,.preview.trade { border-color:var(--ink); background:var(--ink); color:var(--inverse); cursor:pointer; }.preview.sign-in:disabled,.preview.trade:disabled { opacity:.6; cursor:wait; }
    .account-line { color:var(--muted); font-size:8px; font-weight:600; margin-top:10px; }.account-line.connected { color:var(--positive); }
    .dev { padding:6px 16px; border-top:1px solid var(--line); color:var(--muted); font-size:7px; font-weight:800; text-transform:uppercase; letter-spacing:1px; background:var(--surface); }
    .error { padding:18px; }.error strong { display:block; font-size:13px; }.error p { color:var(--muted); font-size:11px; margin:5px 0 12px; }.error a { color:var(--ink); font-size:10px; font-weight:900; }
    @media (max-width:430px) { :host { --card-pad:14px; }.market-line { grid-template-columns:92px 1fr; gap:12px; }.chance strong { font-size:34px; }.summary { align-items:flex-end; }.actions { gap:4px; }.open,.preview { padding:8px 9px; } }
    @keyframes spin { to { transform:rotate(360deg); } }
  `;
}

function renderError(shadow, marketId, message) {
  shadow.innerHTML = `<style>${cardStyles()}</style><div class="card error"><strong>Market unavailable</strong><p>${escapeHtml(message)}</p><a href="${escapeHtml(configuredOrigin)}/market/${encodeURIComponent(marketId)}" target="_blank" rel="noopener">Open market ↗</a></div>`;
}

function renderMarket(shadow, market, marketOrigin, source, authState, positions = []) {
  let selectedMode = "buy";
  let selectedSide = "YES";
  let selectedAmount = 10;
  const owned = {
    YES: Number(positions.find((position) => position.outcome === "YES")?.shares || 0),
    NO: Number(positions.find((position) => position.outcome === "NO")?.shares || 0),
  };
  let yesPrice = Math.max(0.01, Math.min(0.99, Number(market.yesPrice)));
  const liquidity = Number(market.liquidityParameter);
  const marketUrl = `${marketOrigin}/market/${encodeURIComponent(market.id)}`;
  const user = authState?.user;
  const isOpen = market.status === "open" && new Date(market.closesAt) > new Date();
  const estimateShares = () => {
    const price = selectedSide === "YES" ? yesPrice : 1 - yesPrice;
    if (!liquidity || !price) return 0;
    return liquidity * Math.log((Math.exp(selectedAmount / liquidity) - (1 - price)) / price);
  };
  const estimateSaleProceeds = () => {
    const price = selectedSide === "YES" ? yesPrice : 1 - yesPrice;
    if (!liquidity || !price || selectedAmount <= 0) return 0;
    return -liquidity * Math.log((1 - price) + price * Math.exp(-selectedAmount / liquidity));
  };
  const accountLabel = user
    ? `Trading as ${user.xHandle ? `@${user.xHandle.replace(/^@/, "")}` : user.displayName}${authState.balance == null ? "" : ` · ${Number(authState.balance).toFixed(2)} credits`}`
    : authState?.configured
      ? "Connect your xmarket account to trade"
      : "Open the extension popup to connect Supabase";

  shadow.innerHTML = `
    <style>${cardStyles()}</style>
    <section class="card" aria-label="xmarket prediction market">
      <div class="top">
        <h3>${escapeHtml(market.question)}</h3>
        <div class="market-line">
          <div class="chance"><strong data-chance>${Math.round(yesPrice * 100)}%</strong><span>chance of yes</span></div>
          <div><div class="bar"><span data-probability-bar style="width:${yesPrice * 100}%"></span></div><div class="market-stats"><span data-volume>$${compactNumber.format(market.volume)} volume</span><span>${compactNumber.format(market.traderCount)} traders</span></div></div>
        </div>
      </div>
      <div class="trade">
        <div class="order-type"><button class="selected" data-mode="buy">Buy</button><button data-mode="sell">Sell</button></div>
        <div class="side-row">
          <button class="side yes selected" data-side="YES"><span>YES</span><strong data-yes-price>${Math.round(yesPrice * 100)}¢</strong></button>
          <button class="side no" data-side="NO"><span>NO</span><strong data-no-price>${Math.round((1 - yesPrice) * 100)}¢</strong></button>
        </div>
        <div class="amount-row">
          ${[1, 5, 10, 25].map((amount) => `<button class="amount ${amount === 10 ? "selected" : ""}" data-amount="${amount}"><span data-amount-label>$${amount}</span></button>`).join("")}
          <button class="amount custom" data-amount="50" data-all="true"><span data-amount-label>$50</span></button>
        </div>
        <div class="summary"><span class="estimate">Est. <strong data-shares>${estimateShares().toFixed(2)} shares</strong></span><div class="actions"><a class="open" href="${escapeHtml(marketUrl)}" target="_blank" rel="noopener">Details ↗</a><button class="preview ${user && isOpen ? "trade" : !user && authState?.configured ? "sign-in" : ""}" ${user && isOpen || !user && authState?.configured ? "" : "disabled"}>${!isOpen ? "Market closed" : user ? `Buy ${selectedSide} · $${selectedAmount}` : authState?.configured ? "Connect xmarket" : "Setup required"}</button></div></div>
        <div class="account-line ${user ? "connected" : ""}"><span data-account-label>${escapeHtml(accountLabel)}</span></div>
      </div>
    </section>`;

  const updateSummary = () => {
    shadow.querySelector("[data-shares]").textContent = selectedMode === "buy"
      ? `${estimateShares().toFixed(2)} shares`
      : `$${estimateSaleProceeds().toFixed(2)} proceeds · ${owned[selectedSide].toFixed(2)} owned`;
    shadow.querySelectorAll("[data-amount-label]").forEach((label) => {
      const amountButton = label.closest("button");
      label.textContent = selectedMode === "buy" ? `$${amountButton.dataset.amount}` : amountButton.dataset.all ? "All" : amountButton.dataset.amount;
    });
    const actionButton = shadow.querySelector(".preview.trade");
    if (actionButton) {
      const cannotSell = selectedMode === "sell" && (selectedAmount < 0.01 || selectedAmount > owned[selectedSide]);
      actionButton.disabled = !isOpen || cannotSell;
      const sellingAll = selectedMode === "sell" && owned[selectedSide] > 0 && Math.abs(selectedAmount - owned[selectedSide]) < 0.000001;
      actionButton.textContent = selectedMode === "buy" ? `Buy ${selectedSide} · $${selectedAmount}` : `${sellingAll ? "Sell all" : "Sell"} ${selectedSide} · ${selectedAmount.toFixed(2)}`;
    }
  };

  shadow.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMode = button.dataset.mode;
      selectedAmount = selectedMode === "buy" ? 10 : owned[selectedSide];
      shadow.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("selected", item === button));
      shadow.querySelectorAll("[data-amount]").forEach((item) => item.classList.toggle("selected", selectedMode === "sell" ? Boolean(item.dataset.all) : Number(item.dataset.amount) === selectedAmount));
      updateSummary();
    });
  });

  shadow.querySelectorAll("[data-side]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSide = button.dataset.side;
      if (selectedMode === "sell") selectedAmount = owned[selectedSide];
      shadow.querySelectorAll("[data-side]").forEach((item) => item.classList.toggle("selected", item === button));
      shadow.querySelectorAll("[data-amount]").forEach((item) => item.classList.toggle("selected", selectedMode === "sell" ? Boolean(item.dataset.all) : Number(item.dataset.amount) === selectedAmount));
      updateSummary();
    });
  });
  shadow.querySelectorAll("[data-amount]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedAmount = selectedMode === "sell" && button.dataset.all ? owned[selectedSide] : Number(button.dataset.amount);
      shadow.querySelectorAll("[data-amount]").forEach((item) => item.classList.toggle("selected", item === button));
      updateSummary();
    });
  });

  const authButton = shadow.querySelector(".preview.sign-in");
  authButton?.addEventListener("click", () => {
    authButton.disabled = true;
    authButton.textContent = "Opening xmarket…";
    chrome.runtime.sendMessage({ type: "SIGNAL_CONNECT_WEBSITE" }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Sign-in failed.");
      return Promise.all([
        chrome.runtime.sendMessage({ type: "SIGNAL_GET_AUTH" }),
        chrome.runtime.sendMessage({ type: "SIGNAL_GET_MARKET_POSITIONS", marketSlug: market.id }),
      ]);
    }).then(([authResponse, positionsResponse]) => {
      renderMarket(
        shadow,
        market,
        marketOrigin,
        source,
        authResponse?.ok ? authResponse : { configured: true, user: null },
        positionsResponse?.ok ? positionsResponse.positions : [],
      );
    }).catch((error) => {
      authButton.disabled = false;
      authButton.textContent = "Try sign-in again";
      shadow.querySelector("[data-account-label]").textContent = error.message;
    });
  });

  const tradeButton = shadow.querySelector(".preview.trade");
  tradeButton?.addEventListener("click", async () => {
    const orderMode = selectedMode;
    const orderSide = selectedSide;
    const orderAmount = selectedAmount;
    tradeButton.disabled = true;
    tradeButton.textContent = "Executing…";
    try {
      const response = await chrome.runtime.sendMessage({
        type: orderMode === "buy" ? "SIGNAL_BUY_POSITION" : "SIGNAL_SELL_POSITION",
        marketSlug: market.id,
        outcome: orderSide,
        ...(orderMode === "buy" ? { amount: orderAmount } : { shares: orderAmount }),
        clientOrderId: crypto.randomUUID(),
      });
      if (!response?.ok) throw new Error(response?.error || "Trade failed.");
      const result = response.result;
      const newYesPrice = Number(result.market.yes_price);
      yesPrice = Math.max(0.01, Math.min(0.99, newYesPrice));
      owned[orderSide] = Number(result.position_shares || 0);
      if (orderMode === "sell" && owned[orderSide] === 0 && selectedSide === orderSide) selectedAmount = 0;
      shadow.querySelector("[data-chance]").textContent = `${Math.round(newYesPrice * 100)}%`;
      shadow.querySelector("[data-probability-bar]").style.width = `${newYesPrice * 100}%`;
      shadow.querySelector("[data-yes-price]").textContent = `${Math.round(newYesPrice * 100)}¢`;
      shadow.querySelector("[data-no-price]").textContent = `${Math.round((1 - newYesPrice) * 100)}¢`;
      shadow.querySelector("[data-volume]").textContent = `$${compactNumber.format(Number(result.market.volume))} volume`;
      shadow.querySelector("[data-account-label]").textContent = orderMode === "buy"
        ? `Bought ${Number(result.shares_bought).toFixed(2)} ${orderSide} shares · ${Number(result.balance).toFixed(2)} credits left`
        : `Sold ${Number(result.shares_sold).toFixed(2)} ${orderSide} shares for ${Number(result.proceeds).toFixed(2)} credits`;
      updateSummary();
    } catch (error) {
      tradeButton.textContent = "Try order again";
      shadow.querySelector("[data-account-label]").textContent = error.message;
    } finally {
      tradeButton.disabled = selectedMode === "sell" && (selectedAmount < 0.01 || selectedAmount > owned[selectedSide]);
    }
  });
}

async function injectCard(anchor, marketId) {
  const article = anchor.closest("article") || anchor.closest('[data-testid="tweet"]') || anchor.parentElement;
  if (!article || article.querySelector(`[${HOST_ATTRIBUTE}="${CSS.escape(marketId)}"]`)) return;

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, marketId);
  host.setAttribute(EMBED_VERSION_ATTRIBUTE, EMBED_VERSION);
  syncCardTheme(host);
  isolateCardInteractions(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${cardStyles()}</style><div class="card loading"><span class="spinner"></span>Loading market…</div>`;
  const tweetText = anchor.closest?.('[data-testid="tweetText"]') || article.querySelector('[data-testid="tweetText"]');
  if (tweetText) tweetText.insertAdjacentElement("afterend", host);
  else article.append(host);

  try {
    const [response, authResponse, positionsResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: "SIGNAL_GET_MARKET", marketId }),
      chrome.runtime.sendMessage({ type: "SIGNAL_GET_AUTH" }),
      chrome.runtime.sendMessage({ type: "SIGNAL_GET_MARKET_POSITIONS", marketSlug: marketId }),
    ]);
    if (!response?.ok) throw new Error(response?.error || "Could not load this market.");
    renderMarket(
      shadow,
      response.market,
      response.marketOrigin,
      response.source,
      authResponse?.ok ? authResponse : { configured: false, user: null },
      positionsResponse?.ok ? positionsResponse.positions : [],
    );
  } catch (error) {
    renderError(shadow, marketId, error.message);
  }
}

function scanForMarkets(root = document) {
  document.querySelectorAll(`[${HOST_ATTRIBUTE}]`).forEach(syncCardTheme);
  root.querySelectorAll?.("a[href]").forEach((anchor) => {
    if (processedAnchors.has(anchor)) return;
    processedAnchors.add(anchor);
    const marketId = findMarketId(anchor);
    if (marketId) injectCard(anchor, marketId);
  });

  root.querySelectorAll?.("article").forEach((article) => {
    const tweetText = article.querySelector('[data-testid="tweetText"]')?.textContent || article.textContent || "";
    if (processedArticleText.get(article) === tweetText) return;
    processedArticleText.set(article, tweetText);
    marketIdsFromText(tweetText).forEach((marketId) => injectCard(article, marketId));
  });
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanForMarkets();
  });
}

async function start() {
  removeStaleEmbeds();
  try {
    const response = await chrome.runtime.sendMessage({ type: "SIGNAL_GET_SETTINGS" });
    if (response?.marketOrigin) configuredOrigin = response.marketOrigin;
  } catch {
    // Keep using the bundled production origin if the worker is still starting.
  }
  scanForMarkets();
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.marketOrigin?.newValue) {
      configuredOrigin = changes.marketOrigin.newValue.replace(/\/$/, "");
      processedAnchors = new WeakSet();
      processedArticleText = new WeakMap();
      scheduleScan();
    }
  });
}

start();

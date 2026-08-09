import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  Clock3,
  Flame,
  LoaderCircle,
  Menu,
  LogOut,
  Moon,
  Search,
  Sun,
  Wallet,
  X,
} from "lucide-react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AuthModal } from "./auth/AuthModal";
import {
  buyPosition,
  estimateLmsrSaleProceeds,
  estimateLmsrShares,
  getMarket,
  getMarketPositions,
  getPositions,
  getProfile,
  getRelatedTweets,
  getRelatedTweetsForMarkets,
  getTrades,
  getUserTrades,
  listMarkets,
  sellPosition,
  subscribeToMarket,
} from "./lib/marketApi";
import { supabase } from "./lib/supabase";
import "./styles.css";

const money = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);

const compact = (value) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);

function Sparkline({ values, trend = "flat", large = false }) {
  const width = large ? 720 : 240;
  const height = large ? 210 : 64;
  const min = Math.min(...values) - 4;
  const max = Math.max(...values) + 4;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / (max - min)) * height;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className={`sparkline ${large ? "sparkline-large" : ""}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {large && <line x1="0" y1={height - 1} x2={width} y2={height - 1} className="chart-base" />}
      <polyline points={points} className={`line-${trend}`} />
    </svg>
  );
}

function Logo({ onClick }) {
  return (
    <button className="logo" onClick={onClick} aria-label="xmarket home">
      <span className="logo-mark" aria-hidden="true">𝕏</span>
      <span className="logo-word">market</span>
    </button>
  );
}

function Header({ page, navigate, openAuth, balance, theme, toggleTheme }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const { loading, session, signOut, user } = useAuth();
  const metadata = user?.user_metadata ?? {};
  const displayName = metadata.full_name || metadata.name || metadata.user_name || user?.email || "Trader";
  const initials = displayName.split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Logo onClick={() => navigate("/")} />
        <nav className="desktop-nav" aria-label="Primary navigation">
          <button className={page === "home" ? "active" : ""} onClick={() => navigate("/")}><BarChart3 size={19} /> Markets</button>
          <button className={page === "portfolio" ? "active" : ""} onClick={() => navigate("/portfolio")}><Wallet size={19} /> Portfolio</button>
        </nav>
        <div className="header-actions">
          <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          {session ? (
            <>
              <button className="balance-pill" onClick={() => navigate("/portfolio")}>
                <Wallet size={16} /> <span>{balance == null ? "—" : money(balance)}</span>
              </button>
              <div className="account-control">
                <button className="avatar" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-label="Account menu">
                  {metadata.avatar_url ? <img src={metadata.avatar_url} alt="" /> : initials}
                </button>
                {accountOpen && (
                  <div className="account-menu">
                    <div><strong>{displayName}</strong><span>{user.email || "Signed in with X"}</span></div>
                    <button onClick={() => { navigate("/portfolio"); setAccountOpen(false); }}><Wallet size={15} /> Portfolio</button>
                    <button onClick={async () => { await signOut(); setAccountOpen(false); navigate("/"); }}><LogOut size={15} /> Sign out</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button className="sign-in-button" onClick={openAuth} disabled={loading}>{loading ? "Loading" : "Sign in"}</button>
          )}
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Open menu">
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav className="mobile-nav">
          <button onClick={() => { navigate("/"); setMenuOpen(false); }}>Markets</button>
          <button onClick={() => { navigate("/portfolio"); setMenuOpen(false); }}>Portfolio</button>
        </nav>
      )}
    </header>
  );
}

function formatTweetTime(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

function TweetAvatar({ tweet }) {
  const label = (tweet.authorName || tweet.authorUsername || "?").slice(0, 1).toUpperCase();
  if (tweet.authorAvatarUrl) {
    return <img className="tweet-avatar" src={tweet.authorAvatarUrl.replace("_normal", "_bigger")} alt="" loading="lazy" />;
  }
  return <span className="tweet-avatar tweet-avatar-fallback" aria-hidden="true">{label}</span>;
}

function RelatedTweetCard({ tweet, dense = false }) {
  const handle = tweet.authorUsername ? `@${tweet.authorUsername}` : "on X";
  const name = tweet.authorName || tweet.authorUsername || "X user";
  return (
    <a
      className={`related-tweet ${dense ? "related-tweet-compact" : ""} ${tweet.isSource ? "is-source" : ""}`}
      href={tweet.tweetUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
    >
      <TweetAvatar tweet={tweet} />
      <div className="related-tweet-body">
        <div className="related-tweet-meta">
          <strong>{name}</strong>
          <span>{handle}</span>
          {tweet.tweetCreatedAt && <span>· {formatTweetTime(tweet.tweetCreatedAt)}</span>}
          {tweet.isSource && <em className="source-pill">Source</em>}
        </div>
        <p>{tweet.text}</p>
        {!dense && (
          <div className="related-tweet-stats">
            <span>{compact(tweet.replyCount)} replies</span>
            <span>{compact(tweet.repostCount)} reposts</span>
            <span>{compact(tweet.likeCount)} likes</span>
          </div>
        )}
      </div>
    </a>
  );
}

function RelatedTweetsSection({ tweets, loading, error }) {
  if (loading) {
    return (
      <section className="related-tweets-section" aria-busy="true">
        <div className="related-tweets-head">
          <span className="section-kicker">From the conversation</span>
          <h2>Most relevant posts</h2>
        </div>
        <div className="related-tweets-loading"><LoaderCircle className="spin" size={18} /> Finding posts on X…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="related-tweets-section">
        <div className="related-tweets-head">
          <span className="section-kicker">From the conversation</span>
          <h2>Most relevant posts</h2>
        </div>
        <p className="related-tweets-empty">{error}</p>
      </section>
    );
  }
  if (!tweets?.length) {
    return (
      <section className="related-tweets-section">
        <div className="related-tweets-head">
          <span className="section-kicker">From the conversation</span>
          <h2>Most relevant posts</h2>
        </div>
        <p className="related-tweets-empty">Related posts will appear here once X search tags this market.</p>
      </section>
    );
  }
  return (
    <section className="related-tweets-section" aria-label="Related posts from X">
      <div className="related-tweets-head">
        <span className="section-kicker">From the conversation</span>
        <h2>Most relevant posts</h2>
        <p>Live signal from X — ranked by relevance and engagement.</p>
      </div>
      <div className="related-tweets-list">
        {tweets.map((tweet) => <RelatedTweetCard key={tweet.tweetId || tweet.id} tweet={tweet} />)}
      </div>
    </section>
  );
}

function MarketCard({ market, onOpen, featured = false, relatedTweets = [] }) {
  return (
    <article className={`market-card accent-${market.accent} ${featured ? "featured-card" : ""}`} onClick={() => onOpen(market.id)}>
      <div className="card-topline">
        <span className="category">{market.category}</span>
        <span className="card-change"><span className={market.status === "open" ? "up" : "down"}>{market.status}</span></span>
      </div>
      <h3>{market.question}</h3>
      <div className="card-chart-row">
        <div className="probability">
          <strong>{Math.round(market.yesPrice * 100)}%</strong>
          <span>chance</span>
        </div>
        <Sparkline values={market.spark} trend={market.trend} />
      </div>
      {relatedTweets.length > 0 && (
        <div className="card-related-tweets" aria-label="Related posts">
          {relatedTweets.slice(0, 2).map((tweet) => (
            <RelatedTweetCard key={tweet.tweetId || tweet.id} tweet={tweet} dense />
          ))}
        </div>
      )}
      <div className="card-footer">
        <span>{money(market.volume)} volume</span>
        <span>{compact(market.traders)} traders</span>
        <button aria-label={`Open ${market.question}`}><ArrowRight size={17} /></button>
      </div>
    </article>
  );
}

function Home({ markets, loading, error, openMarket, retry }) {
  const [tab, setTab] = useState("Trending");
  const [query, setQuery] = useState("");
  const [tweetsByMarket, setTweetsByMarket] = useState(() => new Map());
  const filtered = useMemo(() => {
    const items = [...markets];
    if (tab === "Recent") items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (tab === "Closing soon") items.sort((a, b) => new Date(a.closesAtIso) - new Date(b.closesAtIso));
    return items.filter((market) => `${market.question} ${market.category}`.toLowerCase().includes(query.toLowerCase()));
  }, [markets, tab, query]);

  useEffect(() => {
    if (!markets.length) {
      setTweetsByMarket(new Map());
      return undefined;
    }
    let active = true;
    getRelatedTweetsForMarkets(markets.map((market) => market.dbId), 2)
      .then((map) => { if (active) setTweetsByMarket(map); })
      .catch((err) => console.error("Could not load related tweets", err));
    return () => { active = false; };
  }, [markets]);

  return (
    <main>
      <section className="hero">
        <h1>Put your conviction<br />where the conversation is.</h1>
        <p>Trade on the questions shaping your timeline. Clear outcomes, real-time odds, and a point of view that counts.</p>
        <div className="hero-search">
          <Search size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search markets, topics, or people" aria-label="Search markets" />
          <kbd>/</kbd>
        </div>
      </section>

      <section className="ticker-strip" aria-label="Market highlights">
        {markets.slice(0, 4).map((market) => (
          <button key={market.id} onClick={() => openMarket(market.id)}>
            <span>{market.category}</span>
            <strong>{Math.round(market.yesPrice * 100)}%</strong>
            <small className={market.status === "open" ? "up" : "down"}>{market.status}</small>
          </button>
        ))}
      </section>

      <section className="markets-section page-shell">
        <div className="section-heading">
          <div>
            <span className="section-kicker"><Flame size={15} /> Live markets</span>
            <h2>What people are betting on</h2>
          </div>
          <div className="tabs" role="tablist">
            {["Trending", "Recent", "Closing soon"].map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="empty-state"><LoaderCircle className="spin" size={28} /><h3>Loading markets</h3><p>Fetching live prices from Supabase.</p></div>
        ) : error ? (
          <div className="empty-state error-state"><X size={28} /><h3>Markets unavailable</h3><p>{error}</p><button onClick={retry}>Try again</button></div>
        ) : filtered.length ? (
          <div className="market-grid">
            {filtered.map((market, index) => (
              <MarketCard
                key={market.id}
                market={market}
                onOpen={openMarket}
                featured={index === 0 && !query}
                relatedTweets={tweetsByMarket.get(market.dbId) || []}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state"><Search size={28} /><h3>No markets found</h3><p>Try another topic or phrase.</p></div>
        )}
      </section>
      <section className="conversation-banner page-shell">
        <div>
          <span className="section-kicker">From takes to stakes</span>
          <h2>Every strong opinion deserves a market.</h2>
        </div>
        <div className="x-prompt"><span className="x-glyph">𝕏</span><p><b>@XPredMarkets</b><br />Will this actually happen?</p></div>
      </section>
    </main>
  );
}

function TradePanel({ market, balance, openAuth, onTradeComplete }) {
  const [mode, setMode] = useState("buy");
  const [side, setSide] = useState("YES");
  const [amount, setAmount] = useState(10);
  const [positions, setPositions] = useState([]);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeError, setTradeError] = useState("");
  const [tradeResult, setTradeResult] = useState("");
  const { session } = useAuth();
  const price = side === "YES" ? market.yesPrice : 1 - market.yesPrice;
  const numericAmount = Number(amount);
  const ownedShares = Number(positions.find((position) => position.outcome === side)?.shares || 0);
  const estimatedShares = mode === "buy" ? estimateLmsrShares(market, side, numericAmount) : numericAmount;
  const estimatedProceeds = mode === "sell" ? estimateLmsrSaleProceeds(market, side, numericAmount) : 0;
  const executionPrice = mode === "buy"
    ? estimatedShares > 0 ? numericAmount / estimatedShares : 0
    : numericAmount > 0 ? estimatedProceeds / numericAmount : 0;
  const isOpen = market.status === "open" && new Date(market.closesAtIso) > new Date();

  useEffect(() => {
    if (!session) {
      setPositions([]);
      return undefined;
    }
    let active = true;
    getMarketPositions(market.dbId)
      .then((nextPositions) => { if (active) setPositions(nextPositions); })
      .catch((error) => console.error("Could not load market positions", error));
    return () => { active = false; };
  }, [market.dbId, session]);

  const chooseMode = (nextMode) => {
    setMode(nextMode);
    setTradeError("");
    setTradeResult("");
    if (nextMode === "buy") setAmount(10);
    else setAmount(ownedShares || 0);
  };

  const chooseSide = (nextSide) => {
    setSide(nextSide);
    setTradeError("");
    if (mode === "sell") {
      const nextOwned = Number(positions.find((position) => position.outcome === nextSide)?.shares || 0);
      setAmount(nextOwned || 0);
    }
  };

  const executeTrade = async () => {
    if (!session) {
      openAuth();
      return;
    }

    if (!isOpen) {
      setTradeError("This market is closed for trading.");
      return;
    }
    const minimum = mode === "buy" ? 1 : 0.01;
    if (!Number.isFinite(numericAmount) || numericAmount < minimum || numericAmount > (mode === "buy" ? 10000 : 1000000)) {
      setTradeError(mode === "buy" ? "Choose an amount between 1 and 10,000 credits." : "Choose at least 0.01 shares to sell.");
      return;
    }
    if (mode === "buy" && balance != null && numericAmount > balance) {
      setTradeError("Your credit balance is too low for this order.");
      return;
    }
    if (mode === "sell" && numericAmount > ownedShares + 0.000001) {
      setTradeError(`You only own ${ownedShares.toFixed(2)} ${side} shares.`);
      return;
    }

    setTradeLoading(true);
    setTradeError("");
    setTradeResult("");
    try {
      const result = mode === "buy"
        ? await buyPosition({ marketSlug: market.id, outcome: side, amount: numericAmount, clientOrderId: crypto.randomUUID() })
        : await sellPosition({ marketSlug: market.id, outcome: side, shares: numericAmount, clientOrderId: crypto.randomUUID() });
      setPositions((current) => {
        const remaining = Number(result.position_shares || 0);
        const withoutSide = current.filter((position) => position.outcome !== side);
        return remaining > 0 ? [...withoutSide, { outcome: side, shares: remaining }] : withoutSide;
      });
      setTradeResult(mode === "buy"
        ? `Bought ${Number(result.shares_bought).toFixed(2)} ${side} shares at an average of ${Math.round(Number(result.execution_price) * 100)}¢.`
        : `Sold ${Number(result.shares_sold).toFixed(2)} ${side} shares for ${money(Number(result.proceeds))}.`);
      await onTradeComplete?.(result);
    } catch (error) {
      console.error("Trade failed", error);
      setTradeError(error.message || "The trade could not be completed.");
    } finally {
      setTradeLoading(false);
    }
  };

  return (
    <aside className="trade-panel">
      <div className="trade-heading"><span>Build a position</span><small>Credit balance</small></div>
      <div className="trade-mode" aria-label="Order type">
        <button className={mode === "buy" ? "active" : ""} onClick={() => chooseMode("buy")}>Buy</button>
        <button className={mode === "sell" ? "active" : ""} onClick={() => chooseMode("sell")}>Sell</button>
      </div>
      <div className="side-toggle">
        <button className={side === "YES" ? "selected yes" : ""} onClick={() => chooseSide("YES")}><span>YES</span><strong>{Math.round(market.yesPrice * 100)}¢</strong></button>
        <button className={side === "NO" ? "selected no" : ""} onClick={() => chooseSide("NO")}><span>NO</span><strong>{Math.round((1 - market.yesPrice) * 100)}¢</strong></button>
      </div>
      <label className="amount-label">{mode === "buy" ? "Amount" : "Shares to sell"} <span>{mode === "buy" ? `Balance ${session ? balance == null ? "—" : money(balance) : "Sign in"}` : `Owned ${ownedShares.toFixed(2)}`}</span></label>
      <div className="amount-input">{mode === "buy" && <span>$</span>}<input type="number" min={mode === "buy" ? "1" : "0.01"} step={mode === "buy" ? "1" : "0.01"} value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
      <div className="quick-amounts">
        {(mode === "buy" ? [1, 5, 10, 25] : [1, 5, 10]).map((value) => <button key={value} className={Number(amount) === value ? "active" : ""} onClick={() => setAmount(value)} disabled={mode === "sell" && value > ownedShares}>{mode === "buy" ? `$${value}` : value}</button>)}
        {mode === "sell" && <button className={numericAmount === ownedShares && ownedShares > 0 ? "active" : ""} onClick={() => setAmount(ownedShares)} disabled={!ownedShares}>All</button>}
      </div>
      <div className="order-summary">
        <div><span>Current price</span><strong>{Math.round(price * 100)}¢</strong></div>
        <div><span>Est. average price</span><strong>{executionPrice ? `${Math.round(executionPrice * 100)}¢` : "—"}</strong></div>
        {mode === "buy" ? <>
          <div><span>Estimated shares</span><strong>{estimatedShares.toFixed(2)}</strong></div>
          <div className="potential"><span>Potential payout</span><strong>{money(estimatedShares)}</strong></div>
        </> : <>
          <div><span>Shares remaining</span><strong>{Math.max(0, ownedShares - (numericAmount || 0)).toFixed(2)}</strong></div>
          <div className="potential"><span>Estimated proceeds</span><strong>{money(estimatedProceeds)}</strong></div>
        </>}
      </div>
      <button className="buy-button" onClick={executeTrade} disabled={tradeLoading || !isOpen || (mode === "sell" && Boolean(session) && (ownedShares < 0.01 || numericAmount > ownedShares))}>
        <span>{tradeLoading ? "Executing order…" : !isOpen ? "Market closed" : !session ? "Sign in to trade" : mode === "buy" ? `Buy ${side} for ${money(numericAmount || 0)}` : numericAmount === ownedShares && ownedShares > 0 ? `Sell all ${side} shares` : `Sell ${(numericAmount || 0).toFixed(2)} ${side} shares`}</span>
      </button>
      {tradeError && <p className="trade-error" role="alert">{tradeError}</p>}
      {tradeResult && <p className="trade-success" role="status"><Check size={14} /> {tradeResult}</p>}
    </aside>
  );
}

const timeAgo = (isoString) => {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function MarketDetail({ market, navigate, openAuth, balance, onTradeComplete }) {
  const [trades, setTrades] = useState([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [relatedTweets, setRelatedTweets] = useState([]);
  const [tweetsLoading, setTweetsLoading] = useState(true);
  const [tweetsError, setTweetsError] = useState("");

  useEffect(() => {
    let active = true;
    setTradesLoading(true);
    getTrades(market.id, 20)
      .then((nextTrades) => { if (active) setTrades(nextTrades); })
      .catch((error) => console.error("Could not load trades", error))
      .finally(() => { if (active) setTradesLoading(false); });
    return () => { active = false; };
  }, [market.id]);

  useEffect(() => {
    let active = true;
    setTweetsLoading(true);
    setTweetsError("");
    getRelatedTweets(market.dbId, 8)
      .then((tweets) => {
        if (!active) return;
        setRelatedTweets(tweets);
        setTweetsLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setRelatedTweets([]);
        setTweetsError(err.message || "Could not load related posts.");
        setTweetsLoading(false);
      });
    return () => { active = false; };
  }, [market.dbId]);

  return (
    <main className="detail-page page-shell">
      <button className="back-link" onClick={() => navigate("/")}><ArrowLeft size={16} /> All markets</button>
      <div className="detail-layout">
        <section className="market-main">
          <div className="detail-meta"><span className="category">{market.category}</span><span><Clock3 size={14} /> Closes {market.closesAt}</span></div>
          <h1>{market.question}</h1>
          <p className="market-description">{market.description}</p>
          {market.sourceTweetUrl && (
            <a className="source-context" href={market.sourceTweetUrl} target="_blank" rel="noopener noreferrer">
              <span className="x-glyph">𝕏</span>
              Open source post on X
            </a>
          )}
          <div className="chart-card">
            <div className="chart-head">
              <div><strong>{Math.round(market.yesPrice * 100)}%</strong><span>chance of YES</span></div>
              <span className={`change-badge ${market.trend}`}>{market.trend === "up" ? "+" : ""}{market.change}¢ over 7 days</span>
            </div>
            <Sparkline values={market.spark} trend={market.trend} large />
            <div className="chart-axis"><span>7 days ago</span><span>Today</span></div>
          </div>
          <div className="market-stats">
            <div><span>Volume</span><strong>{money(market.volume)}</strong></div>
            <div><span>Traders</span><strong>{compact(market.traders)}</strong></div>
            <div><span>Closes</span><strong>{market.closesAt}</strong></div>
          </div>
          <RelatedTweetsSection tweets={relatedTweets} loading={tweetsLoading} error={tweetsError} />
          <section className="trade-history">
            <h2>Trade History</h2>
            {tradesLoading ? (
              <div className="trade-history-loading"><LoaderCircle className="spin" size={16} /> Loading trades…</div>
            ) : trades.length === 0 ? (
              <p className="trade-history-empty">No trades recorded for this market yet.</p>
            ) : (
              <div className="trade-history-table">
                {trades.map((trade) => (
                  <div className="trade-row" key={trade.id}>
                    <span className={`trade-side ${trade.outcome.toLowerCase()}`}>{trade.action === "sell" ? "Sold" : "Bought"} {trade.outcome}</span>
                    <span className="trade-shares">{Number(trade.shares).toFixed(2)} shares</span>
                    <span className="trade-price">@{Math.round(Number(trade.price) * 100)}¢</span>
                    <span className="trade-amount">{money(Number(trade.amount))}</span>
                    <span className="trade-time">{timeAgo(trade.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
        <TradePanel market={market} balance={balance} openAuth={openAuth} onTradeComplete={onTradeComplete} />
      </div>
    </main>
  );
}

function Portfolio({ openMarket, openAuth, navigate }) {
  const { loading, session } = useAuth();
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState("");
  const [profile, setProfile] = useState(null);
  const [savedPositions, setSavedPositions] = useState([]);

  useEffect(() => {
    if (!session || !supabase) return;
    let active = true;
    setPortfolioLoading(true);
    Promise.all([getProfile(session.user.id), getPositions()]).then(([profileResult, positionsResult]) => {
      if (!active) return;
      setProfile(profileResult);
      setSavedPositions(positionsResult);
      setPortfolioLoading(false);
    }).catch((error) => {
      if (!active) return;
      setPortfolioError(error.message || "Could not load your positions.");
      setPortfolioLoading(false);
    });
    return () => { active = false; };
  }, [session]);

  if (loading) return <main className="auth-gate page-shell"><LoaderScreen /></main>;
  if (!session) return (
    <main className="auth-gate page-shell">
      <div className="auth-gate-mark"><Wallet size={24} /></div>
      <span className="section-kicker">Your market view</span>
      <h1>Sign in to see your portfolio.</h1>
      <p>Your positions, balance, and market history stay connected to your account.</p>
      <button onClick={openAuth}>Sign in to continue <ArrowRight size={17} /></button>
    </main>
  );

  const positionsValue = savedPositions.reduce((total, position) => {
    const yesPrice = Number(position.markets.yes_price);
    const currentPrice = position.markets.status === "resolved"
      ? position.markets.outcome === position.outcome ? 1 : 0
      : position.outcome === "YES" ? yesPrice : 1 - yesPrice;
    return total + Number(position.shares) * currentPrice;
  }, 0);

  return (
    <main className="portfolio-page page-shell">
      <div className="portfolio-head"><h1>Portfolio</h1><p>Track your balance and open market positions.</p></div>
      <button className="add-credits-button" onClick={() => navigate("/credits")}>Add credits <ArrowRight size={16} /></button>
      <div className="balance-grid">
        <div className="balance-card primary"><span>Available balance</span><strong>{profile ? money(Number(profile.demo_balance)) : "—"}</strong><small>Credits</small></div>
        <div className="balance-card"><span>Positions value</span><strong>{money(positionsValue)}</strong><small>Open positions</small></div>
        <div className="balance-card"><span>Markets traded</span><strong>{new Set(savedPositions.map((position) => position.market_id)).size}</strong><small>{savedPositions.length} open positions</small></div>
      </div>
      <section className="positions-section"><h2>Positions</h2>
        <div className="positions-table">
          {portfolioLoading && <LoaderScreen />}
          {portfolioError && <p className="trade-error" role="alert">{portfolioError}</p>}
          {!portfolioLoading && !portfolioError && savedPositions.length === 0 && <p className="portfolio-empty">Your completed purchases will appear here.</p>}
          {savedPositions.map((position) => {
            const yesPrice = Number(position.markets.yes_price);
            const currentPrice = position.markets.status === "resolved"
              ? position.markets.outcome === position.outcome ? 1 : 0
              : position.outcome === "YES" ? yesPrice : 1 - yesPrice;
            return <button className="position-row" key={`${position.market_id}-${position.outcome}`} onClick={() => openMarket(position.markets.slug)}>
              <div><span className={`position-side ${position.outcome.toLowerCase()}`}>{position.outcome}</span><strong>{position.markets.question}</strong></div>
              <span><small>Shares</small>{Number(position.shares).toFixed(2)}</span><span><small>Avg. price</small>{Math.round(Number(position.average_price) * 100)}¢</span><span><small>Value</small>{money(Number(position.shares) * currentPrice)}</span><ArrowRight size={17} />
            </button>;
          })}
        </div>
      </section>
    </main>
  );
}

function CreditStore({ openAuth, navigate }) {
  const { loading, session } = useAuth();
  const [checkoutAmount, setCheckoutAmount] = useState(null);
  const [error, setError] = useState("");
  const packs = [5, 10, 25, 50, 100];

  const startCheckout = async (amount) => {
    if (!session) {
      openAuth();
      return;
    }
    setCheckoutAmount(amount);
    setError("");
    try {
      const { data, error: checkoutError } = await supabase.functions.invoke("create-checkout-session", {
        body: { amount },
      });
      if (checkoutError) throw checkoutError;
      if (!data?.url) throw new Error("Stripe did not return a checkout URL.");
      window.location.assign(data.url);
    } catch (nextError) {
      setError(nextError.message || "Could not open Stripe Checkout.");
      setCheckoutAmount(null);
    }
  };

  if (loading) return <main className="auth-gate page-shell"><LoaderScreen /></main>;

  return (
    <main className="credits-page page-shell">
      <button className="back-link" onClick={() => navigate("/portfolio")}><ArrowLeft size={16} /> Portfolio</button>
      <h1>Top up your trading balance.</h1>
      <p className="credits-lede">Choose a credit pack and continue to secure checkout.</p>
      <div className="credit-packs">
        {packs.map((amount) => (
          <button key={amount} onClick={() => startCheckout(amount)} disabled={checkoutAmount != null}>
            <span>{(amount * 100).toLocaleString()}</span>
            <small>credits</small>
            <strong>{checkoutAmount === amount ? "Opening checkout…" : `$${amount}`}</strong>
          </button>
        ))}
      </div>
      {!session && <p className="credit-notice">Sign in before purchasing credits.</p>}
      {error && <p className="trade-error" role="alert">{error}</p>}
    </main>
  );
}

function CreditResult({ success, navigate }) {
  return (
    <main className="auth-gate page-shell">
      <div className="auth-gate-mark">{success ? <Check size={24} /> : <X size={24} />}</div>
      <span className="section-kicker">Credit wallet</span>
      <h1>{success ? "Credits purchased." : "Checkout canceled."}</h1>
      <p>{success ? "Payment received. Your balance updates as soon as the transaction is processed." : "Your credit balance was not changed."}</p>
      <button onClick={() => navigate(success ? "/portfolio" : "/credits")}>{success ? "View balance" : "Return to credit packs"} <ArrowRight size={17} /></button>
    </main>
  );
}

function LoaderScreen() {
  return <div className="loader-screen"><LoaderCircle className="spin" size={24} /><span>Restoring your session</span></div>;
}

function getExtensionConnectRequest() {
  try {
    const params = new URLSearchParams(window.location.search);
    const redirectTo = new URL(params.get("redirect_to") || "");
    const state = params.get("state") || "";
    const validHost = /^[a-p]{32}\.chromiumapp\.org$/.test(redirectTo.hostname);
    const validState = /^[a-f0-9]{48}$/.test(state);
    if (
      redirectTo.protocol !== "https:" ||
      !validHost ||
      redirectTo.pathname !== "/supabase-auth" ||
      !validState
    ) {
      return null;
    }
    return { redirectTo, state, extensionId: redirectTo.hostname.split(".")[0] };
  } catch {
    return null;
  }
}

function ExtensionAuth({ openAuth }) {
  const { configured, loading, session } = useAuth();
  const request = useMemo(getExtensionConnectRequest, []);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    if (!session || !request || !supabase) return;
    setConnecting(true);
    setError("");
    try {
      const { data, error: functionError } = await supabase.functions.invoke("extension-auth-token");
      if (functionError) throw functionError;
      if (!data?.tokenHash || data.tokenType !== "magiclink") {
        throw new Error("The server did not return a valid connection token.");
      }
      request.redirectTo.searchParams.set("token_hash", data.tokenHash);
      request.redirectTo.searchParams.set("token_type", data.tokenType);
      request.redirectTo.searchParams.set("state", request.state);
      window.location.assign(request.redirectTo.toString());
    } catch (nextError) {
      console.error("Could not connect extension", nextError);
      setError("Could not connect the extension. Please sign in again and retry.");
      setConnecting(false);
    }
  };

  if (!request) {
    return (
      <main className="auth-gate page-shell extension-connect">
        <div className="auth-gate-mark"><X size={24} /></div>
        <span className="section-kicker">Extension connection</span>
        <h1>Invalid connection request</h1>
        <p>Open the xmarket extension popup and start the connection again.</p>
      </main>
    );
  }

  return (
    <main className="auth-gate page-shell extension-connect">
      <div className="auth-gate-mark">{loading || connecting ? <LoaderCircle className="spin" size={24} /> : <Check size={24} />}</div>
      <span className="section-kicker">Extension connection</span>
      <h1>Connect xmarket to this account</h1>
      <p>
        {session
          ? `Continue as ${session.user.email || "your signed-in account"}. The extension will receive a short-lived, single-use login token.`
          : "Sign in to the website first, then connect the extension to the same account."}
      </p>
      {!configured ? (
        <p className="auth-error">Supabase is not configured for this website.</p>
      ) : loading ? (
        <div className="loader-screen"><LoaderCircle className="spin" size={22} /> Checking your session…</div>
      ) : session ? (
        <button onClick={connect} disabled={connecting}>
          {connecting ? "Connecting…" : "Connect extension"} <ArrowRight size={17} />
        </button>
      ) : (
        <button onClick={openAuth}>Sign in to continue <ArrowRight size={17} /></button>
      )}
      {error && <p className="auth-error">{error}</p>}
      <small className="extension-id">Extension {request.extensionId}</small>
    </main>
  );
}

function MarketRouteState({ loading, error, navigate, retry }) {
  return (
    <main className="auth-gate page-shell">
      <div className="auth-gate-mark">{loading ? <LoaderCircle className="spin" size={24} /> : <X size={24} />}</div>
      <span className="section-kicker">Market lookup</span>
      <h1>{loading ? "Loading market…" : "Market unavailable"}</h1>
      <p>{loading ? "Fetching the latest canonical market state from Supabase." : error}</p>
      {!loading && <div className="route-error-actions"><button onClick={retry}>Try again</button><button onClick={() => navigate("/")}>All markets</button></div>}
    </main>
  );
}

function App() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  const [path, setPath] = useState(window.location.pathname);
  const [authOpen, setAuthOpen] = useState(false);
  const [markets, setMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketsError, setMarketsError] = useState("");
  const [market, setMarket] = useState(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [profile, setProfile] = useState(null);
  const { session } = useAuth();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("xmarket-theme", theme);
    const themeColor = document.querySelector("#theme-color");
    if (themeColor) themeColor.content = theme === "dark" ? "#000000" : "#ffffff";
  }, [theme]);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadMarketList = useCallback(async () => {
    setMarketsLoading(true);
    setMarketsError("");
    try {
      setMarkets(await listMarkets());
    } catch (error) {
      setMarketsError(error.message || "Could not load markets.");
    } finally {
      setMarketsLoading(false);
    }
  }, []);

  useEffect(() => { loadMarketList(); }, [loadMarketList]);

  const refreshProfile = useCallback(async () => {
    if (!session) {
      setProfile(null);
      return;
    }
    try {
      setProfile(await getProfile(session.user.id));
    } catch (error) {
      console.error("Could not load profile", error);
      setProfile(null);
    }
  }, [session]);

  useEffect(() => { refreshProfile(); }, [refreshProfile]);

  const navigate = (next) => {
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const marketId = path.startsWith("/market/") ? decodeURIComponent(path.split("/")[2] || "") : null;

  const loadSelectedMarket = useCallback(async () => {
    if (!marketId) {
      setMarket(null);
      setMarketError("");
      return;
    }
    setMarket(null);
    setMarketLoading(true);
    setMarketError("");
    try {
      const nextMarket = await getMarket(marketId);
      if (!nextMarket) throw new Error(`No market exists with the slug “${marketId}”.`);
      setMarket(nextMarket);
    } catch (error) {
      setMarket(null);
      setMarketError(error.message || "Could not load this market.");
    } finally {
      setMarketLoading(false);
    }
  }, [marketId]);

  useEffect(() => {
    loadSelectedMarket();
    if (!marketId) return undefined;
    return subscribeToMarket(marketId, loadSelectedMarket);
  }, [marketId, loadSelectedMarket]);

  const handleTradeComplete = async () => {
    await Promise.all([loadSelectedMarket(), loadMarketList(), refreshProfile()]);
  };

  const creditResult = path === "/credits/success" ? true : path === "/credits/cancel" ? false : null;
  const page = path === "/extension-auth" ? "extension-auth" : creditResult != null ? "credit-result" : path === "/credits" ? "credits" : marketId ? "market" : path === "/portfolio" ? "portfolio" : "home";
  const openMarket = (id) => navigate(`/market/${id}`);
  return (
    <>
      <Header page={page} navigate={navigate} openAuth={() => setAuthOpen(true)} balance={profile ? Number(profile.demo_balance) : null} theme={theme} toggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} />
      {page === "market" && (market
        ? <MarketDetail market={market} navigate={navigate} openAuth={() => setAuthOpen(true)} balance={profile ? Number(profile.demo_balance) : null} onTradeComplete={handleTradeComplete} />
        : <MarketRouteState loading={marketLoading || !marketError} error={marketError} navigate={navigate} retry={loadSelectedMarket} />
      )}
      {page === "portfolio" && <Portfolio openMarket={openMarket} openAuth={() => setAuthOpen(true)} navigate={navigate} />}
      {page === "credits" && <CreditStore openAuth={() => setAuthOpen(true)} navigate={navigate} />}
      {page === "credit-result" && <CreditResult success={creditResult} navigate={navigate} />}
      {page === "extension-auth" && <ExtensionAuth openAuth={() => setAuthOpen(true)} />}
      {page === "home" && <Home markets={markets} loading={marketsLoading} error={marketsError} openMarket={openMarket} retry={loadMarketList} />}
      <AuthModal open={authOpen && !session} onClose={() => setAuthOpen(false)} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<AuthProvider><App /></AuthProvider>);

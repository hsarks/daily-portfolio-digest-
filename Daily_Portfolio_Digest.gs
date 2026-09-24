/************************************************************
 DAILY PORTFOLIO DIGEST

 GOOGLE SHEET STRUCTURE
 A = Ticker
 B = Price
 C = Change %
 D = Headlines
 E = Share Name

 IMPORTANT:
 - Portfolio holdings are NEVER hard-coded here.
 - Add/remove holdings in Google Sheets and this script adapts.
************************************************************/


/************************************************************
 CONFIG
************************************************************/

const FINNHUB_API_KEY = "YOUR_FINNHUB_KEY_HERE";
const GEMINI_API_KEY  = "YOUR_GEMINI_KEY_HERE";
const EMAIL           = "YOUR_EMAIL@gmail.com";


// ---------------------------------------------------------
// FINNHUB
// ---------------------------------------------------------

const FINNHUB_LOOKBACK_REASON_DAYS = 7;
const FINNHUB_MAX_PER_TICKER_ITEMS = 10;
const FINNHUB_MIN_DELAY_MS = 120;

let FINNHUB_STOP_CALLS_ = false;


// ---------------------------------------------------------
// GOOGLE NEWS / REASONS
// ---------------------------------------------------------

const GOOGLE_NEWS_REASON_ITEMS = 10;
const REASON_CANDIDATES_PER_STOCK = 6;


// ---------------------------------------------------------
// OPENING / MACRO
// ---------------------------------------------------------

const OPENING_AVOID_REPEAT_DAYS = 4;
const OPENING_CANDIDATE_LIMIT = 8;
const OPENING_MAX_ETF_LISTICLES = 1;

const MACRO_RSS_MAX_ITEMS_PER_QUERY = 6;
const MACRO_RSS_TOTAL_CAP = 24;


// ---------------------------------------------------------
// OPTIONAL CURRENCY OVERRIDES
//
// This DOES NOT define your portfolio.
// It is only for unusual instruments where the name alone
// isn't enough to infer the trading currency.
//
// Most holdings require no entry here.
//
// Examples if ever needed:
//
// const CURRENCY_OVERRIDES = {
//   "XYZ": { currency: "EUR", divisor: 1 },
//   "ABC": { currency: "GBP", divisor: 100 }
// };
//
// Leave empty unless you find an exception.
// ---------------------------------------------------------

const CURRENCY_OVERRIDES = {};


/************************************************************
 GENERAL HELPERS
************************************************************/

function todayKey_() {
  return Utilities.formatDate(
    new Date(),
    "Europe/London",
    "yyyy-MM-dd"
  );
}


function sleepMs_(ms) {
  ms = Number(ms);

  if (!isFinite(ms) || ms <= 0) {
    return;
  }

  Utilities.sleep(ms);
}


function normHeadline_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}


function escapeHtml_(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


function truncate_(s, maxLength) {
  const text = String(s || "");

  if (text.length <= maxLength) {
    return text;
  }

  return text
    .slice(0, maxLength - 1)
    .trim() + "…";
}


function escapeRegex_(s) {
  return String(s || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/************************************************************
 CACHE
************************************************************/

function cacheGet_(cacheKey) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(cacheKey);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}


function cacheSet_(cacheKey, obj, seconds) {
  try {
    const cache = CacheService.getScriptCache();

    cache.put(
      cacheKey,
      JSON.stringify(obj),
      seconds || 6 * 60 * 60
    );
  } catch (_) {
    // Cache failure should never prevent the digest.
  }
}


/************************************************************
 NEWS DEDUPLICATION / FILTERING
************************************************************/

function looksLikeJunkHeadline_(headline) {
  const t = normHeadline_(headline);

  const junk = [
    "dave ramsey",
    "gods been good",
    "crypto exchanges workforce",
    "wall street breakfast"
  ];

  return junk.some(j => t.includes(j));
}


function dedupeNews_(items) {
  const seenUrl = new Set();
  const seenHeadline = new Set();
  const output = [];

  for (const item of items || []) {
    if (!item || !item.url || !item.headline) {
      continue;
    }

    if (looksLikeJunkHeadline_(item.headline)) {
      continue;
    }

    const normalised = normHeadline_(item.headline);

    if (!normalised) {
      continue;
    }

    if (seenUrl.has(item.url)) {
      continue;
    }

    if (seenHeadline.has(normalised)) {
      continue;
    }

    seenUrl.add(item.url);
    seenHeadline.add(normalised);

    output.push(item);
  }

  return output;
}


/************************************************************
 SAFE FINNHUB HTTP
************************************************************/

function finnhubFetchJson_(url, cacheKey) {

  if (FINNHUB_STOP_CALLS_) {
    return {
      ok: false,
      code: 429,
      data: null,
      body: "Stopped after rate limit"
    };
  }


  if (cacheKey) {
    const cached = cacheGet_(cacheKey);

    if (cached) {
      return cached;
    }
  }


  sleepMs_(FINNHUB_MIN_DELAY_MS);


  let response;
  let code;
  let body;


  try {
    response = UrlFetchApp.fetch(
      url,
      {
        muteHttpExceptions: true,
        followRedirects: true
      }
    );

    code = response.getResponseCode();
    body = response.getContentText() || "";

  } catch (err) {

    const output = {
      ok: false,
      code: 0,
      data: null,
      body: String(err)
    };

    if (cacheKey) {
      cacheSet_(cacheKey, output, 5 * 60);
    }

    return output;
  }


  if (code === 429) {

    FINNHUB_STOP_CALLS_ = true;

    const output = {
      ok: false,
      code: 429,
      data: null,
      body: body
    };

    if (cacheKey) {
      cacheSet_(cacheKey, output, 10 * 60);
    }

    Logger.log(
      "ℹ️ Finnhub rate limit reached. " +
      "Stopping further Finnhub requests this run."
    );

    return output;
  }


  if (code !== 200) {

    const output = {
      ok: false,
      code: code,
      data: null,
      body: body
    };

    if (cacheKey) {
      cacheSet_(cacheKey, output, 10 * 60);
    }

    return output;
  }


  const trimmed = body.trim();


  if (
    !trimmed ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<")
  ) {

    const output = {
      ok: false,
      code: 200,
      data: null,
      body: "HTML returned instead of JSON"
    };

    if (cacheKey) {
      cacheSet_(cacheKey, output, 30 * 60);
    }

    return output;
  }


  try {

    const data = JSON.parse(trimmed);

    const output = {
      ok: true,
      code: 200,
      data: data,
      body: ""
    };

    if (cacheKey) {
      cacheSet_(
        cacheKey,
        output,
        6 * 60 * 60
      );
    }

    return output;

  } catch (err) {

    const output = {
      ok: false,
      code: 200,
      data: null,
      body: "JSON parse failed: " + err
    };

    if (cacheKey) {
      cacheSet_(
        cacheKey,
        output,
        30 * 60
      );
    }

    return output;
  }
}


/************************************************************
 FINNHUB COMPANY NEWS
************************************************************/

function fetchCompanyNews_(ticker, lookbackDays) {

  const today = new Date();

  const from = new Date(
    today.getTime() -
    (lookbackDays || FINNHUB_LOOKBACK_REASON_DAYS) *
    24 * 60 * 60 * 1000
  );


  const formatDate = d =>
    d.toISOString().split("T")[0];


  const url =
    "https://finnhub.io/api/v1/company-news" +
    "?symbol=" + encodeURIComponent(ticker) +
    "&from=" + formatDate(from) +
    "&to=" + formatDate(today) +
    "&token=" + FINNHUB_API_KEY;


  const cacheKey =
    "fh_company_" +
    todayKey_() +
    "_" +
    ticker +
    "_" +
    (lookbackDays || FINNHUB_LOOKBACK_REASON_DAYS);


  const result =
    finnhubFetchJson_(
      url,
      cacheKey
    );


  if (!result.ok) {
    return [];
  }


  const data = result.data;


  if (
    !Array.isArray(data) ||
    !data.length
  ) {
    return [];
  }


  return data
    .slice(
      0,
      FINNHUB_MAX_PER_TICKER_ITEMS
    )
    .map(n => ({
      headline: n.headline || "",
      url: n.url || "",
      source: n.source || "Finnhub",
      summary: n.summary || "",
      publishedAt:
        n.datetime
          ? Number(n.datetime) * 1000
          : 0,
      ticker: ticker
    }))
    .filter(
      n =>
        n.headline &&
        n.url
    );
}


/************************************************************
 GOOGLE NEWS RSS
************************************************************/

function fetchGoogleNewsRss_(
  query,
  maxItems,
  category
) {

  const q = String(query || "").trim();

  if (!q) {
    return [];
  }


  const cacheKey =
    "gn_rss_" +
    todayKey_() +
    "_" +
    Utilities
      .base64EncodeWebSafe(q)
      .slice(0, 45);


  const cached = cacheGet_(cacheKey);

  if (cached) {
    return cached;
  }


  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(q) +
    "&hl=en-GB&gl=GB&ceid=GB:en";


  let response;
  let code;
  let xmlText;


  try {

    response =
      UrlFetchApp.fetch(
        url,
        {
          muteHttpExceptions: true,
          followRedirects: true
        }
      );

    code =
      response.getResponseCode();

    xmlText =
      response.getContentText() || "";

  } catch (err) {

    Logger.log(
      `ℹ️ Google News RSS error for "${q}": ${err}`
    );

    return [];
  }


  if (
    code !== 200 ||
    !xmlText.trim()
  ) {

    Logger.log(
      `ℹ️ Google News RSS unavailable (${code}) for "${q}"`
    );

    return [];
  }


  try {

    const document =
      XmlService.parse(xmlText);

    const root =
      document.getRootElement();

    const channel =
      root.getChild("channel");

    const items =
      channel
        ? channel.getChildren("item")
        : [];


    const output = [];


    for (
      const item of
      items.slice(
        0,
        maxItems || 8
      )
    ) {

      const rawTitle =
        item.getChildText("title") || "";

      const link =
        item.getChildText("link") || "";

      const pubDate =
        item.getChildText("pubDate") || "";

      const description =
        item.getChildText("description") || "";

      const sourceElement =
        item.getChild("source");

      const source =
        sourceElement
          ? sourceElement.getText()
          : "Google News";


      if (
        !rawTitle ||
        !link
      ) {
        continue;
      }


      const headline =
        rawTitle
          .replace(/\s+\-\s+[^-]+$/, "")
          .trim();


      const parsedDate =
        Date.parse(pubDate);


      output.push({
        headline: headline,
        url: link,
        source: source,
        summary:
          description
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        category:
          category || "news",
        publishedAt:
          isFinite(parsedDate)
            ? parsedDate
            : 0
      });
    }


    const finalItems =
      dedupeNews_(output);


    cacheSet_(
      cacheKey,
      finalItems,
      6 * 60 * 60
    );


    return finalItems;

  } catch (err) {

    Logger.log(
      `ℹ️ Google News RSS parse error for "${q}": ${err}`
    );

    return [];
  }
}


/************************************************************
 HOLDING TYPE / MARKET HEURISTICS

 These are RULES, not portfolio definitions.
************************************************************/

function isFundLike_(name) {

  const n =
    String(name || "");


  return (
    /UCITS/i.test(n) ||
    /\bETF\b/i.test(n) ||
    /\bETC\b/i.test(n) ||
    /^iShares\b/i.test(n) ||
    /^WisdomTree\b/i.test(n) ||
    /^VanEck\b/i.test(n) ||
    /^Global X\b/i.test(n)
  );
}


function likelyNonNorthAmerican_(
  ticker,
  name
) {

  const n =
    String(name || "");


  if (isFundLike_(n)) {
    return true;
  }


  if (/\bPLC\b/i.test(n)) {
    return true;
  }


  if (
    /\bSA\b/i.test(n) ||
    /\bS\.A\.\b/i.test(n)
  ) {
    return true;
  }


  if (
    /\bLtd\b/i.test(n) ||
    /\bLimited\b/i.test(n)
  ) {
    return true;
  }


  return false;
}


/************************************************************
 CURRENCY / PRICE DISPLAY

 No portfolio tickers are required here.

 Rules:
 - PLC → assume UK listing, display as £ after pence conversion
 - SA / S.A. → EUR
 - UCITS/ETF/ETC:
      price > 500 → assume GBX and divide by 100
      otherwise → assume GBP
 - Everything else → USD

 CURRENCY_OVERRIDES can handle unusual exceptions.
************************************************************/

function priceMeta_(
  ticker,
  name,
  rawPrice
) {

  const t =
    String(ticker || "")
      .toUpperCase();

  const n =
    String(name || "");

  const price =
    Number(rawPrice);


  if (
    CURRENCY_OVERRIDES[t]
  ) {

    const override =
      CURRENCY_OVERRIDES[t];

    return {
      currency:
        override.currency,

      divisor:
        Number(
          override.divisor || 1
        ),

      price:
        price /
        Number(
          override.divisor || 1
        )
    };
  }


  // European S.A.
  if (
    /\bSA\b/i.test(n) ||
    /\bS\.A\.\b/i.test(n)
  ) {

    return {
      currency: "EUR",
      divisor: 1,
      price: price
    };
  }


  // UK PLC — Google Finance LSE values
  // are commonly returned in pence.
  if (/\bPLC\b/i.test(n)) {

    return {
      currency: "GBP",
      divisor: 100,
      price: price / 100
    };
  }


  // UK-listed funds / ETCs.
  if (isFundLike_(n)) {

    if (price > 500) {

      return {
        currency: "GBP",
        divisor: 100,
        price: price / 100
      };
    }


    return {
      currency: "GBP",
      divisor: 1,
      price: price
    };
  }


  // Default for ordinary non-UK equities.
  return {
    currency: "USD",
    divisor: 1,
    price: price
  };
}


function priceSymbol_(currency) {

  if (currency === "GBP") {
    return "£";
  }

  if (currency === "EUR") {
    return "€";
  }

  return "$";
}


function formatPrice_(holding) {

  const meta =
    priceMeta_(
      holding.ticker,
      holding.name,
      holding.price
    );


  if (
    meta.price === null ||
    meta.price === undefined ||
    isNaN(meta.price)
  ) {
    return "—";
  }


  return (
    priceSymbol_(meta.currency) +
    Number(meta.price)
      .toFixed(2)
  );
}


/************************************************************
 CHANGE DISPLAY
************************************************************/

function changeSpan_(changePct) {

  if (
    changePct === null ||
    changePct === undefined ||
    isNaN(changePct)
  ) {

    return (
      '<span class="flat">n/a</span>'
    );
  }


  const value =
    Number(changePct);


  if (value > 0) {

    return (
      '<span class="pos">+' +
      value.toFixed(2) +
      "%</span>"
    );
  }


  if (value < 0) {

    return (
      '<span class="neg">' +
      value.toFixed(2) +
      "%</span>"
    );
  }


  return (
    '<span class="flat">0.00%</span>'
  );
}


/************************************************************
 MACRO / SECTOR NEWS
************************************************************/

function isETFListicleHeadline_(headline) {

  const t =
    normHeadline_(headline);


  return (
    (
      t.includes("etf") &&
      (
        t.includes("best") ||
        t.includes("to buy") ||
        t.includes("consider") ||
        t.includes("top") ||
        t.includes("isa")
      )
    ) ||
    t.includes("isa deadline") ||
    t.includes("thematic etf") ||
    t.includes("growth etf") ||
    t.includes("dividend etf")
  );
}


function isMacroHeadline_(headline) {

  if (
    isETFListicleHeadline_(
      headline
    )
  ) {
    return false;
  }


  const h =
    normHeadline_(headline);


  const terms = [
    "stock market today",
    "market today",
    "markets today",
    "futures",
    "dow",
    "sp 500",
    "nasdaq",
    "treasury",
    "yield",
    "bond",
    "fed",
    "interest rate",
    "inflation",
    "cpi",
    "jobs report",
    "payroll",
    "oil",
    "brent",
    "wti",
    "opec",
    "geopolitical",
    "sanctions",
    "war",
    "iran",
    "venezuela",
    "maduro",
    "china",
    "taiwan",
    "trade",
    "tariff",
    "shutdown",
    "election",
    "white house",
    "recession",
    "dollar"
  ];


  return terms.some(
    term =>
      h.includes(
        normHeadline_(term)
      )
  );
}


function isBroadSectorHeadline_(headline) {

  const h =
    normHeadline_(headline);


  const terms = [
    "semiconductor",
    "chip",
    "artificial intelligence",
    "ai stocks",
    "technology stocks",
    "cloud",
    "energy stocks",
    "oil stocks",
    "healthcare",
    "biotech",
    "banks",
    "financial stocks",
    "clean energy",
    "gold",
    "defence",
    "aerospace"
  ];


  return terms.some(
    term =>
      h.includes(
        normHeadline_(term)
      )
  );
}


/************************************************************
 FETCH TRUE MACRO NEWS

 Independent of portfolio holdings.
************************************************************/

function fetchMacroRssNews_() {

  const queries = [

    {
      q:
        "stock market today futures Dow S&P 500 Nasdaq",
      category:
        "broad-market"
    },

    {
      q:
        "Treasury yields Federal Reserve interest rates stocks",
      category:
        "rates"
    },

    {
      q:
        "inflation CPI jobs report stock market",
      category:
        "economy"
    },

    {
      q:
        "oil prices Brent WTI geopolitical markets stocks",
      category:
        "oil-geopolitics"
    },

    {
      q:
        "tariffs trade sanctions China markets stocks",
      category:
        "global-trade"
    },

    {
      q:
        "semiconductor chip sector stocks market",
      category:
        "semiconductors"
    },

    {
      q:
        "AI technology stocks sector market",
      category:
        "technology"
    },

    {
      q:
        "FTSE 100 market today UK stocks",
      category:
        "uk-market"
    }

  ];


  let all = [];


  for (const item of queries) {

    const news =
      fetchGoogleNewsRss_(
        item.q,
        MACRO_RSS_MAX_ITEMS_PER_QUERY,
        item.category
      );


    all.push(
      ...news.map(n => ({
        ...n,
        ticker: "MACRO"
      }))
    );
  }


  all =
    dedupeNews_(all);


  const now =
    Date.now();


  const currentDay =
    new Date().getDay();


  // Monday needs a wider window because of weekend.
  const maxAgeHours =
    currentDay === 1
      ? 96
      : 60;


  const cutoff =
    now -
    maxAgeHours *
    60 * 60 * 1000;


  const recent =
    all.filter(n =>
      !n.publishedAt ||
      n.publishedAt >= cutoff
    );


  return (
    recent.length
      ? recent
      : all
  ).slice(
    0,
    MACRO_RSS_TOTAL_CAP
  );
}


/************************************************************
 OPENING STORY MEMORY
************************************************************/

function openingMemoryKey_() {
  return "OPENING_USED_HEADLINES_V2";
}


function loadOpeningMemory_() {

  const raw =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        openingMemoryKey_()
      );


  if (!raw) {
    return [];
  }


  try {
    return JSON.parse(raw) || [];
  } catch (_) {
    return [];
  }
}


function saveOpeningMemory_(memory) {

  PropertiesService
    .getScriptProperties()
    .setProperty(
      openingMemoryKey_(),
      JSON.stringify(
        memory || []
      )
    );
}


function headlineTokens_(headline) {

  const stopWords =
    new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "to",
      "of",
      "in",
      "on",
      "for",
      "with",
      "as",
      "after",
      "amid",
      "stock",
      "stocks",
      "market",
      "markets",
      "today",
      "live",
      "update",
      "updates"
    ]);


  return normHeadline_(headline)
    .split(" ")
    .filter(
      token =>
        token.length > 2 &&
        !stopWords.has(token)
    );
}


function headlineSimilarity_(
  a,
  b
) {

  const A =
    new Set(
      headlineTokens_(a)
    );

  const B =
    new Set(
      headlineTokens_(b)
    );


  if (
    !A.size ||
    !B.size
  ) {
    return 0;
  }


  let intersection = 0;


  for (const token of A) {
    if (B.has(token)) {
      intersection++;
    }
  }


  const union =
    new Set([
      ...A,
      ...B
    ]).size;


  return intersection / union;
}


function recentlyUsedOpeningStory_(headline) {

  const memory =
    loadOpeningMemory_();


  const cutoff =
    Date.now() -
    OPENING_AVOID_REPEAT_DAYS *
    24 * 60 * 60 * 1000;


  for (const item of memory) {

    if (
      !item ||
      !item.date ||
      !item.headline
    ) {
      continue;
    }


    const timestamp =
      Date.parse(item.date);


    if (
      !isFinite(timestamp) ||
      timestamp < cutoff
    ) {
      continue;
    }


    // Near-duplicate detection rather than exact-title only.
    if (
      headlineSimilarity_(
        headline,
        item.headline
      ) >= 0.48
    ) {
      return true;
    }
  }


  return false;
}


function recordOpeningStories_(stories) {

  const existing =
    loadOpeningMemory_();


  const additions =
    (stories || []).map(
      story => ({
        date:
          new Date()
            .toISOString(),

        headline:
          story.headline
      })
    );


  saveOpeningMemory_(
    [
      ...additions,
      ...existing
    ].slice(0, 40)
  );
}


/************************************************************
 OPENING STORY SCORING
************************************************************/

function openingImpactScore_(story) {

  const h =
    normHeadline_(
      story.headline
    );


  let score = 0;


  // Index / market-wide move.
  if (
    /sp 500|nasdaq|dow|futures/.test(h)
  ) {
    score += 14;
  }


  // Rates / inflation / economy.
  if (
    /treasury|yield|fed|interest rate|inflation|cpi|jobs|payroll/.test(h)
  ) {
    score += 13;
  }


  // Geopolitics / oil / trade.
  if (
    /oil|brent|wti|iran|war|tariff|trade|sanction|china|taiwan|venezuela|geopolit/.test(h)
  ) {
    score += 12;
  }


  // Broad sector.
  if (
    isBroadSectorHeadline_(
      story.headline
    )
  ) {
    score += 7;
  }


  // Macro classification.
  if (
    isMacroHeadline_(
      story.headline
    )
  ) {
    score += 5;
  }


  // ETF listicles are allowed occasionally,
  // but they should rarely lead.
  if (
    isETFListicleHeadline_(
      story.headline
    )
  ) {
    score -= 8;
  }


  // Freshness.
  if (story.publishedAt) {

    const ageHours =
      (
        Date.now() -
        story.publishedAt
      ) /
      (60 * 60 * 1000);


    if (ageHours < 12) {
      score += 7;
    }
    else if (ageHours < 24) {
      score += 5;
    }
    else if (ageHours < 48) {
      score += 2;
    }
  }


  // Block repeats / syndications from recent openings.
  if (
    recentlyUsedOpeningStory_(
      story.headline
    )
  ) {
    score -= 30;
  }


  return score;
}


function pickOpeningCandidates_(
  macroPool
) {

  const scored =
    (macroPool || [])
      .map(story => ({
        ...story,
        openingScore:
          openingImpactScore_(
            story
          )
      }))
      .sort(
        (a, b) =>
          b.openingScore -
          a.openingScore
      );


  const output = [];

  let listiclesUsed = 0;


  for (const story of scored) {

    if (
      isETFListicleHeadline_(
        story.headline
      )
    ) {

      if (
        listiclesUsed >=
        OPENING_MAX_ETF_LISTICLES
      ) {
        continue;
      }

      listiclesUsed++;
    }


    output.push(story);


    if (
      output.length >=
      OPENING_CANDIDATE_LIMIT
    ) {
      break;
    }
  }


  return output;
}


/************************************************************
 COMPANY NEWS RELEVANCE
************************************************************/

function companyTokens_(name) {

  const stop =
    new Set([
      "inc",
      "incorporated",
      "corp",
      "corporation",
      "plc",
      "ltd",
      "limited",
      "sa",
      "group",
      "holdings",
      "company",
      "technologies",
      "technology",
      "class"
    ]);


  return String(name || "")
    .toLowerCase()
    .replace(
      /[\(\)\.,:;'"“”]/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(
      word =>
        word.length >= 4 &&
        !stop.has(word)
    );
}


function reasonHeadlineScore_(
  story,
  holding
) {

  const h =
    normHeadline_(
      story.headline
    );


  let score = 0;


  const ticker =
    normHeadline_(
      holding.ticker
    );


  if (
    ticker &&
    new RegExp(
      `\\b${escapeRegex_(ticker)}\\b`
    ).test(h)
  ) {
    score += 15;
  }


  const tokens =
    companyTokens_(
      holding.name
    );


  let tokenMatches = 0;


  for (const token of tokens) {

    if (h.includes(token)) {
      tokenMatches++;
    }
  }


  if (tokenMatches >= 2) {
    score += 12;
  }
  else if (tokenMatches === 1) {
    score += 7;
  }


  // Analyst action.
  if (
    /upgrade|upgraded|downgrade|downgraded|price target|target price|outperform|underperform|overweight|underweight|buy rating|sell rating|neutral rating|initiates coverage/.test(h)
  ) {
    score += 14;
  }


  // Financial results.
  if (
    /earnings|results|guidance|revenue|eps|profit|loss|forecast/.test(h)
  ) {
    score += 11;
  }


  // Business catalyst.
  if (
    /contract|order|partnership|deal|acquisition|merger|takeover|bid|funding|financing|launch/.test(h)
  ) {
    score += 10;
  }


  // Regulatory catalyst.
  if (
    /fda|approval|trial|regulator|lawsuit|investigation|sec|doj/.test(h)
  ) {
    score += 10;
  }


  // Generic market/listicle content gets penalised.
  if (
    /best stocks|stocks to buy|portfolio|week ahead|market outlook|prediction|etf/.test(h)
  ) {
    score -= 8;
  }


  // Freshness.
  if (story.publishedAt) {

    const ageHours =
      (
        Date.now() -
        story.publishedAt
      ) /
      (60 * 60 * 1000);


    if (ageHours < 24) {
      score += 5;
    }
    else if (ageHours < 48) {
      score += 3;
    }
  }


  return score;
}


/************************************************************
 FETCH REASON CANDIDATES

 Important improvement:
 Google News SUPPLEMENTS Finnhub rather than only being used
 when Finnhub returns nothing.
************************************************************/

function collectReasonCandidates_(
  holding
) {

  let stories = [];


  // Finnhub where appropriate.
  if (
    !likelyNonNorthAmerican_(
      holding.ticker,
      holding.name
    )
  ) {

    stories.push(
      ...fetchCompanyNews_(
        holding.ticker,
        FINNHUB_LOOKBACK_REASON_DAYS
      )
    );
  }


  // General Google News company query.
  const baseQuery =
    `"${holding.name}" ${holding.ticker}`;


  stories.push(
    ...fetchGoogleNewsRss_(
      baseQuery,
      GOOGLE_NEWS_REASON_ITEMS,
      "company"
    )
  );


  // Catalyst-focused search catches things such as
  // analyst upgrades which might not rank highly in
  // the generic search.
  const catalystQuery =
    `"${holding.name}" ` +
    `${holding.ticker} ` +
    `(upgrade OR downgrade OR "price target" OR earnings OR guidance OR contract OR acquisition OR approval)`;


  stories.push(
    ...fetchGoogleNewsRss_(
      catalystQuery,
      8,
      "catalyst"
    )
  );


  stories =
    dedupeNews_(stories);


  stories =
    stories
      .map(story => ({
        ...story,
        relevanceScore:
          reasonHeadlineScore_(
            story,
            holding
          )
      }))
      .sort(
        (a, b) =>
          b.relevanceScore -
          a.relevanceScore
      );


  return stories.slice(
    0,
    REASON_CANDIDATES_PER_STOCK
  );
}


/************************************************************
 GEMINI MODEL DISCOVERY
************************************************************/

function listGeminiModels_() {

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models?key=" +
    GEMINI_API_KEY;


  try {

    const response =
      UrlFetchApp.fetch(
        url,
        {
          muteHttpExceptions: true
        }
      );


    if (
      response.getResponseCode() !== 200
    ) {
      return [];
    }


    const data =
      JSON.parse(
        response.getContentText()
      );


    return (
      data.models || []
    )
      .filter(
        model =>
          (
            model.supportedGenerationMethods ||
            []
          ).includes(
            "generateContent"
          )
      )
      .map(
        model =>
          model.name
      );

  } catch (err) {

    Logger.log(
      "Gemini ListModels error: " +
      err
    );

    return [];
  }
}


function rankModels_(models) {

  function score(model) {

    const name =
      String(model || "")
        .toLowerCase();


    let value = 0;


    if (name.includes("flash")) {
      value += 50;
    }


    if (name.includes("2.5")) {
      value += 40;
    }


    if (name.includes("3.")) {
      value += 35;
    }


    if (name.includes("pro")) {
      value += 10;
    }


    if (
      name.includes("exp") ||
      name.includes("preview")
    ) {
      value -= 15;
    }


    return value;
  }


  return [...models]
    .sort(
      (a, b) =>
        score(b) -
        score(a)
    );
}


function getRankedModelsCached_() {

  const props =
    PropertiesService
      .getScriptProperties();


  const cachedJson =
    props.getProperty(
      "GEMINI_MODELS_RANKED_V2"
    );


  const cachedAt =
    Number(
      props.getProperty(
        "GEMINI_MODELS_RANKED_AT_V2"
      ) || 0
    );


  if (
    cachedJson &&
    (
      Date.now() -
      cachedAt
    ) <
    6 * 60 * 60 * 1000
  ) {

    try {
      return JSON.parse(
        cachedJson
      );
    } catch (_) {}
  }


  const ranked =
    rankModels_(
      listGeminiModels_()
    );


  props.setProperty(
    "GEMINI_MODELS_RANKED_V2",
    JSON.stringify(ranked)
  );


  props.setProperty(
    "GEMINI_MODELS_RANKED_AT_V2",
    String(Date.now())
  );


  return ranked;
}


/************************************************************
 GEMINI JSON PARSING
************************************************************/

function parseGeminiJson_(text) {

  if (!text) {
    throw new Error(
      "Empty Gemini response"
    );
  }


  let cleaned =
    String(text).trim();


  cleaned =
    cleaned
      .replace(
        /^```(?:json)?\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .replace(
        /```(?:json)?/gi,
        ""
      )
      .replace(
        /```/g,
        ""
      )
      .trim();


  const firstBrace =
    cleaned.indexOf("{");


  const lastBrace =
    cleaned.lastIndexOf("}");


  if (
    firstBrace === -1 ||
    lastBrace === -1 ||
    lastBrace <= firstBrace
  ) {

    throw new Error(
      "No JSON object found"
    );
  }


  return JSON.parse(
    cleaned.slice(
      firstBrace,
      lastBrace + 1
    )
  );
}


/************************************************************
 GEMINI JSON REQUEST

 One reusable request function for both:
 - catalyst analysis
 - commentary
************************************************************/

function geminiJson_(promptText) {

  const models =
    getRankedModelsCached_();


  if (!models.length) {
    return null;
  }


  for (
    const model of
    models.slice(0, 5)
  ) {

    const url =
      "https://generativelanguage.googleapis.com/v1beta/" +
      model +
      ":generateContent?key=" +
      GEMINI_API_KEY;


    const payload = {

      contents: [
        {
          parts: [
            {
              text: promptText
            }
          ]
        }
      ],

      generationConfig: {
        responseMimeType:
          "application/json",
        temperature:
          0.2
      }
    };


    for (
      let attempt = 1;
      attempt <= 2;
      attempt++
    ) {

      try {

        const response =
          UrlFetchApp.fetch(
            url,
            {
              method: "post",
              contentType:
                "application/json",
              muteHttpExceptions:
                true,
              payload:
                JSON.stringify(
                  payload
                )
            }
          );


        const code =
          response
            .getResponseCode();


        const body =
          response
            .getContentText();


        if (code === 200) {

          try {

            const outer =
              JSON.parse(body);


            const text =
              outer
                .candidates?.[0]
                ?.content
                ?.parts?.[0]
                ?.text;


            if (!text) {
              break;
            }


            return parseGeminiJson_(
              text
            );

          } catch (err) {

            Logger.log(
              `⚠️ Gemini JSON parse error on ${model}: ${err}`
            );

            break;
          }
        }


        if (
          code === 500 ||
          code === 503
        ) {

          Logger.log(
            `⚠️ Gemini ${code} on ${model}, attempt ${attempt}`
          );


          sleepMs_(
            attempt === 1
              ? 1800
              : 3200
          );


          continue;
        }


        if (code === 429) {

          Logger.log(
            `⚠️ Gemini quota/rate limit on ${model}`
          );


          sleepMs_(3000);

          break;
        }


        Logger.log(
          `⚠️ Gemini error ${code} on ${model}: ${body}`
        );


        break;

      } catch (err) {

        Logger.log(
          `⚠️ Gemini exception on ${model}: ${err}`
        );

        break;
      }
    }
  }


  return null;
}


/************************************************************
 REASON / CATALYST AI PROMPT
************************************************************/

function buildReasonPrompt_(
  holdings,
  candidateMap
) {

  const sections = [];


  for (const holding of holdings) {

    const candidates =
      candidateMap[
        holding.ticker
      ] || [];


    const candidateLines =
      candidates.map(
        (story, index) => {

          const id =
            holding.ticker +
            "_" +
            (index + 1);


          return (
            `${id}\n` +
            `HEADLINE: ${story.headline}\n` +
            (
              story.summary
                ? `SUMMARY: ${truncate_(story.summary, 300)}\n`
                : ""
            ) +
            `SOURCE: ${story.source || ""}\n`
          );
        }
      );


    sections.push(
      `TICKER: ${holding.ticker}\n` +
      `COMPANY: ${holding.name}\n` +
      `DAILY MOVE: ${
        holding.change > 0
          ? "+"
          : ""
      }${holding.change.toFixed(2)}%\n\n` +
      `CANDIDATE STORIES:\n` +
      (
        candidateLines.length
          ? candidateLines.join("\n")
          : "NONE"
      )
    );
  }


  return `
Return ONLY valid JSON.

Required format:

{
  "reasons": [
    {
      "ticker": "ABC",
      "reason": "Specific concise catalyst sentence",
      "selected_id": "ABC_1",
      "confidence": "high"
    }
  ]
}

You are identifying the most plausible COMPANY-SPECIFIC catalyst
for today's share-price move.

IMPORTANT RULES:

1. The reason must describe the ACTUAL EVENT.

GOOD:
"Berenberg upgraded Oxford Biomedica to Buy."
"Oppenheimer reiterated Outperform and raised its target to $18."
"The company cut its full-year revenue guidance."
"FDA approval removed a key regulatory overhang."
"Surf Air announced a $26m investment in SurfOS."

BAD:
"Broker upgrade/downgrade shifts sentiment."
"Earnings/guidance resets expectations."
"Deal chatter moves the narrative."
"Headline-driven move."
"Sentiment appears positive."

2. Analyst ratings:
- If it was an UPGRADE, explicitly say upgraded.
- If it was a DOWNGRADE, explicitly say downgraded.
- If the rating was MAINTAINED, explicitly say maintained/reiterated.
- Include the price target if the supplied story clearly states it.

3. DIRECTION MUST MAKE SENSE.
A bullish analyst upgrade is not automatically an explanation
for a stock falling sharply.
A bearish story is not automatically an explanation for a
large gain.

If the supplied stories do not credibly explain the direction,
return:
"reason": "N/A"
"selected_id": ""

4. Do NOT invent facts.

5. Keep the reason concise:
approximately 6–20 words.

6. confidence must be:
"high", "medium", or "low".

7. If confidence would only be LOW, prefer N/A.

DATA:

${sections.join("\n\n-----------------------\n\n")}
`;
}


/************************************************************
 ANALYSE REASONS
************************************************************/

function analyseReasons_(
  holdings,
  candidateMap
) {

  if (!holdings.length) {
    return {};
  }


  const result =
    geminiJson_(
      buildReasonPrompt_(
        holdings,
        candidateMap
      )
    );


  const output = {};


  for (
    const row of
    result?.reasons || []
  ) {

    const ticker =
      String(
        row.ticker || ""
      )
        .trim()
        .toUpperCase();


    if (!ticker) {
      continue;
    }


    const reason =
      String(
        row.reason || ""
      ).trim();


    const selectedId =
      String(
        row.selected_id || ""
      ).trim();


    if (
      !reason ||
      reason.toUpperCase() ===
        "N/A"
    ) {

      output[ticker] = {
        reason: "N/A",
        source: null,
        confidence:
          row.confidence ||
          "medium"
      };

      continue;
    }


    const candidates =
      candidateMap[ticker] || [];


    let selectedStory = null;


    const match =
      selectedId.match(
        new RegExp(
          "^" +
          escapeRegex_(ticker) +
          "_(\\d+)$",
          "i"
        )
      );


    if (match) {

      const index =
        Number(match[1]) - 1;


      if (candidates[index]) {
        selectedStory =
          candidates[index];
      }
    }


    // If Gemini produced a reason but did not choose
    // a real source, don't pretend we have one.
    if (!selectedStory) {

      output[ticker] = {
        reason: "N/A",
        source: null,
        confidence:
          row.confidence ||
          "medium"
      };

      continue;
    }


    output[ticker] = {
      reason: reason,
      source: selectedStory,
      confidence:
        row.confidence ||
        "medium"
    };
  }


  return output;
}


/************************************************************
 DETERMINISTIC REASON FALLBACK

 Only used if Gemini fails completely.
 We deliberately keep this conservative.
************************************************************/

function fallbackReason_(
  holding,
  candidates
) {

  for (const story of candidates || []) {

    const h =
      normHeadline_(
        story.headline
      );


    if (
      /\bupgraded\b|\bupgrade\b/.test(h)
    ) {

      return {
        reason:
          truncate_(
            story.headline,
            110
          ),
        source:
          story
      };
    }


    if (
      /\bdowngraded\b|\bdowngrade\b/.test(h)
    ) {

      return {
        reason:
          truncate_(
            story.headline,
            110
          ),
        source:
          story
      };
    }
  }


  return {
    reason: "N/A",
    source: null
  };
}


/************************************************************
 COMMENTARY PROMPT

 Links use placeholders:
 [[M1|higher Treasury yields]]

 The code converts those to safe hyperlinks afterwards.
************************************************************/

function buildCommentaryPrompt_(
  openingCandidates,
  topMovers,
  declines,
  funds
) {

  const macroLines =
    openingCandidates.map(
      (story, index) => (
        `M${index + 1}\n` +
        `HEADLINE: ${story.headline}\n` +
        `SOURCE: ${story.source || ""}\n`
      )
    ).join("\n");


  const moversLines =
    topMovers.map(
      holding => (
        `${holding.ticker} ` +
        `${holding.change >= 0 ? "+" : ""}` +
        `${holding.change.toFixed(2)}% | ` +
        `CATALYST: ${holding.reasonData?.reason || "N/A"}`
      )
    ).join("\n");


  const declinesLines =
    declines.map(
      holding => (
        `${holding.ticker} ` +
        `${holding.change.toFixed(2)}% | ` +
        `CATALYST: ${holding.reasonData?.reason || "N/A"}`
      )
    ).join("\n");


  const fundLines =
    funds.map(
      holding => (
        `${holding.ticker} ` +
        `${holding.change >= 0 ? "+" : ""}` +
        `${holding.change.toFixed(2)}% | ` +
        `${holding.name}`
      )
    ).join("\n");


  return `
Return ONLY valid JSON.

Required JSON:

{
  "opening_overview_html": "<p>...</p>",
  "opening_used_ids": ["M1","M2"],
  "top_movers_commentary_html": "<p>...</p>",
  "sector_highlights_html": "<p>...</p>",
  "notable_declines_commentary_html": "<p>...</p>",
  "etfs_commentary_html": "<p>...</p>"
}

You are writing an intelligent daily market and portfolio note.

The reader can SEE the price tables.
Do not waste words saying that green stocks rose and red stocks fell.

Your job is to answer:
- What drove markets?
- Why does it matter?
- Which portfolio exposures were helped or hurt?
- Are moves stock-specific, sector-driven or macro-driven?
- What does the clustering of moves tell us?

STYLE:
- UK English.
- Concise but analytical.
- Dry understatement is welcome, but insight matters more.
- Avoid canned phrases.
- Avoid:
  "mixed bag"
  "spirited performers"
  "pockets of activity"
  "investors remain cautious"
  "the tape was indecisive"
  "green shoots"
  "headwinds"
  "the ETF basket is doing what it says on the tin"

LINK FORMAT:

Do NOT write HTML <a> links yourself.

Instead use:

[[M1|higher Treasury yields]]
[[M2|renewed pressure on oil]]
[[M3|the semiconductor sell-off]]

The text after "|" must be a SHORT descriptive anchor:
2–6 words.

Never use the full article title as the anchor.

OPENING OVERVIEW:
- 90–140 words.
- Lead with the broad macro/market picture.
- Identify the 2–3 most consequential drivers.
- Explain the TRANSMISSION MECHANISM.

Examples:
- rising yields increase the discount rate applied to future earnings,
  which can hurt long-duration growth stocks.
- higher oil can lift inflation expectations and complicate the
  interest-rate outlook.
- stronger economic data can reduce expectations for rate cuts.
- geopolitical risk can favour energy/gold while pressuring
  risk-sensitive assets.
- broad chip weakness matters particularly for portfolios with
  substantial semiconductor/AI exposure.

- Then connect those forces to today's portfolio.
- Use 2–3 M-links where useful.
- opening_used_ids must contain the M numbers actually used.

TOP MOVERS COMMENTARY:
- 60–100 words.
- Do NOT narrate rows one by one.
- Identify common themes among the winners.
- Distinguish specific corporate catalysts from broad sector moves.
- Highlight particularly strong/relevant catalyst information.
- Explain what this suggests about today's positioning.

SECTOR HIGHLIGHTS:
- 70–110 words.
- Identify 1–3 meaningful broad sector trends.
- Explain WHY sectors are moving.
- Relate macro conditions to semiconductors, AI, energy,
  healthcare, clean energy, gold etc where relevant.
- Do not merely quote ETF performance.

NOTABLE DECLINES COMMENTARY:
- 60–100 words.
- Look for clustering.
- Distinguish macro/sector repricing from company-specific news.
- Do NOT invent explanations where the catalyst is N/A.
- If growth/AI/semiconductor names are falling together,
  explain the plausible broad-market mechanism where supported
  by the macro headlines.

ETF COMMENTARY:
- 50–90 words.
- Explain what the collective ETF moves say about:
  sector leadership,
  growth vs defensive positioning,
  commodity exposure,
  risk appetite.
- Do not simply list their percentage changes.

MACRO / SECTOR STORIES:

${macroLines}

TOP MOVERS:

${moversLines}

NOTABLE DECLINES:

${declinesLines}

FUNDS / ETFS:

${fundLines}
`;
}


/************************************************************
 RENDER SAFE MACRO LINK PLACEHOLDERS
************************************************************/

function renderMacroLinks_(
  html,
  openingCandidates
) {

  return String(html || "")
    .replace(
      /\[\[M(\d+)\|([^\]]+)\]\]/g,
      function(
        fullMatch,
        number,
        anchorText
      ) {

        const index =
          Number(number) - 1;


        const story =
          openingCandidates[index];


        if (!story) {
          return escapeHtml_(
            anchorText
          );
        }


        return (
          `<a href="${escapeHtml_(story.url)}">` +
          `${escapeHtml_(anchorText)}</a>`
        );
      }
    );
}


/************************************************************
 DETERMINE WHICH OPENING STORIES GEMINI USED
************************************************************/

function openingStoriesFromIds_(
  ids,
  openingCandidates
) {

  const output = [];


  for (const id of ids || []) {

    const match =
      String(id)
        .match(/^M(\d+)$/i);


    if (!match) {
      continue;
    }


    const index =
      Number(match[1]) - 1;


    if (
      openingCandidates[index]
    ) {

      output.push(
        openingCandidates[index]
      );
    }
  }


  return output;
}


/************************************************************
 FALLBACK OPENING
************************************************************/

function fallbackOpening_(
  openingCandidates
) {

  const picks =
    (openingCandidates || [])
      .slice(0, 2);


  if (!picks.length) {

    return (
      "<p>No single macro catalyst stood out clearly " +
      "from the available market-news feed today.</p>"
    );
  }


  const links =
    picks.map(
      (story, index) => (
        `<a href="${escapeHtml_(story.url)}">` +
        `${escapeHtml_(fallbackAnchor_(story.headline))}` +
        "</a>"
      )
    );


  return (
    "<p>The broader market backdrop is being shaped principally by " +
    links.join(" and ") +
    ". Those forces are likely to be more useful for interpreting " +
    "today's portfolio moves than treating every ticker move as an " +
    "isolated company event.</p>"
  );
}


function fallbackAnchor_(headline) {

  const h =
    normHeadline_(headline);


  if (
    h.includes("yield")
  ) {
    return "the move in bond yields";
  }


  if (
    h.includes("inflation") ||
    h.includes("cpi")
  ) {
    return "the inflation backdrop";
  }


  if (
    h.includes("fed") ||
    h.includes("interest rate")
  ) {
    return "the rate outlook";
  }


  if (
    h.includes("oil") ||
    h.includes("brent") ||
    h.includes("wti")
  ) {
    return "the move in oil";
  }


  if (
    h.includes("chip") ||
    h.includes("semiconductor")
  ) {
    return "the semiconductor move";
  }


  if (
    h.includes("tariff") ||
    h.includes("trade")
  ) {
    return "trade-policy developments";
  }


  if (
    h.includes("nasdaq") ||
    h.includes("sp 500") ||
    h.includes("dow") ||
    h.includes("futures")
  ) {
    return "the broader equity move";
  }


  return truncate_(
    headline,
    38
  );
}


/************************************************************
 BUILD REASON CELL
************************************************************/

function buildReasonCell_(
  holding
) {

  const data =
    holding.reasonData || {
      reason: "N/A",
      source: null
    };


  if (
    !data.reason ||
    data.reason === "N/A"
  ) {

    return (
      '<td class="reason">' +
      '<span class="muted">N/A</span>' +
      "</td>"
    );
  }


  const sourceLink =
    data.source?.url
      ? (
          ` <a class="source-link" ` +
          `href="${escapeHtml_(data.source.url)}">source</a>`
        )
      : "";


  return (
    '<td class="reason">' +
    escapeHtml_(
      data.reason
    ) +
    sourceLink +
    "</td>"
  );
}


/************************************************************
 STOCK TABLE
************************************************************/

function buildStockTable_(
  rows
) {

  if (!rows.length) {

    return (
      '<p class="muted">No qualifying holdings in this section today.</p>'
    );
  }


  const body =
    rows.map(
      holding => `

<tr>
  <td><b>${escapeHtml_(holding.ticker)}</b></td>
  <td>${escapeHtml_(holding.name)}</td>
  <td class="num">${escapeHtml_(formatPrice_(holding))}</td>
  <td class="num">${changeSpan_(holding.change)}</td>
  ${buildReasonCell_(holding)}
</tr>

`
    ).join("");


  return `

<table>
  <thead>
    <tr>
      <th>Symbol</th>
      <th>Company</th>
      <th class="num">Price</th>
      <th class="num">Change</th>
      <th>Reason</th>
    </tr>
  </thead>

  <tbody>
    ${body}
  </tbody>
</table>

`;
}


/************************************************************
 ETF / FUND TABLE
************************************************************/

function buildFundTable_(
  rows
) {

  if (!rows.length) {

    return (
      '<p class="muted">No ETF or fund holdings found.</p>'
    );
  }


  const body =
    rows.map(
      holding => `

<tr>
  <td><b>${escapeHtml_(holding.ticker)}</b></td>
  <td>${escapeHtml_(holding.name)}</td>
  <td class="num">${escapeHtml_(formatPrice_(holding))}</td>
  <td class="num">${changeSpan_(holding.change)}</td>
</tr>

`
    ).join("");


  return `

<table>
  <thead>
    <tr>
      <th>Symbol</th>
      <th>Holding</th>
      <th class="num">Price</th>
      <th class="num">Change</th>
    </tr>
  </thead>

  <tbody>
    ${body}
  </tbody>
</table>

`;
}


/************************************************************
 RELATED NEWS
************************************************************/

function buildRelatedNews_(
  openingCandidates,
  holdings,
  candidateMap
) {

  let stories = [];


  // Macro / sector stories first.
  stories.push(
    ...(
      openingCandidates || []
    ).slice(0, 6)
  );


  // Then company stories.
  for (const holding of holdings) {

    const candidates =
      candidateMap[
        holding.ticker
      ] || [];


    for (
      const story of
      candidates.slice(0, 2)
    ) {

      stories.push({
        ...story,
        ticker:
          holding.ticker
      });
    }
  }


  stories =
    dedupeNews_(stories)
      .slice(0, 16);


  return stories
    .map(
      story => `

<li>
  <a href="${escapeHtml_(story.url)}">
    ${escapeHtml_(story.headline)}
  </a>
  <span class="muted">
    (${escapeHtml_(story.ticker || "MARKET")})
  </span>
</li>

`
    )
    .join("");
}


/************************************************************
 DAILY SUMMARY
************************************************************/

function dailySummary() {

  FINNHUB_STOP_CALLS_ = false;


  /********************************************************
   1. READ THE GOOGLE SHEET

   NOTE:
   D is correctly treated as HEADLINES.
   It is NOT quantity.
  ********************************************************/

  const sheet =
    SpreadsheetApp
      .getActiveSpreadsheet()
      .getActiveSheet();


  const lastRow =
    sheet.getLastRow();


  if (lastRow < 2) {
    return;
  }


  const rows =
    sheet
      .getRange(
        "A2:E" +
        lastRow
      )
      .getValues();


  const holdings = [];


  for (const row of rows) {

    const [
      tickerRaw,
      priceRaw,
      changeRaw,
      headlinesRaw,
      nameRaw
    ] = row;


    if (!tickerRaw) {
      continue;
    }


    const ticker =
      String(tickerRaw)
        .trim()
        .toUpperCase();


    const price =
      Number(priceRaw);


    if (isNaN(price)) {
      continue;
    }


    let change = null;


    if (
      changeRaw !== "" &&
      changeRaw !== null &&
      changeRaw !== undefined
    ) {

      const parsedChange =
        Number(changeRaw);


      if (!isNaN(parsedChange)) {
        change =
          parsedChange;
      }
    }


    const name =
      String(
        nameRaw ||
        ticker
      ).trim();


    holdings.push({

      ticker:
        ticker,

      price:
        price,

      change:
        change,

      headlines:
        String(
          headlinesRaw || ""
        ),

      name:
        name,

      isFund:
        isFundLike_(
          name
        )

    });
  }


  /********************************************************
   2. SPLIT INDIVIDUAL STOCKS VS FUNDS

   No tickers are hard-coded.
  ********************************************************/

  const stocks =
    holdings.filter(
      holding =>
        !holding.isFund
    );


  const funds =
    holdings.filter(
      holding =>
        holding.isFund
    );


  /********************************************************
   3. FIND TOP MOVERS / DECLINERS

   Funds are excluded because they already have their own
   section.
  ********************************************************/

  const stocksWithChange =
    stocks.filter(
      holding =>
        holding.change !== null &&
        !isNaN(
          holding.change
        )
    );


  const topMoversBase =
    stocksWithChange
      .filter(
        holding =>
          holding.change > 0
      )
      .sort(
        (a, b) =>
          b.change -
          a.change
      )
      .slice(0, 8);


  const declinesBase =
    stocksWithChange
      .filter(
        holding =>
          holding.change < 0
      )
      .sort(
        (a, b) =>
          a.change -
          b.change
      )
      .slice(0, 8);


  const stocksNeedingReasons =
    [
      ...topMoversBase,
      ...declinesBase
    ];


  /********************************************************
   4. FETCH NEWS FOR MOVERS

   Finnhub + Google News are combined.
  ********************************************************/

  const candidateMap = {};


  for (
    const holding of
    stocksNeedingReasons
  ) {

    candidateMap[
      holding.ticker
    ] =
      collectReasonCandidates_(
        holding
      );
  }


  /********************************************************
   5. AI-GENERATED SPECIFIC REASONS
  ********************************************************/

  const reasonMap =
    analyseReasons_(
      stocksNeedingReasons,
      candidateMap
    );


  function attachReason(
    holding
  ) {

    let reasonData =
      reasonMap[
        holding.ticker
      ];


    if (!reasonData) {

      reasonData =
        fallbackReason_(
          holding,
          candidateMap[
            holding.ticker
          ] || []
        );
    }


    return {
      ...holding,
      reasonData:
        reasonData
    };
  }


  const topMovers =
    topMoversBase.map(
      attachReason
    );


  const declines =
    declinesBase.map(
      attachReason
    );


  /********************************************************
   6. SORT FUNDS BY ABSOLUTE DAILY MOVE
  ********************************************************/

  const sortedFunds =
    funds
      .filter(
        holding =>
          holding.change !== null
      )
      .sort(
        (a, b) =>
          Math.abs(
            b.change
          ) -
          Math.abs(
            a.change
          )
      );


  /********************************************************
   7. FETCH TRUE MACRO / SECTOR NEWS
  ********************************************************/

  const macroPool =
    fetchMacroRssNews_();


  const openingCandidates =
    pickOpeningCandidates_(
      macroPool
    );


  /********************************************************
   8. GENERATE ANALYTICAL COMMENTARY
  ********************************************************/

  const commentary =
    geminiJson_(
      buildCommentaryPrompt_(
        openingCandidates,
        topMovers,
        declines,
        sortedFunds
      )
    ) || {};


  let opening =
    commentary
      .opening_overview_html ||
    fallbackOpening_(
      openingCandidates
    );


  let moversComment =
    commentary
      .top_movers_commentary_html ||
    (
      "<p>The available company news does not support " +
      "a sufficiently strong common explanation for today's " +
      "largest gains.</p>"
    );


  let sectorComment =
    commentary
      .sector_highlights_html ||
    (
      "<p>No single sector narrative was sufficiently dominant " +
      "in the available market-news feed to justify a stronger " +
      "conclusion today.</p>"
    );


  let declinesComment =
    commentary
      .notable_declines_commentary_html ||
    (
      "<p>The weaker holdings did not share a sufficiently clear " +
      "common catalyst in the available news feed.</p>"
    );


  let fundsComment =
    commentary
      .etfs_commentary_html ||
    (
      "<p>The fund moves provide a useful read on sector " +
      "leadership, but no additional dominant theme was identified.</p>"
    );


  /********************************************************
   9. CONVERT SHORT LINK PLACEHOLDERS TO REAL LINKS
  ********************************************************/

  opening =
    renderMacroLinks_(
      opening,
      openingCandidates
    );


  moversComment =
    renderMacroLinks_(
      moversComment,
      openingCandidates
    );


  sectorComment =
    renderMacroLinks_(
      sectorComment,
      openingCandidates
    );


  declinesComment =
    renderMacroLinks_(
      declinesComment,
      openingCandidates
    );


  fundsComment =
    renderMacroLinks_(
      fundsComment,
      openingCandidates
    );


  /********************************************************
   10. REMEMBER STORIES ACTUALLY USED IN OPENING
  ********************************************************/

  let usedStories =
    openingStoriesFromIds_(
      commentary
        .opening_used_ids ||
      [],
      openingCandidates
    );


  if (!usedStories.length) {

    usedStories =
      openingCandidates
        .slice(0, 2);
  }


  recordOpeningStories_(
    usedStories
  );


  /********************************************************
   11. TABLES
  ********************************************************/

  const moversTable =
    buildStockTable_(
      topMovers
    );


  const declinesTable =
    buildStockTable_(
      declines
    );


  const fundsTable =
    buildFundTable_(
      sortedFunds
    );


  /********************************************************
   12. RELATED NEWS
  ********************************************************/

  const relatedLinks =
    buildRelatedNews_(
      openingCandidates,
      stocksNeedingReasons,
      candidateMap
    );


  /********************************************************
   13. DATE
  ********************************************************/

  const dateStr =
    Utilities.formatDate(
      new Date(),
      "Europe/London",
      "EEE dd MMM yyyy"
    );


  const year =
    Utilities.formatDate(
      new Date(),
      "Europe/London",
      "yyyy"
    );


  /********************************************************
   14. FINAL EMAIL HTML
  ********************************************************/

  const finalHtml = `

<div class="digest">

<style>

.digest {
  font-family:
    Georgia,
    "Times New Roman",
    Times,
    serif;
  font-size: 18px;
  line-height: 1.58;
  color: #111;
  max-width: 1100px;
}

h1 {
  font-size: 28px;
  margin: 0 0 5px 0;
}

h2 {
  font-size: 23px;
  margin: 28px 0 12px 0;
}

p {
  font-size: 18px;
  line-height: 1.6;
  margin: 8px 0 16px 0;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 17px;
  margin: 12px 0 14px 0;
}

th,
td {
  border: 1px solid #ddd;
  padding: 10px;
  vertical-align: top;
}

th {
  background: #f6f6f6;
  font-weight: 700;
}

.num {
  text-align: right;
  white-space: nowrap;
}

.reason {
  min-width: 250px;
}

.pos {
  color: #17783b;
  font-weight: 700;
}

.neg {
  color: #c62828;
  font-weight: 700;
}

.flat {
  color: #555;
  font-weight: 600;
}

.muted {
  color: #777;
  font-size: 15px;
}

a {
  color: #0b57d0;
}

.source-link {
  font-size: 14px;
  white-space: nowrap;
  margin-left: 4px;
}

ul {
  padding-left: 22px;
}

li {
  margin-bottom: 7px;
  font-size: 16px;
}

.footer {
  margin-top: 28px;
  padding-top: 14px;
  border-top: 1px solid #ddd;
  color: #666;
}

.footer p {
  font-size: 14px;
  margin: 5px 0;
}

</style>


<h1>
Daily Portfolio Digest
</h1>

<div class="muted">
${escapeHtml_(dateStr)}
</div>


<h2>
Opening Overview
</h2>

${opening}


<h2>
Top Movers
</h2>

${moversTable}

${moversComment}


<h2>
Sector Highlights
</h2>

${sectorComment}


<h2>
Notable Declines
</h2>

${declinesTable}

${declinesComment}


<h2>
ETFs &amp; Other Holdings
</h2>

${fundsTable}

${fundsComment}


<h2>
Related News &amp; Sources
</h2>

<ul>
${relatedLinks}
</ul>


<div class="footer">

<p>
This email was generated on ${escapeHtml_(dateStr)}.
</p>

<p>
Market commentary is generated from the available market and
company-news feeds and may not identify every cause of a price move.
</p>

<p>
All data is for informational purposes only and not intended
as financial advice.
</p>

<p>
© ${year} Your Portfolio Analyst
</p>

</div>

</div>

`;


  /********************************************************
   15. SEND EMAIL
  ********************************************************/

  MailApp.sendEmail({

    to:
      EMAIL,

    subject:
      "📊 Daily Portfolio Digest",

    body:
      "Your email client does not support HTML.",

    htmlBody:
      finalHtml

  });
}


/************************************************************
 TRIGGERS (~08:07)
************************************************************/

function deleteExistingDailyTriggers_() {

  ScriptApp
    .getProjectTriggers()
    .forEach(
      trigger => {

        if (
          trigger
            .getHandlerFunction() ===
          "dailySummary"
        ) {

          ScriptApp.deleteTrigger(
            trigger
          );
        }
      }
    );
}


function createDailyTrigger() {

  deleteExistingDailyTriggers_();


  ScriptApp
    .newTrigger(
      "dailySummary"
    )
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(7)
    .create();
}

// ============================================================
// bot.js
//
// NO CHROME / NO PUPPETEER  -  Pure Node fetch
//
// FLOW (S/SYMBOL):
//   1. NSE exact try (series: EQ, BE, BZ, SM, ST)
//   2. NSE me nahi -> NSE globalSearch (partial suggestions)
//        - results -> inline buttons (symbol + series)
//          click -> us symbol+series ka NSE data
//   3. globalSearch bhi khali -> BSE CSV search (TckrSymb)
//        - 1 match  -> BSE data
//        - multi    -> BSE inline buttons
//   4. kuch nahi -> NOT FOUND
//
// Install:
//   npm install node-telegram-bot-api dotenv
//   (Node 18+ built-in fetch)
//
// Same folder:
//   bot.js
//   .env
//   APPROVED.csv
//
// BSE ab CSV se nahi, live search API se (koi file nahi chahiye)
// ============================================================

require("dotenv").config({ quiet: true });

const TelegramBotModule = require("node-telegram-bot-api");
const TelegramBot =
  TelegramBotModule.default || TelegramBotModule;

const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

// Admin ko sab kuch forward hoga (incoming msg + bot reply)
const ADMIN_CHAT_ID = 8388096561;

// block mode: true = sirf admin, false = sabko allow
let blockMode = false;

// ---- BLOCKED IDs (permanent, blocked.json me) ----
const BLOCKED_FILE = path.join(__dirname, "blocked.json");

// Set of blocked chat IDs (string)
let blockedIds = new Set();

// blocked.json load karo (startup par)
function loadBlockedIds() {
  try {
    if (fs.existsSync(BLOCKED_FILE)) {
      const raw = fs.readFileSync(BLOCKED_FILE, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        blockedIds = new Set(arr.map((x) => String(x)));
      }
    }
  } catch (e) {
    console.log(`[BLOCKED] load fail: ${e.message}`);
  }

  console.log(
    `[BLOCKED] loaded ${blockedIds.size} id(s)`
  );
}

// blocked.json save + GitHub pe commit (permanent)
function saveBlockedIds() {
  try {
    fs.writeFileSync(
      BLOCKED_FILE,
      JSON.stringify([...blockedIds], null, 2),
      "utf8"
    );
  } catch (e) {
    console.log(`[BLOCKED] save fail: ${e.message}`);
    return;
  }

  // GitHub Actions me file permanent karne ke liye git commit
  gitCommitBlocked();
}

// git add + commit + push (GitHub Actions par)
function gitCommitBlocked() {
  const { exec } = require("child_process");

  const cmd =
    'git add blocked.json && ' +
    'git -c user.name="bot" -c user.email="bot@bot" ' +
    'commit -m "update blocked list" && git push';

  exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      // nothing-to-commit ya push fail -> log only
      console.log(
        `[GIT] ${(stderr || err.message || "").trim()}`
      );
    } else {
      console.log("[GIT] blocked.json pushed");
    }
  });
}

// polling error state (baar-baar spam na ho)
let lastPollErrorMsg = "";   // aakhri error jo admin ko bheja
let pollErrorActive = false;  // abhi error chal raha hai?
let lastPollOkTime = Date.now();

const BULK_DEAL_PERCENT =
  0.49;

// NSE exact-try series order
const SERIES_LIST = [
  "EQ",
  "BE",
  "BZ",
  "SM",
  "ST",
];


const MAX_SUGGESTIONS = 8;

if (!BOT_TOKEN) {
  console.error(
    "ERROR: TELEGRAM_BOT_TOKEN .env me nahi mila."
  );

  process.exit(1);
}

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new TelegramBot(
  BOT_TOKEN,
  {
    polling: true,
  }
);

// ============================================================
// GLOBALS
// ============================================================

let requestQueue =
  Promise.resolve();

let cookieJar = "";
let cookieTime = 0;

// ---- NSE throttle control ----
// har NSE request ke beech min gap
const NSE_MIN_GAP_MS = 800;
let nseLastCall = 0;

// 403/abort ke baad NSE ko rest (cooldown)
const NSE_COOLDOWN_MS = 30000;
let nseCooldownUntil = 0;

// NSE abhi cooldown me hai?
function nseInCooldown() {
  return Date.now() < nseCooldownUntil;
}

// NSE ko cooldown me daalo
function triggerNseCooldown() {
  nseCooldownUntil = Date.now() + NSE_COOLDOWN_MS;
  console.log(
    `[NSE] cooldown ${NSE_COOLDOWN_MS / 1000}s (BSE-only)`
  );
}

// NSE call se pehle gap ka wait
async function nseGate() {
  const now = Date.now();
  const wait = NSE_MIN_GAP_MS - (now - nseLastCall);

  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }

  nseLastCall = Date.now();
}


// duplicate request guard: "chatId:SYMBOL" -> timestamp
const recentRequests = new Map();

// callback_data 64-char limit se bachne ke liye:
// suggestion token -> {symbol, series, scripCode, exchange}
const callbackStore = new Map();
let callbackСounter = 0;

// common browser fingerprint (NSE inhe check karta hai)
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "sec-ch-ua":
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  Connection: "keep-alive",
};

// API calls ke liye
const BROWSER_HEADERS = {
  ...COMMON_HEADERS,
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

// homepage / get-quotes page ke liye (warmup)
const PAGE_HEADERS = {
  ...COMMON_HEADERS,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const BSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bseindia.com/",
  Origin: "https://www.bseindia.com",
};

// fetch with timeout (hang se bachne ke liye)
// default 12 sec. Timeout par error throw hoga.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// ADMIN FORWARD
// ============================================================

async function notifyAdmin(text, options = {}) {
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text, options);
  } catch (e) {
    console.log(`[ADMIN] forward fail: ${e.message}`);
  }
}

async function forwardIncomingToAdmin(msg, requestedSymbol) {
  if (String(msg.chat.id) === String(ADMIN_CHAT_ID)) {
    return;
  }

  const from = msg.from || {};

  const name = [from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");

  const username = from.username
    ? "@" + from.username
    : "(no username)";

  const info =
    `📨 <b>NEW REQUEST</b>\n\n` +
    `<b>Name:</b> ${escapeHtml(name || "-")}\n` +
    `<b>Username:</b> ${escapeHtml(username)}\n` +
    `<b>User ID:</b> ${escapeHtml(String(from.id || "-"))}\n` +
    `<b>Chat type:</b> ${escapeHtml(msg.chat.type)}\n` +
    `<b>Chat ID:</b> ${escapeHtml(String(msg.chat.id))}\n\n` +
    `<b>Message:</b> ${escapeHtml(msg.text || "")}\n` +
    `<b>Symbol:</b> ${escapeHtml(requestedSymbol || "-")}`;

  await notifyAdmin(info, { parse_mode: "HTML" });
}

async function forwardReplyToAdmin(replyText, requestedSymbol) {
  const header =
    `↩️ <b>BOT REPLY</b> (${escapeHtml(
      requestedSymbol || "-"
    )})\n\n`;

  await notifyAdmin(header + replyText, {
    parse_mode: "HTML",
  });
}

// user/group ko diye gaye reply ko 20 min baad delete karo
const DELETE_AFTER_MS = 10 * 60 * 1000; // 20 minute

function scheduleDelete(chatId, messageId) {
  if (!messageId) return;

  setTimeout(() => {
    bot
      .deleteMessage(chatId, messageId)
      .catch((e) => {
        // 48h se purana ya already deleted -> ignore
        console.log(`[DELETE] skip: ${e.message}`);
      });
  }, DELETE_AFTER_MS);
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatIndianNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "N/A";
  }

  return number.toLocaleString(
    "en-IN",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  );
}

function cleanNumber(value) {
  const number = Number(
    String(value || "")
      .replace(/,/g, "")
      .trim()
  );

  return Number.isFinite(number)
    ? number
    : null;
}

// token banane ke liye
function makeToken(payload) {
  callbackСounter = (callbackСounter + 1) % 1000000;

  const token = "t" + callbackСounter;

  callbackStore.set(token, payload);

  // memory safe: 2000 se zyada purane hata do
  if (callbackStore.size > 2000) {
    const firstKey = callbackStore.keys().next().value;
    callbackStore.delete(firstKey);
  }

  return token;
}

// ============================================================
// CSV PARSER (APPROVED.csv)
// ============================================================

function parseCsvLine(line, separator) {
  const values = [];

  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === separator && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current.trim());

  return values;
}

// ============================================================
// APPROVED.csv CHECK
// ============================================================

function checkApproval(searchSymbol, searchIsin) {
  const csvPath = path.join(__dirname, "APPROVED.csv");

  if (!fs.existsSync(csvPath)) {
    return { status: "UNAPPROVED", matchedBy: "NONE" };
  }

  let content;

  try {
    content = fs.readFileSync(csvPath, "utf8");
  } catch (_) {
    return { status: "UNAPPROVED", matchedBy: "NONE" };
  }

  content = content.replace(/^\uFEFF/, "");

  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 2) {
    return { status: "UNAPPROVED", matchedBy: "NONE" };
  }

  const headerLine = lines[0];

  let separator = ",";

  if (headerLine.includes("\t")) {
    separator = "\t";
  } else if (headerLine.includes(";")) {
    separator = ";";
  }

  const headers = parseCsvLine(headerLine, separator).map(
    (header) =>
      String(header).replace(/"/g, "").trim().toUpperCase()
  );

  const symbolIndex = headers.findIndex(
    (header) => header === "SYMBOL"
  );

  const isinIndex = headers.findIndex(
    (header) => header === "ISIN"
  );

  if (symbolIndex === -1 && isinIndex === -1) {
    return { status: "UNAPPROVED", matchedBy: "NONE" };
  }

  const targetSymbol = String(searchSymbol || "")
    .trim()
    .toUpperCase();

  const targetIsin = String(searchIsin || "")
    .trim()
    .toUpperCase();

  for (let i = 1; i < lines.length; i++) {
    const columns = parseCsvLine(lines[i], separator);

    const csvSymbol =
      symbolIndex >= 0
        ? String(columns[symbolIndex] || "")
            .replace(/"/g, "")
            .trim()
            .toUpperCase()
        : "";

    const csvIsin =
      isinIndex >= 0
        ? String(columns[isinIndex] || "")
            .replace(/"/g, "")
            .trim()
            .toUpperCase()
        : "";

    const symbolMatched =
      targetSymbol !== "" &&
      csvSymbol !== "" &&
      targetSymbol === csvSymbol;

    const isinMatched =
      targetIsin !== "" &&
      targetIsin !== "N/A" &&
      csvIsin !== "" &&
      targetIsin === csvIsin;

    if (symbolMatched || isinMatched) {
      let matchedBy = "NONE";

      if (symbolMatched && isinMatched) {
        matchedBy = "SYMBOL + ISIN";
      } else if (symbolMatched) {
        matchedBy = "SYMBOL";
      } else {
        matchedBy = "ISIN";
      }

      return { status: "APPROVED", matchedBy };
    }
  }

  return { status: "UNAPPROVED", matchedBy: "NONE" };
}

// ============================================================
// BSE LIVE SEARCH  (CSV ki jagah)
//
// API: GetQuoteAllSearchDatabeta
//   symbol/name -> scripcode + isin + name
//
// Sirf "Equity T+1" (normal, bina '#') rakhte hain.
// ============================================================

function normalizeBseSearch(json) {
  let list = [];

  if (Array.isArray(json)) {
    list = json;
  } else if (json && Array.isArray(json.Table)) {
    list = json.Table;
  } else if (json && Array.isArray(json.data)) {
    list = json.data;
  }

  return list
    .map((r) => ({
      scripCode: String(r.strSricpCode || "").trim(),
      symbol: String(r.shortName || "")
        .trim()
        .toUpperCase(),
      name: String(r.scripName || "").trim(),
      isin: String(r.Isin || "").trim().toUpperCase(),
      type: String(r.Type || "").trim(),
    }))
    // sirf Equity (T+1). Debt/Derivatives/MF hatao.
    // '#' (T+0) wale bhi hatao.
    .filter(
      (r) =>
        /equity/i.test(r.type) &&
        !r.symbol.includes("#") &&
        r.scripCode &&
        r.symbol
    );
}

// BSE search API call (retry ke saath)
async function bseSearchApi(query) {
  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/GetQuoteAllSearchDatabeta/w" +
    "?searchString=" +
    encodeURIComponent(query);

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: BSE_HEADERS },
      8000
    );

    if (!res.ok) {
      return null;
    }

    const json = await res.json();

    return normalizeBseSearch(json);
  } catch (_) {
    return null;
  }
}

// symbol search -> exact / partial
async function searchBseSymbol(query) {
  const q = String(query || "").trim().toUpperCase();

  if (!q) {
    return { type: "none", matches: [] };
  }

  const list = await bseSearchApi(q);

  if (list === null) {
    console.log(`[BSE] search "${q}" API fail/block`);
    return { type: "none", matches: [] };
  }

  console.log(
    `[BSE] search "${q}" -> ${list.length} equity results`
  );

  if (list.length === 0) {
    return { type: "none", matches: [] };
  }

  // duplicate symbol hata do (same shortName)
  const seen = new Set();
  const rows = [];

  for (const r of list) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    rows.push(r);
  }

  // EXACT symbol match
  const exact = rows.filter((r) => r.symbol === q);

  if (exact.length) {
    console.log(
      `[BSE] "${q}" EXACT found: scrip ${exact[0].scripCode}`
    );
    return { type: "exact", matches: exact };
  }

  console.log(
    `[BSE] "${q}" no exact. Symbols: ${rows
      .slice(0, 10)
      .map((r) => r.symbol)
      .join(", ")}`
  );

  // startsWith
  const starts = rows.filter((r) =>
    r.symbol.startsWith(q)
  );

  if (starts.length) {
    return {
      type: "partial",
      matches: starts
        .sort((a, b) => a.symbol.length - b.symbol.length)
        .slice(0, MAX_SUGGESTIONS),
    };
  }

  // contains (jo bhi API ne diya)
  return {
    type: "partial",
    matches: rows
      .sort((a, b) => a.symbol.length - b.symbol.length)
      .slice(0, MAX_SUGGESTIONS),
  };
}

// ============================================================
// NSE COOKIES
// ============================================================

function saveCookies(response) {
  let setCookies = [];

  try {
    if (typeof response.headers.getSetCookie === "function") {
      setCookies = response.headers.getSetCookie();
    } else {
      const raw = response.headers.get("set-cookie");
      if (raw) setCookies = [raw];
    }
  } catch (_) {}

  if (setCookies.length) {
    // purani + nayi cookies merge (overwrite nahi)
    const jar = {};

    cookieJar.split("; ").forEach((c) => {
      const eq = c.indexOf("=");
      if (eq > 0) jar[c.slice(0, eq)] = c.slice(eq + 1);
    });

    setCookies.forEach((c) => {
      const first = c.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) {
        jar[first.slice(0, eq)] = first.slice(eq + 1);
      }
    });

    cookieJar = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    cookieTime = Date.now();
  }
}

async function ensureNseCookies(force = false) {
  const age = Date.now() - cookieTime;

  // 4 min cache
  if (!force && cookieJar && age < 4 * 60 * 1000) {
    return;
  }

  console.log("[NSE] Cookies laa rahe hain (warmup)...");

  let homeStatus = 0;

  // 1. homepage
  try {
    let res = await fetchWithTimeout(
      "https://www.nseindia.com",
      { headers: PAGE_HEADERS },
      8000
    );

    saveCookies(res);
    homeStatus = res.status;

    await sleep(250);

    // 2. get-quotes page (API unlock ke liye zyada cookies)
    res = await fetchWithTimeout(
      "https://www.nseindia.com/get-quotes/equity?symbol=SBIN",
      {
        headers: {
          ...PAGE_HEADERS,
          Referer: "https://www.nseindia.com/",
          "Sec-Fetch-Site": "same-origin",
        },
      },
      8000
    );

    saveCookies(res);
  } catch (e) {
    console.log(
      `[NSE] warmup error: ${e.message}`
    );
  }

  console.log(
    `[NSE] Homepage ${homeStatus}, cookies: ${
      cookieJar ? "OK" : "FAIL"
    }`
  );
}

// ============================================================
// NSE: globalSearch (partial suggestions)
// ============================================================

// ek single query ka search
async function globalSearchOnce(query) {
  const url =
    "https://www.nseindia.com/api/NextApi/globalSearch/equity?symbol=" +
    encodeURIComponent(query);

  async function callApi() {
    return fetchWithTimeout(
      url,
      {
        headers: {
          ...BROWSER_HEADERS,
          Cookie: cookieJar,
          Referer:
            "https://www.nseindia.com/get-quotes/equity",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
      },
      15000
    );
  }

  let res;

  try {
    await ensureNseCookies();
    await nseGate();

    res = await callApi();

    if (res.status === 401 || res.status === 403) {
      triggerNseCooldown();
      await ensureNseCookies(true);
      await nseGate();
      res = await callApi();
    }
  } catch (e) {
    // abort/block -> cooldown + fresh cookie retry
    console.log(
      `[NSE] globalSearch "${query}" ${e.message} -> retry`
    );

    triggerNseCooldown();

    try {
      await ensureNseCookies(true);
      await nseGate();
      res = await callApi();
    } catch (e2) {
      console.log(
        `[NSE] globalSearch "${query}" retry fail: ${e2.message}`
      );
      return null;
    }
  }

  if (!res.ok) {
    return null; // null = error/block
  }

  let json;

  try {
    json = await res.json();
  } catch (_) {
    return null;
  }

  const list = Array.isArray(json.data) ? json.data : [];

  return list
    .filter((r) => r.symbol && r.series)
    .map((r) => ({
      symbol: String(r.symbol).toUpperCase(),
      series: String(r.series).toUpperCase(),
      company: r.companyName || "",
    }));
}

// progressive-shorten retry:
//   poore query par khali aaye to query chhoti karke try,
//   jab tak result na mile (min 3 chars).
async function nseGlobalSearch(query) {
  const original = String(query || "")
    .trim()
    .toUpperCase();

  // pehli try - poora query
  let results = await globalSearchOnce(original);

  if (results === null) {
    console.log(
      `[NSE] globalSearch "${original}" blocked/error`
    );
    return [];
  }

  if (results.length > 0) {
    return results.slice(0, MAX_SUGGESTIONS);
  }

  // khali -> max 2 aur try, thoda-thoda chhota karke
  // (char-by-char nahi taaki fail jaldi aaye)
  if (original.length >= 5) {
    const tries = [
      original.slice(0, Math.max(4, original.length - 2)),
      original.slice(0, 3),
    ];

    for (const q of tries) {
      if (q === original) continue;

      await sleep(80);

      results = await globalSearchOnce(q);

      if (results === null) return [];

      if (results.length > 0) {
        console.log(
          `[NSE] "${original}" empty -> "${q}" par ${results.length}`
        );
        return results.slice(0, MAX_SUGGESTIONS);
      }
    }
  }

  return [];
}

// ============================================================
// NSE: fetch one series
// ============================================================

async function fetchNseSeries(upperSymbol, series) {
  const url =
    "https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi" +
    "?functionName=getSymbolData" +
    "&marketType=N" +
    "&series=" +
    encodeURIComponent(series) +
    "&symbol=" +
    encodeURIComponent(upperSymbol);

  async function callApi() {
    return fetchWithTimeout(
      url,
      {
        headers: {
          ...BROWSER_HEADERS,
          Cookie: cookieJar,
          Referer:
            "https://www.nseindia.com/get-quotes/equity?symbol=" +
            encodeURIComponent(upperSymbol),
        },
      },
      12000
    );
  }

  let res;

  try {
    await ensureNseCookies();
    await nseGate();

    res = await callApi();

    if (res.status === 401 || res.status === 403) {
      triggerNseCooldown();
      await ensureNseCookies(true);
      await nseGate();
      res = await callApi();
    }
  } catch (e) {
    // abort/timeout -> cooldown + fresh cookie retry
    console.log(
      `[NSE] getQuote "${upperSymbol}" ${e.message} -> retry`
    );

    triggerNseCooldown();

    try {
      await ensureNseCookies(true);
      await nseGate();
      res = await callApi();
    } catch (e2) {
      console.log(
        `[NSE] getQuote "${upperSymbol}" retry fail (throttled)`
      );
      return "ABORTED";
    }
  }

  if (!res.ok) {
    return null;
  }

  let root;

  try {
    root = await res.json();
  } catch (_) {
    return null;
  }

  const entry =
    Array.isArray(root.equityResponse) &&
    root.equityResponse.length
      ? root.equityResponse[0]
      : null;

  if (!entry || !entry.metaData) {
    return null;
  }

  return entry;
}

// ============================================================
// NSE: parse entry -> data object
// ============================================================

function parseNseEntry(entry, upperSymbol, foundSeries) {
  const meta = entry.metaData || {};
  const trade = entry.tradeInfo || {};
  const sec = entry.secInfo || {};

  const isin = meta.isinCode || "N/A";
  const company = meta.companyName || "N/A";

  if (isin === "N/A") {
    return null;
  }

  const ltpNum =
    Number(trade.lastPrice) > 0
      ? Number(trade.lastPrice)
      : Number(meta.lastPrice) > 0
      ? Number(meta.lastPrice)
      : null;

  const ltp = ltpNum !== null ? String(ltpNum) : "N/A";

  const prevCloseNum = Number(meta.previousClose);

  const prevClose =
    Number.isFinite(prevCloseNum) && prevCloseNum > 0
      ? String(prevCloseNum)
      : "N/A";

  let marketCap = "N/A";

  const totalMcap = Number(trade.totalMarketCap);

  if (Number.isFinite(totalMcap) && totalMcap > 0) {
    marketCap = (totalMcap / 1e7).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  let securityVar = "N/A";

  const secVarNum = cleanNumber(sec.securityvar);
  const varMarginNum = cleanNumber(sec.varMargin);

  if (secVarNum !== null && secVarNum > 0) {
    securityVar = String(sec.securityvar);
  } else if (varMarginNum !== null && varMarginNum > 0) {
    securityVar = String(sec.varMargin);
  } else if (secVarNum !== null) {
    securityVar = String(sec.securityvar);
  }

  const applicableMarginRate =
    trade.applicableMargin != null
      ? String(trade.applicableMargin)
      : sec.applicableMargin != null
      ? String(sec.applicableMargin)
      : "N/A";

  let bulkDeal = null;

  const marketCapNumber = cleanNumber(marketCap);

  if (marketCapNumber !== null) {
    bulkDeal =
      marketCapNumber * (BULK_DEAL_PERCENT / 100);
  }

  const approval = checkApproval(
    meta.symbol || upperSymbol,
    isin
  );

  // STATUS: suspended hai ya active
  const suspFlag = String(sec.isSuspended || "").toLowerCase();
  const secStatus = String(sec.secStatus || "").toLowerCase();

  const isSuspended =
    suspFlag.includes("suspend") ||
    secStatus.includes("suspend");

  const status = isSuspended
    ? `⛔ SUSPENDED${
        sec.secStatus ? " (" + sec.secStatus + ")" : ""
      }`
    : "✅ ACTIVE";

  return {
    exchange: "NSE",
    series: foundSeries || trade.series || meta.series || "-",
    symbol: meta.symbol || upperSymbol,
    company,
    isin,
    ltp,
    prevClose,
    marketCap,
    securityVar,
    applicableMarginRate,
    bulkDeal,
    approval,
    status,
    isSuspended,
  };
}

// ============================================================
// NSE: exact data (sab series try)
// ============================================================

async function getNseData(symbol) {
  const upperSymbol = String(symbol || "")
    .trim()
    .toUpperCase();

  console.log(`[NSE] exact fetch ${upperSymbol}`);

  for (const series of SERIES_LIST) {
    const entry = await fetchNseSeries(upperSymbol, series);

    if (entry === "ABORTED") {
      return null;
    }

    if (entry) {
      const data = parseNseEntry(
        entry,
        upperSymbol,
        series
      );

      if (data) {
        console.log(
          `[NSE] ${upperSymbol} done (${series})`
        );

        return data;
      }
    }
  }

  return null;
}

// ============================================================
// NSE: fetch by symbol + KNOWN series (button click)
// ============================================================

async function getNseDataBySeries(symbol, series) {
  const upperSymbol = String(symbol || "")
    .trim()
    .toUpperCase();

  const upperSeries = String(series || "")
    .trim()
    .toUpperCase();

  console.log(
    `[NSE] fetch ${upperSymbol} [${upperSeries || "?"}]`
  );

  // 1. known series pehle (agar pata hai)
  if (upperSeries) {
    const entry = await fetchNseSeries(
      upperSymbol,
      upperSeries
    );

    // throttle -> aur try mat karo, seedha null (BSE fallback lagega)
    if (entry === "ABORTED") {
      return null;
    }

    if (entry) {
      return parseNseEntry(entry, upperSymbol, upperSeries);
    }
  }

  // 2. series pata nahi ya known fail -> baaki sab try
  for (const s of SERIES_LIST) {
    if (s === upperSeries) continue;

    const entry = await fetchNseSeries(upperSymbol, s);

    // throttle -> loop rok do
    if (entry === "ABORTED") {
      return null;
    }

    if (entry) {
      return parseNseEntry(entry, upperSymbol, s);
    }
  }

  return null;
}

// ============================================================
// BSE: fetch APIs
// ============================================================

// BSE VAR + Applicable Margin (SecurityVar, AMR) - alag API
async function fetchBseVar(scripCode) {
  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/VarMargin/w" +
    "?getquotetype=EQ&scripcode=" +
    encodeURIComponent(scripCode);

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: BSE_HEADERS },
      8000
    );

    if (!res.ok) return null;

    return await res.json();
  } catch (_) {
    return null;
  }
}

async function fetchBseTrading(scripCode) {
  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/StockTrading/w" +
    "?flag=&quotetype=EQ&scripcode=" +
    encodeURIComponent(scripCode);

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: BSE_HEADERS },
      8000
    );

    if (!res.ok) return null;

    return await res.json();
  } catch (_) {
    return null;
  }
}

async function fetchBseHeader(scripCode) {
  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/ComHeadernew_par/w" +
    "?quotetype=&scripcode=" +
    encodeURIComponent(scripCode) +
    "&seriesid=";

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: BSE_HEADERS },
      8000
    );

    if (!res.ok) return null;

    return await res.json();
  } catch (_) {
    return null;
  }
}

// LTP / prev close ke liye (StockTrading me ye nahi hote)
async function fetchBseHeaderData(scripCode) {
  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w" +
    "?Debtflag=&scripcode=" +
    encodeURIComponent(scripCode) +
    "&seriesid=";

  try {
    const res = await fetchWithTimeout(
      url,
      { headers: BSE_HEADERS },
      8000
    );

    if (!res.ok) return null;

    return await res.json();
  } catch (_) {
    return null;
  }
}

async function getBseData(scripRow) {
  const scripCode = scripRow.scripCode;

  console.log(
    `[BSE] fetch ${scripRow.symbol} (scrip ${scripCode})`
  );

  const [trading, header, headerData, varData] =
    await Promise.all([
      fetchBseTrading(scripCode),
      fetchBseHeader(scripCode),
      fetchBseHeaderData(scripCode),
      fetchBseVar(scripCode),
    ]);

  if (!trading && !header && !headerData) {
    return null;
  }

  // BSE VAR (SecurityVar) + Applicable Margin (AMR)
  let securityVar = "N/A";
  let applicableMarginRate = "N/A";

  if (varData) {
    if (varData.SecurityVar != null &&
        cleanNumber(varData.SecurityVar) !== null) {
      securityVar = String(varData.SecurityVar);
    }
    if (varData.AMR != null &&
        cleanNumber(varData.AMR) !== null) {
      applicableMarginRate = String(varData.AMR);
    }
  }

  const isin =
    (header && header.ISIN) || scripRow.isin || "N/A";

  const company =
    scripRow.name ||
    (header && header.SecurityId) ||
    (headerData &&
      headerData.Cmpname &&
      headerData.Cmpname.FullN) ||
    scripRow.symbol;

  const marketCap =
    trading && trading.MktCapFull
      ? String(trading.MktCapFull)
      : "N/A";

  const marketCapFF =
    trading && trading.MktCapFF
      ? String(trading.MktCapFF)
      : "N/A";

  const wap =
    trading && trading.WAP ? String(trading.WAP) : "N/A";

  // LTP + prev close (getScripHeaderData se)
  const hd =
    (headerData && headerData.Header) || {};

  const ltp =
    hd.LTP && Number(hd.LTP) > 0
      ? String(hd.LTP)
      : "N/A";

  const prevClose =
    hd.PrevClose && Number(hd.PrevClose) > 0
      ? String(hd.PrevClose)
      : "N/A";

  const group = (header && header.Group) || "N/A";

  const industry = (header && header.Industry) || "N/A";

  let bulkDeal = null;

  const marketCapNumber = cleanNumber(marketCap);

  if (marketCapNumber !== null) {
    bulkDeal =
      marketCapNumber * (BULK_DEAL_PERCENT / 100);
  }

  const approval = checkApproval(scripRow.symbol, isin);

  // STATUS: Category se (Listed / Suspended / Delisted)
  const category = String(
    (headerData &&
      headerData.Cmpname &&
      headerData.Cmpname.Category) ||
      (header && header.Category) ||
      ""
  );

  const catLower = category.toLowerCase();

  const isSuspended =
    catLower.includes("suspend") ||
    catLower.includes("delist");

  let status;
  if (isSuspended) {
    status = `⛔ ${category.toUpperCase()}`;
  } else if (category) {
    status = `✅ ${category.toUpperCase()}`;
  } else {
    status = "N/A";
  }

  console.log(`[BSE] ${scripRow.symbol} done`);

  return {
    exchange: "BSE",
    symbol: scripRow.symbol,
    scripCode,
    company,
    isin,
    ltp,
    prevClose,
    wap,
    marketCap,
    marketCapFF,
    group,
    industry,
    securityVar,
    applicableMarginRate,
    bulkDeal,
    approval,
    status,
    isSuspended,
  };
}

// ============================================================
// REPLIES
// ============================================================

function createNseReply(data) {
  const approved =
    data.approval.status === "APPROVED" ? "YES" : "NO";

  const ltp =
    data.ltp === "N/A" ? "N/A" : `₹${data.ltp}`;

  const prevClose =
    data.prevClose === "N/A"
      ? "N/A"
      : `₹${data.prevClose}`;

  const marketCap =
    data.marketCap === "N/A"
      ? "N/A"
      : `₹${data.marketCap} Cr`;

  const securityVar =
    data.securityVar === "N/A"
      ? "N/A"
      : `${data.securityVar}%`;

  const applicableMarginRate =
    data.applicableMarginRate === "N/A"
      ? "N/A"
      : `${data.applicableMarginRate}%`;

  const bulkDeal =
    data.bulkDeal === null
      ? "N/A"
      : `₹${formatIndianNumber(data.bulkDeal)} Cr`;

  const varNum = cleanNumber(data.securityVar);
  let finance;
  if (data.isSuspended) {
    finance = "❌ NOT ALLOWED (Suspended)";
  } else if (varNum === null) {
    finance = "N/A (VAR nahi mila)";
  } else if (varNum < 100) {
    finance = "✅ ALLOWED";
  } else {
    finance = "❌ NOT ALLOWED";
  }

  return (
    `📊 <b>STOCK DATA</b>\n\n` +
    `<b>EXCHANGE:</b> NSE\n` +
    `<b>SYMBOL:</b> ${escapeHtml(data.symbol)}\n` +
    `<b>SERIES:</b> ${escapeHtml(data.series)}\n` +
    `<b>COMPANY:</b> ${escapeHtml(data.company)}\n` +
    `<b>ISIN:</b> ${escapeHtml(data.isin)}\n` +
    `<b>STATUS:</b> ${escapeHtml(data.status || "N/A")}\n\n` +
    `<b>LTP:</b> ${escapeHtml(ltp)}\n` +
    `<b>PREV CLOSE:</b> ${escapeHtml(prevClose)}\n` +
    `<b>MARKET CAP:</b> ${escapeHtml(marketCap)}\n` +
    `<b>SECURITY VAR:</b> ${escapeHtml(securityVar)}\n` +
    `<b>APPLICABLE MARGIN:</b> ${escapeHtml(
      applicableMarginRate
    )}\n` +
    `<b>BULK DEAL (0.49%):</b> ${escapeHtml(bulkDeal)}\n` +
    `<b>APPROVED:</b> ${approved}\n\n` +
    `<b>FINANCE:</b> ${finance}`
  );
}

function createBseReply(data) {
  const approved =
    data.approval.status === "APPROVED" ? "YES" : "NO";

  const ltp =
    data.ltp === "N/A" ? "N/A" : `₹${data.ltp}`;

  const prevClose =
    data.prevClose === "N/A"
      ? "N/A"
      : `₹${data.prevClose}`;

  const wap =
    data.wap === "N/A" ? "N/A" : `₹${data.wap}`;

  const marketCap =
    data.marketCap === "N/A"
      ? "N/A"
      : `₹${data.marketCap} Cr`;

  const marketCapFF =
    data.marketCapFF === "N/A"
      ? "N/A"
      : `₹${data.marketCapFF} Cr`;

  const bulkDeal =
    data.bulkDeal === null
      ? "N/A"
      : `₹${formatIndianNumber(data.bulkDeal)} Cr`;

  const securityVar =
    !data.securityVar || data.securityVar === "N/A"
      ? "N/A"
      : `${data.securityVar}%`;

  const applicableMarginRate =
    !data.applicableMarginRate ||
    data.applicableMarginRate === "N/A"
      ? "N/A"
      : `${data.applicableMarginRate}%`;

  const varNum = cleanNumber(data.securityVar);
  let finance;
  if (data.isSuspended) {
    finance = "❌ NOT ALLOWED (Suspended)";
  } else if (varNum === null) {
    finance = "N/A (VAR nahi mila)";
  } else if (varNum < 100) {
    finance = "✅ ALLOWED";
  } else {
    finance = "❌ NOT ALLOWED";
  }

  return (
    `📊 <b>STOCK DATA</b>\n\n` +
    `<b>EXCHANGE:</b> BSE\n` +
    `<b>SYMBOL:</b> ${escapeHtml(data.symbol)}\n` +
    `<b>SCRIP:</b> ${escapeHtml(data.scripCode)}\n` +
    `<b>COMPANY:</b> ${escapeHtml(data.company)}\n` +
    `<b>ISIN:</b> ${escapeHtml(data.isin)}\n` +
    `<b>GROUP:</b> ${escapeHtml(data.group)}\n` +
    `<b>INDUSTRY:</b> ${escapeHtml(data.industry)}\n` +
    `<b>STATUS:</b> ${escapeHtml(data.status || "N/A")}\n\n` +
    `<b>LTP:</b> ${escapeHtml(ltp)}\n` +
    `<b>PREV CLOSE:</b> ${escapeHtml(prevClose)}\n` +
    `<b>WAP:</b> ${escapeHtml(wap)}\n` +
    `<b>MARKET CAP (FULL):</b> ${escapeHtml(marketCap)}\n` +
    `<b>SECURITY VAR:</b> ${escapeHtml(securityVar)}\n` +
    `<b>APPLICABLE MARGIN:</b> ${escapeHtml(
      applicableMarginRate
    )}\n` +
    `<b>BULK DEAL (0.49%):</b> ${escapeHtml(bulkDeal)}\n` +
    `<b>FINANCE:</b> ${finance}\n\n` +
    `<b>APPROVED:</b> ${approved}`
  );
}

function createNotFoundReply(symbol) {
  return (
    `❌ <b>NOT FOUND</b>\n\n` +
    `<b>SYMBOL:</b> ${escapeHtml(symbol)}\n\n` +
    `NSE aur BSE dono me nahi mila.`
  );
}

// ============================================================
// SUGGESTION KEYBOARDS
// ============================================================

function buildNseSuggestionKeyboard(matches) {
  const keyboard = matches.map((m) => {
    const token = makeToken({
      exchange: "NSE",
      symbol: m.symbol,
      series: m.series,
    });

    return [
      {
        text: `${m.symbol} [${m.series}] — ${m.company}`.slice(
          0,
          60
        ),
        callback_data: token,
      },
    ];
  });

  return { inline_keyboard: keyboard };
}

function buildBseSuggestionKeyboard(matches) {
  const keyboard = matches.map((m) => {
    const token = makeToken({
      exchange: "BSE",
      symbol: m.symbol,
      scripCode: m.scripCode,
      name: m.name,
      isin: m.isin,
    });

    return [
      {
        text: `${m.symbol} — ${m.name}`.slice(0, 60),
        callback_data: token,
      },
    ];
  });

  return { inline_keyboard: keyboard };
}

// combined NSE + BSE suggestions (exchange tag ke saath)
function buildCombinedSuggestionKeyboard(matches) {
  const keyboard = matches.map((m) => {
    let token;
    let text;

    if (m.exchange === "NSE") {
      token = makeToken({
        exchange: "NSE",
        symbol: m.symbol,
        series: m.series,
      });

      text = `🟢 NSE  ${m.symbol} [${m.series}] — ${m.company || ""}`;
    } else {
      token = makeToken({
        exchange: "BSE",
        symbol: m.symbol,
        scripCode: m.scripCode,
        name: m.name,
        isin: m.isin,
      });

      text = `🔵 BSE  ${m.symbol} — ${m.name || ""}`;
    }

    return [
      {
        text: text.slice(0, 64),
        callback_data: token,
      },
    ];
  });

  return { inline_keyboard: keyboard };
}

// ============================================================
// MAIN RESOLVER
// ============================================================

async function resolveSymbol(symbol) {
  const upperSymbol = String(symbol || "")
    .trim()
    .toUpperCase();

  // --------------------------------------------------------
  // NSE globalSearch + BSE search PARALLEL (fast)
  // NSE cooldown me ho to NSE skip (BSE-only)
  // --------------------------------------------------------
  const nseSearchPromise = nseInCooldown()
    ? Promise.resolve([])
    : nseGlobalSearch(upperSymbol);

  if (nseInCooldown()) {
    console.log(
      `[NSE] cooldown active -> ${upperSymbol} BSE-only`
    );
  }

  const [nseMatches, bseSearch] = await Promise.all([
    nseSearchPromise,
    searchBseSymbol(upperSymbol),
  ]);

  // ========================================================
  // PRIORITY ORDER:
  //   1. NSE exact
  //   2. BSE exact   (NSE partial se PEHLE)
  //   3. NSE single
  //   4. NSE partial (suggestions)
  //   5. BSE single / partial
  // ========================================================

  const nseExact = nseMatches.find(
    (m) => m.symbol === upperSymbol
  );

  // -------- 1. NSE EXACT --------
  if (nseExact) {
    console.log(`[NSE] ${upperSymbol} EXACT -> direct`);

    const data = await getNseDataBySeries(
      nseExact.symbol,
      nseExact.series
    );

    if (data) return { kind: "NSE", data };
  }

  // -------- 2. BSE EXACT (NSE partial se pehle) --------
  if (bseSearch.type === "exact") {
    console.log(`[BSE] ${upperSymbol} EXACT -> direct`);

    const bse = await getBseData(bseSearch.matches[0]);

    if (bse) return { kind: "BSE", data: bse };
  }

  // -------- 3. NSE single result -> direct --------
  if (nseMatches.length === 1) {
    const m = nseMatches[0];

    console.log(
      `[NSE] ${upperSymbol} single (${m.symbol}) -> direct`
    );

    const data = await getNseDataBySeries(m.symbol, m.series);

    if (data) return { kind: "NSE", data };
  }

  // -------- 4. NSE partial -> suggestions --------
  if (nseMatches.length > 1) {
    console.log(
      `[NSE] ${upperSymbol} -> ${nseMatches.length} suggestions`
    );

    const suggestions = nseMatches.map((m) => ({
      exchange: "NSE",
      symbol: m.symbol,
      series: m.series,
      company: m.company,
    }));

    return {
      kind: "SUGGEST",
      matches: suggestions.slice(0, MAX_SUGGESTIONS * 2),
    };
  }

  // ========================================================
  // 5. NSE khali -> BSE (single / partial)
  // ========================================================
  const bseRows =
    bseSearch.type === "none" ? [] : bseSearch.matches;

  if (bseRows.length === 0) {
    return { kind: "NOT_FOUND" };
  }

  // BSE par sirf 1 -> seedha data
  if (bseRows.length === 1) {
    const r = bseRows[0];

    console.log(
      `[BSE] ${upperSymbol} single (${r.symbol}) -> direct`
    );

    const bse = await getBseData({
      scripCode: r.scripCode,
      symbol: r.symbol,
      name: r.name,
      isin: r.isin,
    });

    if (bse) return { kind: "BSE", data: bse };

    return { kind: "NOT_FOUND" };
  }

  // BSE par 2+ -> BSE suggestions
  console.log(
    `[BSE] ${upperSymbol} -> ${bseRows.length} suggestions`
  );

  const suggestions = bseRows.map((r) => ({
    exchange: "BSE",
    symbol: r.symbol,
    scripCode: r.scripCode,
    name: r.name,
    isin: r.isin,
    company: r.name,
  }));

  return {
    kind: "SUGGEST",
    matches: suggestions.slice(0, MAX_SUGGESTIONS * 2),
  };
}

// ============================================================
// QUEUE
// ============================================================

function queueRequest(fn) {
  const job = requestQueue.then(fn);

  requestQueue = job.catch(() => {});

  return job;
}

// ============================================================
// HANDLE SYMBOL
// ============================================================

async function handleSymbol(chatId, requestedSymbol) {
  let loadingMessage;

  try {
    loadingMessage = await bot.sendMessage(
      chatId,
      `⏳ Fetching ${requestedSymbol}...`
    );

    const result = await queueRequest(() =>
      resolveSymbol(requestedSymbol)
    );

    // NSE
    if (result.kind === "NSE") {
      const replyText = createNseReply(result.data);
      await bot.editMessageText(replyText, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: "HTML",
      });
      await forwardReplyToAdmin(replyText, requestedSymbol);
      scheduleDelete(chatId, loadingMessage.message_id);
      return;
    }

    // BSE
    if (result.kind === "BSE") {
      const replyText = createBseReply(result.data);
      await bot.editMessageText(replyText, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: "HTML",
      });
      await forwardReplyToAdmin(replyText, requestedSymbol);
      scheduleDelete(chatId, loadingMessage.message_id);
      return;
    }

    // Combined NSE + BSE suggestions
    if (result.kind === "SUGGEST") {
      const nseCount = result.matches.filter(
        (m) => m.exchange === "NSE"
      ).length;

      const bseCount = result.matches.filter(
        (m) => m.exchange === "BSE"
      ).length;

      const suggestText =
        `🔎 <b>${escapeHtml(
          requestedSymbol
        )}</b> exact match nahi mila.\n\n` +
        `${result.matches.length} results ` +
        `(NSE: ${nseCount}, BSE: ${bseCount}).\n\n` +
        `Select karo:`;

      await bot.editMessageText(suggestText, {
        chat_id: chatId,
        message_id: loadingMessage.message_id,
        parse_mode: "HTML",
        reply_markup: buildCombinedSuggestionKeyboard(
          result.matches
        ),
      });

      await forwardReplyToAdmin(suggestText, requestedSymbol);

      scheduleDelete(chatId, loadingMessage.message_id);

      return;
    }

    // NOT FOUND
    const notFoundText = createNotFoundReply(requestedSymbol);

    await bot.editMessageText(notFoundText, {
      chat_id: chatId,
      message_id: loadingMessage.message_id,
      parse_mode: "HTML",
    });

    await forwardReplyToAdmin(notFoundText, requestedSymbol);

    scheduleDelete(chatId, loadingMessage.message_id);
  } catch (error) {
    console.error(
      `[ERROR] ${requestedSymbol}:`,
      error.message
    );

    const errorText =
      `❌ <b>ERROR</b>\n\n` +
      `<b>SYMBOL:</b> ${escapeHtml(
        requestedSymbol
      )}\n\n` +
      escapeHtml(error.message);

    await forwardReplyToAdmin(errorText, requestedSymbol);

    if (loadingMessage) {
      try {
        await bot.editMessageText(errorText, {
          chat_id: chatId,
          message_id: loadingMessage.message_id,
          parse_mode: "HTML",
        });

        scheduleDelete(chatId, loadingMessage.message_id);

        return;
      } catch (_) {}
    }

    const sent = await bot.sendMessage(chatId, errorText, {
      parse_mode: "HTML",
    });

    if (sent) scheduleDelete(chatId, sent.message_id);
  }
}

// ============================================================
// INLINE BUTTON CLICK
// ============================================================

bot.on("callback_query", async (query) => {
  const token = query.data || "";
  const message = query.message;

  if (!message) {
    return;
  }

  const chatId = message.chat.id;

  const payload = callbackStore.get(token);

  if (!payload) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: "Ye button purana ho gaya. Dobara search karo.",
        show_alert: true,
      });
    } catch (_) {}

    return;
  }

  const symbol = payload.symbol || "";

  try {
    await bot.answerCallbackQuery(query.id, {
      text: `Fetching ${symbol}...`,
    });
  } catch (_) {}

  try {
    await bot.editMessageText(
      `⏳ Fetching ${symbol}...`,
      {
        chat_id: chatId,
        message_id: message.message_id,
      }
    );

    let data = null;

    if (payload.exchange === "NSE") {
      data = await queueRequest(() =>
        getNseDataBySeries(
          payload.symbol,
          payload.series
        )
      );

      if (data) {
        await bot.editMessageText(
          createNseReply(data),
          {
            chat_id: chatId,
            message_id: message.message_id,
            parse_mode: "HTML",
          }
        );

        scheduleDelete(chatId, message.message_id);
        return;
      }

      // NSE fail -> BSE se try karo (same symbol)
      console.log(
        `[NSE] button ${payload.symbol} fail -> BSE try`
      );

      const bseSearch = await queueRequest(() =>
        searchBseSymbol(payload.symbol)
      );

      const bseRow =
        bseSearch.matches && bseSearch.matches[0];

      if (bseRow) {
        const bse = await queueRequest(() =>
          getBseData(bseRow)
        );

        if (bse) {
          await bot.editMessageText(
            createBseReply(bse),
            {
              chat_id: chatId,
              message_id: message.message_id,
              parse_mode: "HTML",
            }
          );

          scheduleDelete(chatId, message.message_id);
          return;
        }
      }
    } else if (payload.exchange === "BSE") {
      const scripRow = {
        scripCode: payload.scripCode,
        symbol: payload.symbol,
        name: payload.name || payload.symbol,
        isin: payload.isin || "",
      };

      data = await queueRequest(() =>
        getBseData(scripRow)
      );

      if (data) {
        await bot.editMessageText(
          createBseReply(data),
          {
            chat_id: chatId,
            message_id: message.message_id,
            parse_mode: "HTML",
          }
        );

        scheduleDelete(chatId, message.message_id);
        return;
      }
    }

    // data nahi mila
    await bot.editMessageText(
      createNotFoundReply(symbol),
      {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: "HTML",
      }
    );

    scheduleDelete(chatId, message.message_id);
  } catch (error) {
    console.error(
      `[CALLBACK ERROR] ${symbol}:`,
      error.message
    );

    await notifyAdmin(
      `❌ <b>CALLBACK ERROR</b> (${escapeHtml(
        symbol
      )})\n\n${escapeHtml(error.message)}`,
      { parse_mode: "HTML" }
    );

    try {
      await bot.editMessageText(
        `❌ <b>ERROR</b>\n\n${escapeHtml(
          error.message
        )}`,
        {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: "HTML",
        }
      );
    } catch (_) {}
  }
});

// ============================================================
// TELEGRAM MESSAGE
// ============================================================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const text = String(msg.text || "").trim();

  if (!text) {
    return;
  }

  const isPrivate = chatType === "private";

  const isGroup =
    chatType === "group" ||
    chatType === "supergroup";

  if (!isPrivate && !isGroup) {
    return;
  }

  const isAdmin =
    String(chatId) === String(ADMIN_CHAT_ID);

  // -------- ADMIN COMMANDS (sirf admin private) --------
  if (isAdmin && isPrivate) {
    const cmd = text.toLowerCase();

    if (cmd === "/block") {
      blockMode = true;
      await bot.sendMessage(
        chatId,
        "🔒 BLOCK ON — ab sirf admin bot use kar sakega."
      );
      return;
    }

    if (cmd === "/open") {
      blockMode = false;
      await bot.sendMessage(
        chatId,
        "🔓 OPEN — ab sabko allow hai."
      );
      return;
    }

    if (cmd === "/status") {
      await bot.sendMessage(
        chatId,
        blockMode
          ? "🔒 Abhi BLOCK mode (sirf admin)."
          : "🔓 Abhi OPEN mode (sabko allow)."
      );
      return;
    }

    // ---- block this id : 12345 ----
    const blockMatch = text.match(
      /^block\s+this\s+id\s*:?\s*(-?\d+)/i
    );

    if (blockMatch) {
      const id = blockMatch[1];
      blockedIds.add(String(id));
      saveBlockedIds();
      await bot.sendMessage(
        chatId,
        `⛔ ID <code>${escapeHtml(
          id
        )}</code> block ho gaya.\nTotal blocked: ${
          blockedIds.size
        }`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ---- unblock this id : 12345 ----
    const unblockMatch = text.match(
      /^unblock\s+this\s+id\s*:?\s*(-?\d+)/i
    );

    if (unblockMatch) {
      const id = unblockMatch[1];
      const had = blockedIds.delete(String(id));
      saveBlockedIds();
      await bot.sendMessage(
        chatId,
        had
          ? `✅ ID <code>${escapeHtml(
              id
            )}</code> unblock ho gaya.\nTotal blocked: ${
              blockedIds.size
            }`
          : `ℹ️ ID <code>${escapeHtml(
              id
            )}</code> list me tha hi nahi.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // ---- blocked list ----
    if (
      cmd === "blocked list" ||
      cmd === "block list" ||
      cmd === "/blocked"
    ) {
      if (blockedIds.size === 0) {
        await bot.sendMessage(
          chatId,
          "📃 Blocked list khali hai."
        );
      } else {
        const list = [...blockedIds]
          .map((id, i) => `${i + 1}. <code>${escapeHtml(id)}</code>`)
          .join("\n");
        await bot.sendMessage(
          chatId,
          `📃 <b>BLOCKED IDs (${blockedIds.size})</b>\n\n${list}`,
          { parse_mode: "HTML" }
        );
      }
      return;
    }
  }

  // -------- ye ID blocked hai? (admin chhod ke) --------
  const fromId = msg.from ? String(msg.from.id) : "";

  if (
    !isAdmin &&
    (blockedIds.has(String(chatId)) ||
      (fromId && blockedIds.has(fromId)))
  ) {
    console.log(
      `[BLOCKED-ID] chat ${chatId} / user ${fromId} ignored`
    );
    return;
  }

  // -------- BLOCK MODE: sirf admin allow --------
  if (blockMode && !isAdmin) {
    console.log(`[BLOCKED] ${chatId} (block mode)`);
    return;
  }

  if (
    isPrivate &&
    text.toLowerCase() === "/start"
  ) {
    await bot.sendMessage(
      chatId,
      "📊 NSE + BSE Stock Bot\n\n" +
        "Command:\n" +
        "RELIANCE     (seedha symbol)\n" +
        "S/RELIANCE   (S/ ke saath bhi)\n" +
        "RELI         (partial -> suggestions)"
    );

    return;
  }

  // ---- SYMBOL nikalna ----
  // GROUP: sirf S/SYMBOL
  // PRIVATE: S/SYMBOL bhi, seedha SYMBOL bhi
  let requestedSymbol = null;

  const withPrefix = text.match(/^S\/([A-Z0-9&._-]+)$/i);

  if (withPrefix) {
    requestedSymbol = withPrefix[1].trim().toUpperCase();
  } else if (isPrivate) {
    const plain = text.match(/^([A-Za-z0-9&._-]+)$/);
    if (plain) {
      requestedSymbol = plain[1].trim().toUpperCase();
    }
  }

  if (!requestedSymbol) {
    return;
  }

  // duplicate guard: same symbol 8 sec ke andar dobara -> ignore
  const dupKey = `${chatId}:${requestedSymbol}`;
  const now = Date.now();
  const last = recentRequests.get(dupKey) || 0;

  if (now - last < 8000) {
    console.log(
      `[SKIP] duplicate ${requestedSymbol} (${now - last}ms)`
    );
    return;
  }

  recentRequests.set(dupKey, now);

  // memory safe
  if (recentRequests.size > 500) {
    const firstKey = recentRequests.keys().next().value;
    recentRequests.delete(firstKey);
  }

  console.log(
    `\n[TELEGRAM] ${chatType} ${chatId} → ${requestedSymbol}`
  );

  await forwardIncomingToAdmin(msg, requestedSymbol);

  await handleSymbol(chatId, requestedSymbol);
});

// ============================================================
// POLLING ERROR
// ============================================================

bot.on("polling_error", (error) => {
  console.error(
    "TELEGRAM POLLING ERROR:",
    error.message
  );

  const msg = error.message || "unknown";

  // har error par time reset (recovery isi se decide hota hai)
  lastPollOkTime = Date.now();

  // same error dobara-dobara na bhejo, sirf pehli baar
  if (pollErrorActive && msg === lastPollErrorMsg) {
    return;
  }

  pollErrorActive = true;
  lastPollErrorMsg = msg;

  notifyAdmin(
    `⚠️ <b>POLLING ERROR</b>\n\n${escapeHtml(msg)}\n\n` +
      `(It will appear again only if the error changes or gets resolved.)`,
    { parse_mode: "HTML" }
  );
});

// recovery detect: agar error active tha aur pichle 35s me
// koi naya poll error nahi aaya -> "OK theek ho gaya" bhejo
setInterval(() => {
  if (pollErrorActive) {
    const sinceErr = Date.now() - lastPollOkTime;
    if (sinceErr > 35000) {
      pollErrorActive = false;
      lastPollErrorMsg = "";
      notifyAdmin(
        "✅ <b>OK</b> — The bot is fixed now and is running",
        { parse_mode: "HTML" }
      );
    }
  }
}, 30000);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {
  console.log("\nStopping bot...");

  try {
    await bot.stopPolling();
  } catch (_) {}

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message);
  notifyAdmin(
    `🛑 <b>UNCAUGHT ERROR</b>\n\n${escapeHtml(
      err.message
    )}`,
    { parse_mode: "HTML" }
  );
});

process.on("unhandledRejection", (reason) => {
  const msg =
    reason && reason.message
      ? reason.message
      : String(reason);
  console.error("[UNHANDLED]", msg);
  notifyAdmin(
    `🛑 <b>UNHANDLED REJECTION</b>\n\n${escapeHtml(msg)}`,
    { parse_mode: "HTML" }
  );
});

// ============================================================
// START
// ============================================================

console.log(
  "========================================"
);
console.log("     NSE + BSE TELEGRAM BOT STARTED");
console.log(
  "========================================"
);
console.log(`Admin forward: ${ADMIN_CHAT_ID}`);
console.log("Private: ALL allowed (direct symbol OK)");
console.log("Group: only S/SYMBOL");
console.log("Mode: Pure Node API (NO CHROME)");
console.log(`NSE series: ${SERIES_LIST.join(", ")}`);
console.log(
  "Flow: NSE exact -> BSE exact -> combined suggestions"
);
console.log("BSE: live search API (no CSV)");

console.log("Waiting for Telegram messages...\n");

// blocked IDs load karo (blocked.json se)
loadBlockedIds();

// startup par cookies pehle se le lo (pehli request fast ho)
ensureNseCookies(true).catch(() => {});

// har 3.5 min background refresh (request ke time wait na ho)
setInterval(() => {
  ensureNseCookies(true).catch(() => {});
}, 3.5 * 60 * 1000);

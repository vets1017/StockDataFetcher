// Testing YahooFinance

const express = require("express");
const cors = require("cors");
const { quote } = require("yahoo-finance2/modules");
const app = express();

app.use(cors());
app.use(express.json());

const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// Every game server asks Yahoo for the same symbols, so all routes share
// results through a small in-memory cache instead of each request becoming a
// Yahoo call (Yahoo answers bursts with 429s).
const responseCache = new Map(); // key -> { expiresAt, value }
const pendingFetches = new Map(); // key -> promise, so a burst of misses makes one call
const CACHE_SWEEP_MS = 10 * 60 * 1000;
// An expired entry is kept this long past its expiry, to answer with while
// Yahoo is failing: slightly old data beats an error (the game checks a
// quote's own time before filling at it)
const STALE_MAX_MS = 6 * 60 * 60 * 1000;

function cached(key, ttlMs, fetchValue) {
  const hit = responseCache.get(key);

  if (hit && hit.expiresAt > Date.now()) {
    return Promise.resolve(hit.value);
  }

  if (pendingFetches.has(key)) {
    return pendingFetches.get(key);
  }

  // A failed fetch isn't cached, so the next request tries again
  const fetch = fetchValue()
    .then((value) => {
      responseCache.set(key, { expiresAt: Date.now() + ttlMs, value });

      return value;
    })
    .catch((error) => {
      if (hit) {
        console.warn(`Serving stale ${key}: ${error.message}`);

        return hit.value;
      }

      throw error;
    })
    .finally(() => pendingFetches.delete(key));

  pendingFetches.set(key, fetch);

  return fetch;
}

setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of responseCache) {
    if (entry.expiresAt + STALE_MAX_MS <= now) {
      responseCache.delete(key);
    }
  }
}, CACHE_SWEEP_MS);

// Yahoo's quote, quoteSummary, options and screener calls need a "crumb"
// token first, and Yahoo refuses crumbs (429) to IPs it distrusts, which
// shared cloud IPs like Render's often are. yahoo-finance2 asks for a new
// crumb on every call after a refusal, so a busy game kept the block going.
// After a refusal, crumb calls pause - a minute at first, doubling to 15
// minutes while Yahoo keeps refusing - and routes answer from stale data or
// the chart endpoint, which needs no crumb.
const CRUMB_PAUSE_MIN_MS = 60 * 1000;
const CRUMB_PAUSE_MAX_MS = 15 * 60 * 1000;
const crumbPause = { until: 0, lengthMs: 0, lastError: null };

function isCrumbRefusal(error) {
  return /crumb|429|too many requests/i.test(String(error && error.message));
}

async function withCrumb(call) {
  if (Date.now() < crumbPause.until) {
    throw new Error("Yahoo is refusing crumbs; crumb calls are paused");
  }

  try {
    const value = await call();

    crumbPause.lengthMs = 0;

    return value;
  } catch (error) {
    // Calls already in flight when a pause starts fail too; only the first
    // refusal lengthens it
    if (isCrumbRefusal(error) && Date.now() >= crumbPause.until) {
      crumbPause.lengthMs = Math.min(
        Math.max(crumbPause.lengthMs * 2, CRUMB_PAUSE_MIN_MS),
        CRUMB_PAUSE_MAX_MS,
      );
      crumbPause.until = Date.now() + crumbPause.lengthMs;
      crumbPause.lastError = error.message;
      console.warn(`Crumb refused (${error.message}); pausing crumb calls for ${crumbPause.lengthMs / 1000}s`);
    }

    throw error;
  }
}

// Same rule the game uses for tickers (letters, digits, "." and "-")
function isValidTicker(ticker) {
  return /^[A-Z0-9.\-]{1,10}$/.test(ticker);
}

const QUOTE_TTL_MS = 10 * 1000; // a "live" price is at most this old
const OPTIONS_TTL_MS = 5 * 60 * 1000;
const QUOTE_DETAILS_TTL_MS = 60 * 1000;
const RESEARCH_TTL_MS = 6 * 60 * 60 * 1000; // analyst and fundamentals
const CHART_TTL_MS = {
  "1m": 60 * 1000,
  "5m": 60 * 1000,
  "30m": 5 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "1d": 60 * 60 * 1000,
};

async function fetchQuoteSummary(ticker, modules, ttlMs) {
  try {
    const result = await cached(`summary:${ticker}:${modules.join(",")}`, ttlMs, () =>
      withCrumb(() => yahooFinance.quoteSummary(ticker, { modules })),
    );
    return { data: result, error: null };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

const CHART_QUOTE_CONCURRENCY = 4;
const CHART_QUOTE_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

// "REGULAR", "PRE", "POST" or "CLOSED" at `now`, from the session windows a
// chart reports (the quote endpoint's marketState, which needs a crumb)
function marketStateFrom(periods, now) {
  const isWithin = (period) =>
    period && now >= new Date(period.start).getTime() && now < new Date(period.end).getTime();

  if (!periods) {
    return null;
  } else if (isWithin(periods.regular)) {
    return "REGULAR";
  } else if (isWithin(periods.pre)) {
    return "PRE";
  } else if (isWithin(periods.post)) {
    return "POST";
  }

  return "CLOSED";
}

// A quote built from the chart endpoint, which needs no crumb, in the quote
// endpoint's shape. No bid or ask (the game then fills at the last price).
// The previous close is the daily bar before the latest session; for crypto
// that's the previous UTC day's close, which can differ a little from the
// quote endpoint's.
async function getChartQuote(symbol) {
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const result = await yahooFinance.chart(symbol, {
    period1: nowInSeconds - CHART_QUOTE_LOOKBACK_SECONDS,
    period2: nowInSeconds,
    interval: "1d",
  });
  const meta = result.meta || {};
  const bars = (result.quotes || []).filter((bar) => bar && bar.close !== null);
  const lastBar = bars[bars.length - 1];
  const tradeTime = meta.regularMarketTime ? new Date(meta.regularMarketTime) : null;
  const isLastBarLatestSession =
    lastBar && tradeTime && new Date(lastBar.date).toISOString().slice(0, 10) === tradeTime.toISOString().slice(0, 10);
  const previousBar = isLastBarLatestSession ? bars[bars.length - 2] : lastBar;

  if (typeof meta.regularMarketPrice !== "number") {
    return null;
  }

  return {
    symbol: meta.symbol || symbol,
    regularMarketPrice: meta.regularMarketPrice,
    regularMarketPreviousClose: previousBar ? previousBar.close : (meta.chartPreviousClose ?? null),
    regularMarketTime: tradeTime,
    marketState: marketStateFrom(meta.currentTradingPeriod, Date.now()),
    bid: null,
    ask: null,
  };
}

// Chart quotes for several symbols, a few at a time; one that fails is left out
async function getChartQuotes(symbols) {
  const quotes = [];
  let next = 0;

  async function worker() {
    while (next < symbols.length) {
      const symbol = symbols[next++];

      try {
        const quote = await getChartQuote(symbol);

        if (quote) {
          quotes.push(quote);
        }
      } catch (error) {
        console.warn(`Chart quote for ${symbol} failed: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHART_QUOTE_CONCURRENCY, symbols.length) }, worker));

  return quotes;
}

// Yahoo quotes for many symbols, keyed by symbol. Symbols cached within
// QUOTE_TTL_MS are reused and the rest are fetched in one request - or from
// the chart endpoint when the quote endpoint fails or crumbs are paused -
// with a stale quote standing in for any that still can't be fetched. A
// symbol Yahoo doesn't know is just missing from the result.
async function getQuotes(symbols) {
  const now = Date.now();
  const missing = symbols.filter((symbol) => {
    const hit = responseCache.get(`quote:${symbol}`);

    return !(hit && hit.expiresAt > now);
  });

  if (missing.length > 0) {
    let results;

    try {
      results = await withCrumb(() => yahooFinance.quote(missing, {}, { validateResult: false }));
    } catch (error) {
      console.warn(`Quote batch failed (${error.message}); using chart quotes`);
      results = await getChartQuotes(missing);
    }

    for (const quote of [].concat(results || [])) {
      if (quote && quote.symbol) {
        responseCache.set(`quote:${quote.symbol}`, {
          expiresAt: Date.now() + QUOTE_TTL_MS,
          value: quote,
        });
      }
    }
  }

  const quotes = {};

  for (const symbol of symbols) {
    const hit = responseCache.get(`quote:${symbol}`);

    if (hit) {
      quotes[symbol] = hit.value;
    }
  }

  return quotes;
}

function getOptions(ticker) {
  return cached(`options:${ticker}`, OPTIONS_TTL_MS, () => withCrumb(() => yahooFinance.options(ticker)));
}

// Whether the server is up, and whether Yahoo is refusing crumbs (quotes
// then come from charts, and research and movers from stale data)
app.get("/api/health", (request, response) => {
  const pausedForMs = Math.max(crumbPause.until - Date.now(), 0);

  response.json({
    status: "ok",
    crumbCalls: pausedForMs > 0 ? "paused" : "ok",
    pausedForSeconds: Math.ceil(pausedForMs / 1000),
    lastCrumbError: crumbPause.lastError,
  });
});

app.get("/api/candles/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();
  const tf = request.query.tf;
  const mode = request.query.mode;

  const intervalMap = {
    "1M": "1m",
    "5M": "5m",
    "30M": "30m",
    H: "1h",
    D: "1d",
  };

  const interval = intervalMap[tf];

  if (!interval) {
    return response.status(400).json({ error: "Invalid timeframe mapping" });
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  let startInSeconds;

  if (["1m", "5m", "30m"].includes(interval)) {
    startInSeconds = nowInSeconds - 7 * 24 * 60 * 60;
  } else if (interval === "1h") {
    startInSeconds = nowInSeconds - 24 * 60 * 60 * 60;
  } else {
    startInSeconds = nowInSeconds - 2 * 24 * 60 * 60 * 365;
  }

  try {
    console.log(
      `Sending request to Yahoo for Ticker: [${ticker}] with Interval: [${interval}]`,
    );

    const result = await cached(`chart:${ticker}:${interval}`, CHART_TTL_MS[interval], () =>
      yahooFinance.chart(ticker, {
        period1: startInSeconds,
        period2: nowInSeconds,
        interval: interval,
      }),
    );

    console.log("API Keys: ", Object.keys(result || {}));

    let quotes = [];

    if (result && result.quotes) {
      quotes = result.quotes;
    } else if (
      result &&
      result.chart &&
      result.chart.result &&
      result.chart.result[0]
    ) {
      const rawData = result.chart.result[0];

      if (
        rawData.timestamp &&
        rawData.indicators &&
        rawData.indicators.quote &&
        rawData.indicators.quote[0]
      ) {
        const timestamps = rawData.timestamp;
        const ohlc = rawData.indicators.quote[0];

        quotes = timestamps.map((ts, index) => ({
          date: new Date(ts * 1000),
          open: ohlc.open ? ohlc.open[index] : null,
          high: ohlc.high ? ohlc.high[index] : null,
          low: ohlc.low ? ohlc.low[index] : null,
          close: ohlc.close ? ohlc.close[index] : null,
          volume: ohlc.volume && ohlc.volume[index] ? ohlc.volume[index] : 0,
        }));
      }
    }

    if (!quotes || quotes.length === 0) {
      console.warn(`Fallbacks failed for ${ticker}`);
      return response.status(404).json({
        error: `No data found for this ticker. Empty response for ${ticker} on ${interval}`,
      });
    }

    const formattedData = quotes
      .filter(
        (candle) => candle && candle.open !== null && candle.close !== null,
      )
      .map((candle, index, array) => {
        let high = Number(candle.high);
        let low = Number(candle.low);
        const open = Number(candle.open);
        const close = Number(candle.close);

        let baselinePrice = open;
        let sampleCount = 0;
        let priceSum = 0;

        if (index > 0 && array[index - 1]) {
          priceSum += Number(array[index - 1].close);
          sampleCount++;
        }

        if (index < array.length - 1 && array[index + 1]) {
          priceSum += Number(array[index + 1].close);
          sampleCount++;
        }

        if (sampleCount > 0) {
          baselinePrice = priceSum / sampleCount;

          const maxAllowedDeviation = baselinePrice * 0.03;

          if (high - baselinePrice > maxAllowedDeviation) {
            high = Math.max(open, close);
          }
          if (baselinePrice - low > maxAllowedDeviation) {
            low = Math.min(open, close);
          }
        }

        return {
          Timestamp: Math.floor(new Date(candle.date).setSeconds(0, 0) / 1000),
          Open: open,
          High: high,
          Low: low,
          Close: close,
          Volume: Number(candle.volume) || 0,
        };
      });

    if (mode === "live") {
      try {
        const liveQuote = (await getQuotes([ticker]))[ticker];
        if (
          liveQuote &&
          liveQuote.regularMarketPrice &&
          formattedData.length > 0
        ) {
          const currentLivePrice = Number(liveQuote.regularMarketPrice);
          const lastIndex = formattedData.length - 1;

          formattedData[lastIndex].Close = currentLivePrice;

          if (
            currentLivePrice > formattedData[lastIndex].High ||
            formattedData[lastIndex].High === formattedData[lastIndex].Open
          ) {
            formattedData[lastIndex].High = Math.max(
              formattedData[lastIndex].Open,
              currentLivePrice,
              formattedData[lastIndex].High,
            );
          }
          if (
            currentLivePrice < formattedData[lastIndex].Low ||
            formattedData[lastIndex].Low === formattedData[lastIndex].Open
          ) {
            formattedData[lastIndex].Low = Math.min(
              formattedData[lastIndex].Open,
              currentLivePrice,
              formattedData[lastIndex].Low,
            );
          }
        }
      } catch (quoteError) {
        console.warn("Live tick override: ", quoteError.message);
      }
      response.json(formattedData.slice(-5));
    } else {
      response.json(formattedData);
    }
  } catch (error) {
    console.error("Yahoo: ", error.message);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

app.get("/api/quote-details/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();
  const { data, error } = await fetchQuoteSummary(
    ticker,
    ["summaryDetail", "defaultKeyStatistics", "calendarEvents", "price"],
    QUOTE_DETAILS_TTL_MS,
  );

  if (!data) {
    console.error("Quote details: ", error);
    return response.status(500).json({ error: "Yahoo " + error });
  }

  const summaryDetail = data.summaryDetail || {};
  const keyStats = data.defaultKeyStatistics || {};
  const calendar = data.calendarEvents || {};
  const price = data.price || {};
  const earningsDate = Array.isArray(calendar.earningsDate)
    ? calendar.earningsDate[0]
    : (calendar.earningsDate ?? null);

  response.json({
    companyName: price.longName || price.shortName || null,
    bid: summaryDetail.bid ?? null,
    ask: summaryDetail.ask ?? null,
    bidSize: summaryDetail.bidSize ?? null,
    askSize: summaryDetail.askSize ?? null,
    volume: summaryDetail.volume ?? null,
    avgVolume: summaryDetail.averageVolume ?? null,
    marketCap: summaryDetail.marketCap ?? null,
    beta: keyStats.beta ?? null,
    trailingPE: summaryDetail.trailingPE ?? null,
    forwardPE: summaryDetail.forwardPE ?? null,
    dividendYield:
      summaryDetail.dividendYield !== null &&
      summaryDetail.dividendYield !== undefined
        ? summaryDetail.dividendYield * 100
        : null,
    dividendRate: summaryDetail.dividendRate ?? null,
    exDividendDate: calendar.exDividendDate ?? null,
    eps: keyStats.trailingEps ?? null,
    earningsDate,
    dayHigh: summaryDetail.dayHigh ?? null,
    dayLow: summaryDetail.dayLow ?? null,
    fiftyTwoWeekHigh: summaryDetail.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: summaryDetail.fiftyTwoWeekLow ?? null,
  });
});

app.get("/api/analyst/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();
  const { data, error } = await fetchQuoteSummary(
    ticker,
    ["financialData", "recommendationTrend"],
    RESEARCH_TTL_MS,
  );

  if (!data) {
    console.error("Analyst report: ", error);
    // If Yahoo has no data for this ticker, return available: false instead of error
    if (error && error.toLowerCase().includes("no fundamentals data found")) {
      return response.json({ available: false });
    }
    return response.status(500).json({ error: "Yahoo " + error });
  }

  const financialData = data.financialData;
  const trend =
    data.recommendationTrend &&
    data.recommendationTrend.trend &&
    data.recommendationTrend.trend[0];

  if (!financialData && !trend) {
    return response.json({ available: false });
  }

  response.json({
    available: true,
    targetHigh: financialData?.targetHighPrice ?? null,
    targetLow: financialData?.targetLowPrice ?? null,
    targetMean: financialData?.targetMeanPrice ?? null,
    targetMedian: financialData?.targetMedianPrice ?? null,
    recommendationMean: financialData?.recommendationMean ?? null,
    recommendationKey: financialData?.recommendationKey ?? null,
    numberOfAnalysts: financialData?.numberOfAnalystOpinions ?? null,
    strongBuyCount: trend?.strongBuy ?? null,
    buyCount: trend?.buy ?? null,
    holdCount: trend?.hold ?? null,
    sellCount: trend?.sell ?? null,
    strongSellCount: trend?.strongSell ?? null,
  });
});

app.get("/api/fundamentals/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();
  const { data, error } = await fetchQuoteSummary(
    ticker,
    ["financialData", "defaultKeyStatistics", "summaryDetail"],
    RESEARCH_TTL_MS,
  );

  if (!data) {
    console.error("Fundamentals: ", error);
    if (error && error.toLowerCase().includes("no fundamentals data found")) {
      return response.json({ available: false });
    }
    return response.status(500).json({ error: "Yahoo " + error });
  }

  const financialData = data.financialData;
  const keyStats = data.defaultKeyStatistics;

  if (!financialData && !keyStats) {
    return response.json({ available: false });
  }

  const pct = (value) => (typeof value === "number" ? value * 100 : null);

  response.json({
    available: true,
    totalRevenue: financialData?.totalRevenue ?? null,
    grossMargins: pct(financialData?.grossMargins),
    operatingMargins: pct(financialData?.operatingMargins),
    profitMargins: pct(financialData?.profitMargins),
    returnOnEquity: pct(financialData?.returnOnEquity),
    returnOnAssets: pct(financialData?.returnOnAssets),
    totalCash: financialData?.totalCash ?? null,
    totalDebt: financialData?.totalDebt ?? null,
    debtToEquity: financialData?.debtToEquity ?? null,
    freeCashflow: financialData?.freeCashflow ?? null,
    priceToBook: keyStats?.priceToBook ?? null,
    pegRatio: keyStats?.pegRatio ?? null,
    enterpriseToEbitda: keyStats?.enterpriseToEbitda ?? null,
    revenueGrowth: pct(financialData?.revenueGrowth),
    earningsGrowth: pct(financialData?.earningsGrowth),
  });
});

app.get("/api/options/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();

  try {
    const result = await getOptions(ticker);
    const chain = result.options && result.options[0];
    const spotPrice = result.quote?.regularMarketPrice ?? null;

    if (
      !chain ||
      !chain.calls ||
      chain.calls.length === 0 ||
      spotPrice === null
    ) {
      return response.json({ available: false });
    }

    const calls = chain.calls;
    const puts = chain.puts || [];

    let atmCall = calls[0];
    let smallestDiff = Math.abs(calls[0].strike - spotPrice);

    for (const call of calls) {
      const diff = Math.abs(call.strike - spotPrice);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        atmCall = call;
      }
    }

    const atmPut = puts.find((put) => put.strike === atmCall.strike) || null;

    const pickFields = (contract) =>
      contract
        ? {
            bid: contract.bid ?? null,
            ask: contract.ask ?? null,
            lastPrice: contract.lastPrice ?? null,
            impliedVolatility:
              typeof contract.impliedVolatility === "number"
                ? contract.impliedVolatility * 100
                : null,
            volume: contract.volume ?? null,
            openInterest: contract.openInterest ?? null,
          }
        : null;

    response.json({
      available: true,
      expiration: chain.expirationDate ?? null,
      strike: atmCall.strike,
      call: pickFields(atmCall),
      put: pickFields(atmPut),
    });
  } catch (error) {
    console.error("Options: ", error.message);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

app.get("/api/option-chain/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();

  try {
    const result = await getOptions(ticker);
    const chain = result.options && result.options[0];
    const spotPrice = result.quote?.regularMarketPrice ?? null;

    if (
      !chain ||
      !chain.calls ||
      chain.calls.length === 0 ||
      spotPrice === null
    ) {
      return response.json({ available: false });
    }

    const STRIKE_RANGE_PCT = 0.2; // keep payload focused/small for a Roblox client
    const minStrike = spotPrice * (1 - STRIKE_RANGE_PCT);
    const maxStrike = spotPrice * (1 + STRIKE_RANGE_PCT);

    const pickFields = (contract) =>
      contract
        ? {
            contractSymbol: contract.contractSymbol,
            bid: contract.bid ?? null,
            ask: contract.ask ?? null,
            lastPrice: contract.lastPrice ?? null,
            impliedVolatility:
              typeof contract.impliedVolatility === "number"
                ? contract.impliedVolatility * 100
                : null,
            volume: contract.volume ?? null,
            openInterest: contract.openInterest ?? null,
          }
        : null;

    const callsByStrike = new Map(
      chain.calls
        .filter((c) => c.strike >= minStrike && c.strike <= maxStrike)
        .map((c) => [c.strike, c]),
    );
    const putsByStrike = new Map(
      (chain.puts || [])
        .filter((p) => p.strike >= minStrike && p.strike <= maxStrike)
        .map((p) => [p.strike, p]),
    );
    const allStrikes = [
      ...new Set([...callsByStrike.keys(), ...putsByStrike.keys()]),
    ].sort((a, b) => a - b);

    response.json({
      available: true,
      spotPrice,
      expiration: chain.expirationDate ?? null,
      expirationDates: result.expirationDates ?? [],
      strikes: allStrikes.map((strike) => ({
        strike,
        call: pickFields(callsByStrike.get(strike)),
        put: pickFields(putsByStrike.get(strike)),
      })),
    });
  } catch (error) {
    console.error("Option chain: ", error.message);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});


const NEWS_TTL_MS = 10 * 60 * 1000;
const MOVERS_TTL_MS = 2 * 60 * 1000;
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const NEWS_COUNT = 10;
const MOVERS_COUNT = 10;

// Recent headlines mentioning a ticker
app.get("/api/news/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();

  if (!isValidTicker(ticker)) {
    return response.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const items = await cached(`news:${ticker}`, NEWS_TTL_MS, async () => {
      const result = await yahooFinance.search(ticker, {
        newsCount: NEWS_COUNT,
        quotesCount: 0,
      });

      return (result.news || []).map((article) => ({
        title: article.title,
        publisher: article.publisher ?? null,
        link: article.link ?? null,
        publishedAt: article.providerPublishTime
          ? Math.floor(new Date(article.providerPublishTime).getTime() / 1000)
          : null,
        relatedTickers: article.relatedTickers ?? [],
      }));
    });

    response.json({ available: items.length > 0, items });
  } catch (error) {
    console.error("News: ", error);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

// Today's biggest gainers and losers and the most traded US stocks.
// Yahoo's screener response has drifted from yahoo-finance2's schema, so
// validation is skipped and only the fields used here are read.
app.get("/api/movers", async (request, response) => {
  try {
    const movers = await cached("movers", MOVERS_TTL_MS, async () => {
      const fetchScreener = async (scrIds) => {
        const result = await withCrumb(() =>
          yahooFinance.screener({ scrIds, count: MOVERS_COUNT }, undefined, { validateResult: false }),
        );

        return (result.quotes || [])
          .filter((quote) => quote.symbol && quote.regularMarketPrice)
          .map((quote) => ({
            symbol: quote.symbol,
            name: quote.shortName || quote.longName || quote.symbol,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange ?? null,
            changePercent: quote.regularMarketChangePercent ?? null,
            volume: quote.regularMarketVolume ?? null,
          }));
      };

      const [gainers, losers, active] = await Promise.all([
        fetchScreener("day_gainers"),
        fetchScreener("day_losers"),
        fetchScreener("most_actives"),
      ]);

      return { gainers, losers, active };
    });

    response.json(movers);
  } catch (error) {
    console.error("Movers: ", error);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

// What kind of security a ticker is, and its sector and industry for
// stocks (ETFs, crypto and others have none)
app.get("/api/profile/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();

  if (!isValidTicker(ticker)) {
    return response.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const profile = await cached(`profile:${ticker}`, PROFILE_TTL_MS, async () => {
      const result = await withCrumb(() =>
        yahooFinance.quoteSummary(ticker, { modules: ["assetProfile", "quoteType"] }, { validateResult: false }),
      );

      return {
        quoteType: result.quoteType?.quoteType ?? null,
        sector: result.assetProfile?.sector ?? null,
        industry: result.assetProfile?.industry ?? null,
      };
    });

    response.json(profile);
  } catch (error) {
    console.error("Profile: ", error);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

const MAX_BATCH_SYMBOLS = 50;
const SPLITS_TTL_MS = 12 * 60 * 60 * 1000;
const SPLITS_LOOKBACK_SECONDS = 2 * 365 * 24 * 60 * 60;

// Several symbols in one call: ?symbols=AAPL,MSFT,BTC-USD. Returns
// { [symbol]: { price, bid, ask, prevClose, time, marketState } }; bid and
// ask are null when Yahoo has none (crypto, or outside market hours).
app.get("/api/quotes", async (request, response) => {
  const symbols = String(request.query.symbols || "")
    .toUpperCase()
    .split(",")
    .filter((symbol) => symbol !== "");

  if (
    symbols.length === 0 ||
    symbols.length > MAX_BATCH_SYMBOLS ||
    !symbols.every(isValidTicker)
  ) {
    return response.status(400).json({ error: "Invalid symbols" });
  }

  try {
    const quotes = await getQuotes([...new Set(symbols)]);
    const result = {};

    for (const [symbol, quote] of Object.entries(quotes)) {
      result[symbol] = {
        price: quote.regularMarketPrice ?? null,
        bid: quote.bid || null,
        ask: quote.ask || null,
        prevClose: quote.regularMarketPreviousClose ?? null,
        time: quote.regularMarketTime
          ? Math.floor(new Date(quote.regularMarketTime).getTime() / 1000)
          : null,
        marketState: quote.marketState ?? null,
      };
    }

    response.json(result);
  } catch (error) {
    console.error("Quotes: ", error);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

// Stock splits over the last two years: { splits: [{ date, numerator,
// denominator }] }, dates as unix seconds. 4-for-1 is numerator 4.
app.get("/api/splits/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();

  if (!isValidTicker(ticker)) {
    return response.status(400).json({ error: "Invalid ticker" });
  }

  try {
    const splits = await cached(`splits:${ticker}`, SPLITS_TTL_MS, async () => {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const result = await yahooFinance.chart(ticker, {
        period1: nowInSeconds - SPLITS_LOOKBACK_SECONDS,
        period2: nowInSeconds,
        interval: "1d",
        events: "split",
      });

      return ((result.events && result.events.splits) || []).map((split) => ({
        date: Math.floor(new Date(split.date).getTime() / 1000),
        numerator: split.numerator,
        denominator: split.denominator,
      }));
    });

    response.json({ splits });
  } catch (error) {
    console.error("Splits: ", error);
    response.status(500).json({ error: "Yahoo " + error.message });
  }
});

const axios = require("axios");

const ROBLOX_STATS_TTL_MS = 4 * 60 * 1000; // just under the game's five-minute tick
const MAX_ROBLOX_EXPERIENCES = 50; // Roblox's batch limit for these routes
const ROBLOX_TIMEOUT_MS = 10 * 1000;

// Public stats of Roblox experiences for the game's simulated Roblox market.
// Game servers can't call roblox.com, so the backend fetches them:
// ?ids=383310974,1686885941 (universe ids) returns { [universeId]: { name,
// creator, playing, visits, favorites, upVotes, downVotes, created, updated,
// genre } }, times as unix seconds. An id Roblox doesn't return is missing.
app.get("/api/roblox/experiences", async (request, response) => {
  const ids = [...new Set(String(request.query.ids || "").split(",").filter((id) => id !== ""))];

  if (ids.length === 0 || ids.length > MAX_ROBLOX_EXPERIENCES || !ids.every((id) => /^\d{1,15}$/.test(id))) {
    return response.status(400).json({ error: "Invalid ids" });
  }

  const list = ids.sort().join(",");

  try {
    const stats = await cached(`roblox:${list}`, ROBLOX_STATS_TTL_MS, async () => {
      const [games, votes] = await Promise.all([
        axios.get(`https://games.roblox.com/v1/games?universeIds=${list}`, { timeout: ROBLOX_TIMEOUT_MS }),
        axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${list}`, { timeout: ROBLOX_TIMEOUT_MS }),
      ]);
      const votesById = new Map((votes.data.data || []).map((entry) => [entry.id, entry]));
      const toSeconds = (date) => (date ? Math.floor(new Date(date).getTime() / 1000) : null);
      const result = {};

      for (const game of games.data.data || []) {
        const vote = votesById.get(game.id) || {};

        result[game.id] = {
          name: game.name,
          creator: game.creator ? game.creator.name : null,
          playing: game.playing ?? 0,
          visits: game.visits ?? 0,
          favorites: game.favoritedCount ?? 0,
          upVotes: vote.upVotes ?? null,
          downVotes: vote.downVotes ?? null,
          created: toSeconds(game.created),
          updated: toSeconds(game.updated),
          genre: game.genre_l1 || game.genre || null,
        };
      }

      return result;
    });

    response.json(stats);
  } catch (error) {
    console.error("Roblox experiences: ", error.message);
    response.status(500).json({ error: "Roblox " + error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

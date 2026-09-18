// Testing YahooFinance

const express = require('express');
const cors = require('cors');
const { quote } = require('yahoo-finance2/modules');
const app = express();

app.use(cors());
app.use(express.json());

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

async function fetchQuoteSummary(ticker, modules) {
  try {
    const result = await yahooFinance.quoteSummary(ticker, { modules });
    return { data: result, error: null };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

app.get('/api/candles/:ticker', async (request, response) => {
    const ticker = request.params.ticker.toUpperCase();
    const tf = request.query.tf;
    const mode = request.query.mode;

    const intervalMap = {
        '1M': '1m',
        '5M': '5m',
        '30M': '30m',
        'H': '1h',
        'D': '1d'
    };

    const interval = intervalMap[tf];

    if (!interval) {
        return response.status(400).json({ error: "Invalid timeframe mapping"});
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);
    let startInSeconds;

    if (['1m', '5m', '30m'].includes(interval)) {
        startInSeconds = nowInSeconds - (7 * 24 * 60 * 60);
    } else if (interval === '1h') {
        startInSeconds = nowInSeconds - (24 * 60 * 60 * 60);
    } else {
        startInSeconds = nowInSeconds - (2 * 24 * 60 * 60 * 365);
    }



    try {
        console.log(`Sending request to Yahoo for Ticker: [${ticker}] with Interval: [${interval}]`);

        const result = await yahooFinance.chart(ticker, {
            period1: startInSeconds,
            period2: nowInSeconds,
            interval: interval
        });

        console.log("API Keys: ", Object.keys(result || {}));

        let quotes = [];

        if (result && result.quotes) {
            quotes = result.quotes;
        } else if (result && result.chart && result.chart.result && result.chart.result[0]) {
            const rawData = result.chart.result[0];

            if (rawData.timestamp && rawData.indicators && rawData.indicators.quote && rawData.indicators.quote[0]) {
                const timestamps = rawData.timestamp;
                const ohlc = rawData.indicators.quote[0]

                quotes = timestamps.map((ts, index) => ({
                    date: new Date(ts * 1000),
                    open: ohlc.open ? ohlc.open[index] : null,
                    high: ohlc.high ? ohlc.high[index] : null,
                    low: ohlc.low ? ohlc.low[index] : null,
                    close: ohlc.close ? ohlc.close[index] : null,
                    volume: (ohlc.volume && ohlc.volume[index]) ? ohlc.volume[index] : 0
               }));
            }
        }

        if (!quotes || quotes.length === 0) {
            console.warn(`Fallbacks failed for ${ticker}`);
            return response.status(404).json({
                error: `No data found for this ticker. Empty response for ${ticker} on ${interval}`
            });
        }

        const formattedData = quotes
            .filter(candle => candle && candle.open !== null && candle.close !== null)
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

        if (mode === 'live') {
            try {
                const liveQuote = await yahooFinance.quote(ticker);
                if (liveQuote && liveQuote.regularMarketPrice && formattedData.length > 0) {
                    const currentLivePrice = Number(liveQuote.regularMarketPrice);
                    const lastIndex = formattedData.length - 1;

                    formattedData[lastIndex].Close = currentLivePrice;

                    if (currentLivePrice > formattedData[lastIndex].High || formattedData[lastIndex].High === formattedData[lastIndex].Open) {
                        formattedData[lastIndex].High = Math.max(formattedData[lastIndex].Open, currentLivePrice, formattedData[lastIndex].High);
                    }
                    if (currentLivePrice < formattedData[lastIndex].Low || formattedData[lastIndex].Low === formattedData[lastIndex].Open) {
                        formattedData[lastIndex].Low = Math.min(formattedData[lastIndex].Open, currentLivePrice, formattedData[lastIndex].Low);
                    }
                }
            }  catch (quoteError) {
                console.warn("Live tick override: ", quoteError.message);
            }
            response.json(formattedData.slice(-5));
        } else {
            response.json(formattedData);
        }
    } catch (error) {
        console.error("Yahoo: ", error.message);
        response.status(500).json({error: "Yahoo " + error.message});
    }
});

app.get("/api/quote-details/:ticker", async (request, response) => {
  const ticker = request.params.ticker.toUpperCase();
  const { data, error } = await fetchQuoteSummary(ticker, [
    "summaryDetail",
    "defaultKeyStatistics",
    "calendarEvents",
    "price",
  ]);

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
    : calendar.earningsDate ?? null;

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
    dividendYield: (summaryDetail.dividendYield !== null && summaryDetail.dividendYield !== undefined)
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
  const { data, error } = await fetchQuoteSummary(ticker, [
    "financialData",
    "recommendationTrend",
  ]);

  if (!data) {
    console.error("Analyst report: ", error);
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

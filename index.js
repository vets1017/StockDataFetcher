// Testing YahooFinance

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

app.get('/api/candles/:ticker', async (request, response) => {
    const ticker = request.params.ticker.toUpperCase();
    const tf = request.query.tf;

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
        startInSeconds = nowInSeconds - (60* 24 * 60 * 60);
    } else {
        startInSeconds = nowInSeconds - (2 * 365 * 24 * 60 * 60);
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
                    volume: ohlc.volume ? ohlc.volume[index] : 0
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

                if (index > 0) {
                    const prevClose = Number(array[index - 1].close);
                    const maxAllowedDeviation = prevClose * 0.04;

                    if (high - prevClose > maxAllowedDeviation) {
                        high = Math.max(open, close);
                    }

                    if (prevClose - low > maxAllowedDeviation) {
                        low = Math.min(open, close);
                    }
                }

                return {
                    Timestamp: Math.floor(new Date(candle.date).getTime() / 1000),
                    Open: open,
                    High: high,
                    Low: low,
                    Close: close,
                    Volume: Number(candle.volume) || 0,
                };
            });
    
        response.json(formattedData);
    } catch (error) {
        console.error("Yahoo: ", error.message);
        response.status(500).json({error: "Yahoo: " + error.message});
    }    
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
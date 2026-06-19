// const express = require('express');
// const axios = require('axios');
// const cors = require('cors');
// const fs = require('fs');
// const csv = require('csv-parser')
// const path = require('path')

// const app = express();
// app.use(cors());
// app.use(express.json());

// const API_KEY = process.env.API_KEY;

// const TICKERS = ['AAPL', 'NVDA', 'GOOGL'];

// app.get('/api/quotes', async (req, res) => {
//     try {
//         const marketData = {};
//         const requests = TICKERS.map(ticker =>
//             axios.get(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${API_KEY}`)
//         );

//         const responses = await Promise.all(requests);

//         responses.forEach((response, index) => {
//             const ticker = TICKERS[index];
//             const data = response.data;

//             const currentPrice = data.c;
//             const percentChange = data.dp;
            
//             const prefix = percentChange >= 0 ? "+" : "";
//             const changeString = `${prefix}${percentChange.toFixed(2)}%`;

//             marketData[ticker] = {
//                 Price: currentPrice,
//                 Change: changeString,
//                 Open: data.o || currentPrice,
//                 High: data.h || currentPrice,
//                 Low: data.l || currentPrice,
//                 PreviousClose: data.pc || currentPrice,
//             };
//         });

//         console.log("Success");
//         res.json(marketData);
//     } catch (error) {
//         console.error("Error fetching stock data:", error.message);
//         res.status(500).json({ error: "Failed to fetch stock data" });
//     }
// })

// app.get('/', (req, res) => {
//     res.send('Live');
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

// app.get('/api/candles/:ticker', (req, res) => {
//     const requestedTicker = req.params.ticker.toUpperCase();
//     const timeframe = req.query.timeframe;

//     const fileMap = {
//         'D': 'GOOG_1day_sample.csv',
//         'H': 'GOOG_1hour_sample.csv',
//         '1M': 'GOOG_1min_sample.csv',
//         '5M': 'GOOG_5min_sample.csv',
//         '30M': 'GOOG_30min_sample.csv',
//     };

//     if (requestedTicker === 'GOOG' && fileMap[timeframe]) { //onlyforgoog
//         const results = [];
//         const fileName = fileMap[timeframe];

//         const targetDirectory = path.join(__dirname, 'historical_data', 'GOOG');
//         const fullFilePath = path.join(targetDirectory, fileName)

//         if (!fs.existsSync(fullFilePath)) {
//             return res.status(404).json({ error: `File ${fullFilePath} not found` });
//         }

//         fs.createReadStream(fullFilePath)
//             .pipe(csv())
//             .on('data', (row) => {
//                 if (!row.close || !row.timestamp) return;
                
//                 const unixTime = Math.floor(new Date(row.timestamp).getTime() / 1000);
//                 results.push({
//                     Timestamp: unixTime,
//                     Open: parseFloat(row.open),
//                     High: parseFloat(row.high),
//                     Low: parseFloat(row.low),
//                     Close: parseFloat(row.close),
//                     Volume: parseInt(row.volume, 10)
//                 });
//             })
//             .on('end', () => {
//                 res.json(results);
//             });
//     } else {
//         res.status(400).json({ error: "Historical data not available for this ticker or timeframe" });
//     }
// });

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
            .map(candle => ({
                Timestamp: Math.floor(new Date(candle.date).getTime() / 1000),
                Open: Number(candle.open),
                High: Number(candle.high),
                Low: Number(candle.low),
                Close: Number(candle.close),
                Volume: Number(candle.volume || 0)
            }));
        
        console.log(`Success!`);

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
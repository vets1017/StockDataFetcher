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

    const now = new Date();
    
    let period1 = new Date();

    if (['1m', '5m', '30m'].includes(interval)) {
        period1.setDate(now.getDate() - 5);
    } else if (interval === '1h') {
        period1.setDate(now.getDate() - 60);
    } else {
        period1.setFullYear(now.getFullYear() - 2);
    }

    try {
        console.log(`Fetching ${ticker} on ${interval}`);

        const result = await yahooFinance.historical(ticker, {
            period1: period1,
            interval: interval
        });

        if (!result || result.length === 0) {
            return response.status(404).json({ error: "No data found for this ticker."});
        }

        const formattedData = result.map(candle => ({
            Timestamp: Math.floor(candle.date.getTime() / 1000),
            Open: candle.open,
            High: candle.high,
            Low: candle.low,
            Close: candle.close,
            Volume: candle.volume
        }));
        
        response.json(formattedData);
    } catch (error) {
        console.error("Yahoo Fetch Error:", error.message);
        response.status(500).json({ error: "Yahoo Error" + error.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
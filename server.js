const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_URL = 'd86kub9r01qgiu45sau0d86kub9r01qgiu45saug';

let stockData = {
    AMZN: { price: 0, previousClose: 0, change: 0, percentChange: 0 },
}

let chartData = {}

function getTimeframe(timeframe) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - (timeframe * 24 * 60 * 60);
    return { from, to };
}

async function fetchStockData() {
    const symbols = Object.keys(stockData);
    for (let symbol of symbols) {
        try {
            const response = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_URL}`);
            const data = response.data;
            stockData[symbol] = {
                price: data.c,
                previousClose: data.pc,
                percentChange: data.dp,
                change: data.d,
            };
            console.log(`Updated data for ${symbol}:`, stockData[symbol]);
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.error(`Rate limit exceeded for ${symbol}. Please try again later.`);
            } else {
                console.error(`Error fetching data for ${symbol}:`, error.message);
            }
        }
    }
}

fetchStockData();
setInterval(fetchStockData, 60000);

app.get('/api/stock/:symbol', (req, res) => {

    // const symbol = req.params.symbol.toUpperCase();
    // const currentTime = Date.now();

    // if (chartData[symbol] && (currentTime - chartData[symbol].timestamp < 60000)) {
    //     console.log(`Serving cached chart data for ${symbol}`);
    //     return res.json(chartData[symbol].data);
    // }

    // try {
    //     const { from, to } = getTimeframe(7);
    //     const resolution = 'D';
    //     const url = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&token=${API_URL}`;
    //     const response = await axios.get(url);

    //     if (response.data.s === 'no_data') {
    //         return res.status(404).json({ error: 'Market closed or no data available'});
    //     }

    //     let formmttedData = [];
    //     for (let i = 0; i < response.data.t.length; i++) {
    //         formattedData.push({
    //             time: response.data.t[i] * 1000,
    //             open: response.data.o[i],
    //             high: response.data.h[i],
    //             low: response.data.l[i],
    //             close: response.data.c[i],
    //         });
    //     }

    //     chartData[symbol] = {
    //         data: formattedData,
    //         timestamp: currentTime,
    //     };

    //     console.log(`Fetched new chart data for ${symbol}`);
    //     res.json(formattedData);
    // } catch (error) {
    //     console.error(`Error fetching chart data for ${symbol}:`, error.message);
    //     res.status(500).json({ error: 'Failed to fetch chart data' });
    // }

    res.json(stockData);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
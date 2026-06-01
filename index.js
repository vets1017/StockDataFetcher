const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;

const TICKERS = ['AAPL', 'NVDA', 'GOOGL'];

app.get('/api/quotes', async (req, res) => {
    try {
        const marketData = {};
        const requests = TICKERS.map(ticker =>
            axios.get(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${API_KEY}`)
        );

        const responses = await Promise.all(requests);

        responses.forEach((response, index) => {
            const ticker = TICKERS[index];
            const data = response.data;

            const currentPrice = data.c;
            const percentChange = data.dp;
            
            const prefix = percentChange >= 0 ? "+" : "";
            const changeString = `${prefix}${percentChange.toFixed(2)}%`;

            marketData[ticker] = {
                Price: currentPrice,
                Change: changeString,
                Open: data.o || currentPrice,
                High: data.h || currentPrice,
                Low: data.l || currentPrice,
                PreviousClose: data.pc || currentPrice,
            };
        });

        console.log("Success");
        res.json(marketData);
    } catch (error) {
        console.error("Error fetching stock data:", error.message);
        res.status(500).json({ error: "Failed to fetch stock data" });
    }
})

app.get('/', (req, res) => {
    res.send('Live');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
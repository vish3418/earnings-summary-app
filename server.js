const express = require("express");
const cors = require("cors");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// API Configuration - Only need Finnhub and OpenAI
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;

// Cache to avoid excessive API calls
const cache = new Map();
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

// Helper function to get cached data
function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

// Helper function to set cache
function setCacheData(key, data) {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// Get stock quote and company info from Finnhub
async function getStockQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    const quoteResponse = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
    );

    const profileResponse = await axios.get(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_KEY}`
    );

    const data = {
      symbol,
      name: profileResponse.data.name || symbol,
      price: quoteResponse.data.c,
      change: quoteResponse.data.d,
      changePercent: quoteResponse.data.dp,
      previousClose: quoteResponse.data.pc,
      high: quoteResponse.data.h,
      low: quoteResponse.data.l,
      marketCap: profileResponse.data.marketCapitalization,
      industry: profileResponse.data.finnhubIndustry
    };

    setCacheData(cacheKey, data);
    return data;
  } catch (error) {
    console.error("Error fetching quote:", error);
    throw error;
  }
}

// Get basic earnings data from Finnhub
async function getEarningsData(symbol) {
  const cacheKey = `earnings_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    // Get basic financials from Finnhub
    const metricsResponse = await axios.get(
      `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${FINNHUB_KEY}`
    );

    const metrics = metricsResponse.data.metric || {};

    // Get earnings calendar if available
    let earningsDate = "N/A";
    try {
      const today = new Date();
      const fromDate = new Date(today.setMonth(today.getMonth() - 3))
        .toISOString()
        .split("T")[0];
      const toDate = new Date(today.setMonth(today.getMonth() + 6))
        .toISOString()
        .split("T")[0];

      const earningsCalendar = await axios.get(
        `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&symbol=${symbol}&token=${FINNHUB_KEY}`
      );

      if (
        earningsCalendar.data.earningsCalendar &&
        earningsCalendar.data.earningsCalendar.length > 0
      ) {
        earningsDate = earningsCalendar.data.earningsCalendar[0].date;
      }
    } catch (e) {
      console.log("Could not fetch earnings calendar");
    }

    const data = {
      latestEarnings: {
        reportedEPS: metrics.epsExclExtraItemsTTM || "N/A",
        estimatedEPS: metrics.epsEstimate || "N/A",
        surprise: "N/A",
        surprisePercentage: "N/A",
        nextEarningsDate: earningsDate
      },
      overview: {
        revenue: metrics.revenueTTM ? metrics.revenueTTM * 1000000 : null,
        revenuePerShare: metrics.revenuePerShareTTM || null,
        profitMargin: metrics.netProfitMarginTTM
          ? (metrics.netProfitMarginTTM / 100).toFixed(4)
          : null,
        operatingMargin: metrics.operatingMarginTTM
          ? (metrics.operatingMarginTTM / 100).toFixed(4)
          : null,
        returnOnEquity: metrics.roeTTM || null,
        peRatio: metrics.peExclExtraTTM || null,
        forwardPE: metrics.peTTM || null,
        pegRatio: metrics.pegRatio || null,
        beta: metrics.beta || null,
        weekHigh52: metrics["52WeekHigh"] || null,
        weekLow52: metrics["52WeekLow"] || null
      }
    };

    setCacheData(cacheKey, data);
    return data;
  } catch (error) {
    console.error("Error fetching earnings:", error);
    throw error;
  }
}

// Generate AI summary using OpenAI
async function generateAISummary(stockData, earningsData) {
  try {
    // Build a prompt based on available data
    let dataPoints = [];

    // Always available from Finnhub
    dataPoints.push(`Current Price: $${stockData.price}`);
    dataPoints.push(
      `Daily Change: ${stockData.change} (${stockData.changePercent}%)`
    );

    if (stockData.marketCap) {
      dataPoints.push(
        `Market Cap: $${(stockData.marketCap / 1000).toFixed(2)}B`
      );
    }

    if (stockData.industry) {
      dataPoints.push(`Industry: ${stockData.industry}`);
    }

    // Add available earnings data
    if (earningsData.latestEarnings.reportedEPS !== "N/A") {
      dataPoints.push(`EPS (TTM): $${earningsData.latestEarnings.reportedEPS}`);
    }

    if (earningsData.overview.revenue) {
      dataPoints.push(
        `Revenue (TTM): $${(earningsData.overview.revenue / 1000000000).toFixed(
          2
        )}B`
      );
    }

    if (earningsData.overview.profitMargin) {
      dataPoints.push(
        `Profit Margin: ${(
          parseFloat(earningsData.overview.profitMargin) * 100
        ).toFixed(1)}%`
      );
    }

    if (earningsData.overview.peRatio) {
      dataPoints.push(`P/E Ratio: ${earningsData.overview.peRatio}`);
    }

    if (earningsData.overview.weekLow52 && earningsData.overview.weekHigh52) {
      dataPoints.push(
        `52-Week Range: $${earningsData.overview.weekLow52} - $${earningsData.overview.weekHigh52}`
      );
    }

    const prompt = `
        Analyze the following data for ${stockData.name} (${stockData.symbol}):
        
        ${dataPoints.join("\n")}
        
        Provide a concise summary (3-4 sentences) about the stock's current performance and what investors should note.
        Focus on the available data and current price action.
        `;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a financial analyst providing concise, insightful investment summaries. Work with the data available."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating AI summary:", error);
    return generateTemplateSummary(stockData, earningsData);
  }
}

// Fallback template-based summary
function generateTemplateSummary(stockData, earningsData) {
  const overview = earningsData.overview;

  let summary = `${stockData.name} (${stockData.symbol}) is currently trading at $${stockData.price}, `;

  if (stockData.changePercent >= 0) {
    summary += `up ${stockData.changePercent}% today. `;
  } else {
    summary += `down ${Math.abs(stockData.changePercent)}% today. `;
  }

  if (overview.revenue) {
    summary += `The company generated revenue of $${(
      overview.revenue / 1000000000
    ).toFixed(2)}B over the trailing twelve months`;
    if (overview.profitMargin) {
      const margin = parseFloat(overview.profitMargin) * 100;
      summary += ` with a profit margin of ${margin.toFixed(1)}%. `;
    } else {
      summary += ". ";
    }
  }

  if (overview.peRatio && overview.peRatio > 0) {
    const pe = parseFloat(overview.peRatio);
    summary += `With a P/E ratio of ${pe.toFixed(1)}, `;
    if (pe < 15) {
      summary +=
        "the stock appears attractively valued compared to market averages. ";
    } else if (pe > 30) {
      summary += "investors are paying a premium for expected growth. ";
    } else {
      summary += "the valuation is in line with market norms. ";
    }
  }

  if (overview.weekHigh52 && overview.weekLow52) {
    const range52w = (
      ((stockData.price - overview.weekLow52) /
        (overview.weekHigh52 - overview.weekLow52)) *
      100
    ).toFixed(0);
    summary += `The stock is trading at ${range52w}% of its 52-week range. `;
  }

  return summary;
}

// API Routes

// Get earnings summary for a single stock
app.get("/api/earnings/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // Fetch data in parallel
    const [stockData, earningsData] = await Promise.all([
      getStockQuote(symbol),
      getEarningsData(symbol)
    ]);

    // Generate AI summary
    const summary = await generateAISummary(stockData, earningsData);

    res.json({
      success: true,
      data: {
        stock: stockData,
        earnings: earningsData,
        summary
      }
    });
  } catch (error) {
    console.error("Error in /api/earnings:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch earnings data",
      message: error.message
    });
  }
});

// Get earnings summaries for multiple stocks
app.post("/api/earnings/batch", async (req, res) => {
  try {
    const { symbols } = req.body;

    if (!symbols || !Array.isArray(symbols)) {
      return res.status(400).json({
        success: false,
        error: "Please provide an array of symbols"
      });
    }

    const results = await Promise.all(
      symbols.map(async symbol => {
        try {
          const [stockData, earningsData] = await Promise.all([
            getStockQuote(symbol),
            getEarningsData(symbol)
          ]);

          const summary = await generateAISummary(stockData, earningsData);

          return {
            symbol,
            success: true,
            data: {
              stock: stockData,
              earnings: earningsData,
              summary
            }
          };
        } catch (error) {
          return {
            symbol,
            success: false,
            error: error.message
          };
        }
      })
    );

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error("Error in /api/earnings/batch:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch batch earnings data",
      message: error.message
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "API is running (Finnhub-only version)",
    timestamp: new Date().toISOString(),
    apis: {
      finnhub: !!FINNHUB_KEY,
      openai: !!OPENAI_KEY
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log("Using Finnhub-only version (no Alpha Vantage required)");
});

// Export for testing
module.exports = app;

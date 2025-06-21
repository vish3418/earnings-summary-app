// server.js - Node.js/Express Backend with Financial APIs and AI Summarization

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

// API Configuration
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const FINNHUB_KEY = process.env.FINNHUB_KEY;

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

// Get stock quote and company info
async function getStockQuote(symbol) {
  const cacheKey = `quote_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    // Using Finnhub for real-time quotes (better free tier)
    const quoteResponse = await axios.get(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
    );

    const profileResponse = await axios.get(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_KEY}`
    );

    const data = {
      symbol,
      name: profileResponse.data.name,
      price: quoteResponse.data.c,
      change: quoteResponse.data.d,
      changePercent: quoteResponse.data.dp,
      previousClose: quoteResponse.data.pc,
      marketCap: profileResponse.data.marketCapitalization
    };

    setCacheData(cacheKey, data);
    return data;
  } catch (error) {
    console.error("Error fetching quote:", error);
    throw error;
  }
}

// Get earnings data
async function getEarningsData(symbol) {
  const cacheKey = `earnings_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;

  try {
    // Alpha Vantage for earnings data
    const response = await axios.get(
      `https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`
    );

    // Log to debug
    console.log(
      `Earnings response for ${symbol}:`,
      JSON.stringify(response.data).substring(0, 200)
    );

    // Check if we have the expected data structure
    if (
      !response.data ||
      (!response.data.quarterlyEarnings && !response.data.annualEarnings)
    ) {
      console.log("No earnings data in response for", symbol);
      throw new Error("No earnings data available");
    }

    const quarterlyEarnings = response.data.quarterlyEarnings || [];
    const latestEarnings = quarterlyEarnings[0] || {};

    // Get company overview for more context
    let overviewData = {};
    try {
      const overviewResponse = await axios.get(
        `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`
      );

      // Check if we got rate limited
      if (!overviewResponse.data.Note && !overviewResponse.data.Information) {
        overviewData = overviewResponse.data;
      }
    } catch (err) {
      console.log("Could not fetch overview data:", err.message);
    }

    const data = {
      latestEarnings: {
        reportedDate: latestEarnings.reportedDate || "N/A",
        reportedEPS: latestEarnings.reportedEPS || "N/A",
        estimatedEPS: latestEarnings.estimatedEPS || "N/A",
        surprise: latestEarnings.surprise || "N/A",
        surprisePercentage: latestEarnings.surprisePercentage || "N/A"
      },
      overview: {
        revenue: overviewData.RevenueTTM || null,
        revenuePerShare: overviewData.RevenuePerShareTTM || null,
        profitMargin: overviewData.ProfitMargin || null,
        operatingMargin: overviewData.OperatingMarginTTM || null,
        returnOnEquity: overviewData.ReturnOnEquityTTM || null,
        peRatio: overviewData.PERatio || null,
        forwardPE: overviewData.ForwardPE || null,
        pegRatio: overviewData.PEGRatio || null
      },
      historicalEarnings: quarterlyEarnings.slice(0, 4) // Last 4 quarters
    };

    setCacheData(cacheKey, data);
    return data;
  } catch (error) {
    console.error("Error fetching earnings for", symbol, ":", error.message);

    // Return a proper error structure instead of throwing
    return {
      latestEarnings: {
        reportedDate: "N/A",
        reportedEPS: "N/A",
        estimatedEPS: "N/A",
        surprise: "N/A",
        surprisePercentage: "N/A"
      },
      overview: {},
      historicalEarnings: []
    };
  }
}
// Generate AI summary using OpenAI
async function generateAISummary(stockData, earningsData) {
  try {
    const prompt = `
        Analyze the following earnings data for ${stockData.name} (${
      stockData.symbol
    }):
        
        Current Price: $${stockData.price}
        Daily Change: ${stockData.change} (${stockData.changePercent}%)
        Market Cap: $${(stockData.marketCap / 1000).toFixed(2)}B
        
        Latest Earnings:
        - Reported EPS: $${earningsData.latestEarnings.reportedEPS}
        - Estimated EPS: $${earningsData.latestEarnings.estimatedEPS}
        - Surprise: ${earningsData.latestEarnings.surprisePercentage}%
        
        Company Metrics:
        - Revenue (TTM): $${(
          earningsData.overview.revenue / 1000000000
        ).toFixed(2)}B
        - Profit Margin: ${earningsData.overview.profitMargin}
        - P/E Ratio: ${earningsData.overview.peRatio}
        - Forward P/E: ${earningsData.overview.forwardPE}
        
        Provide a concise summary (3-4 sentences) of the company's earnings performance, 
        key highlights, and what investors should note. Focus on the most important insights.
        `;

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a financial analyst providing concise, insightful earnings summaries."
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
    // Fallback to template-based summary
    return generateTemplateSummary(stockData, earningsData);
  }
}

// Fallback template-based summary
function generateTemplateSummary(stockData, earningsData) {
  const earnings = earningsData.latestEarnings;
  const overview = earningsData.overview;

  const epsBeat =
    parseFloat(earnings.reportedEPS) > parseFloat(earnings.estimatedEPS);
  const surprisePercent = parseFloat(earnings.surprisePercentage);

  let summary = `${stockData.name} (${stockData.symbol}) `;

  if (epsBeat) {
    summary += `beat earnings expectations with EPS of $${
      earnings.reportedEPS
    } vs. estimated $${
      earnings.estimatedEPS
    }, a positive surprise of ${Math.abs(surprisePercent)}%. `;
  } else {
    summary += `missed earnings expectations with EPS of $${
      earnings.reportedEPS
    } vs. estimated $${earnings.estimatedEPS}, falling short by ${Math.abs(
      surprisePercent
    )}%. `;
  }

  if (overview.revenue) {
    summary += `The company reported TTM revenue of $${(
      overview.revenue / 1000000000
    ).toFixed(2)}B `;

    if (overview.profitMargin) {
      const margin = parseFloat(overview.profitMargin) * 100;
      summary += `with a profit margin of ${margin.toFixed(1)}%. `;
    }
  }

  if (overview.peRatio) {
    const pe = parseFloat(overview.peRatio);
    if (pe > 0 && pe < 100) {
      summary += `Trading at a P/E ratio of ${pe.toFixed(1)}, `;
      if (pe < 15) {
        summary += "the stock appears to be valued conservatively. ";
      } else if (pe > 30) {
        summary += "the stock reflects high growth expectations. ";
      } else {
        summary += "the valuation appears reasonable relative to the market. ";
      }
    }
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
    message: "API is running",
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});

// Export for testing
module.exports = app;

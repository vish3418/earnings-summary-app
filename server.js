// server.js - Simplified version using only Finnhub API

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

// [Rest of the code continues with generateAISummary, routes, etc...]

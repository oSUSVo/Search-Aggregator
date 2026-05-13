import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  if (/^\d{8}$/.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    return new Date(`${year}-${month}-${day}T00:00:00Z`).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stripHtml(value = '') {
  return value.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

function escapeRegExp(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRelatedKeywords(items, query) {
  const stopWords = new Set([
    '있다', '대한', '관련', '기자', '뉴스', '오늘', '이번', '통해', '위해', '에서', '으로', '하는', '했다', '한다', '것으로',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will'
  ]);
  const queryTokens = new Set((query.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) || []));
  const counts = new Map();

  for (const item of items) {
    const text = `${item.title} ${item.snippet}`.toLowerCase();
    const tokens = text.match(/[a-z0-9가-힣]{2,}/g) || [];

    for (const token of tokens) {
      if (stopWords.has(token) || queryTokens.has(token)) {
        continue;
      }

      if (query && new RegExp(escapeRegExp(query), 'i').test(token)) {
        continue;
      }

      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ko'))
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));
}

function extractMetaImage(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return new URL(match[1], pageUrl).toString();
      } catch {
        return null;
      }
    }
  }

  return null;
}

async function fetchPreviewImage(url) {
  if (!url) {
    return null;
  }

  try {
    const response = await axios.get(url, {
      timeout: 5000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      }
    });

    return extractMetaImage(String(response.data || ''), url);
  } catch {
    return null;
  }
}

function extractGoogleDate(item) {
  const tags = item?.pagemap?.metatags?.[0] ?? {};
  return (
    tags['article:published_time'] ||
    tags['article:modified_time'] ||
    tags['og:updated_time'] ||
    tags['date'] ||
    tags['dc.date'] ||
    null
  );
}

const NAVER_SEARCH_TYPES = [
  { key: 'news', path: 'news.json', label: '뉴스', sort: 'date' },
  { key: 'web', path: 'webkr.json', label: '웹문서', sort: 'date' },
  { key: 'blog', path: 'blog.json', label: '블로그', sort: 'date' }
];

async function searchNaverType(type, query, start = 1, display = 10) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  const config = NAVER_SEARCH_TYPES.find((item) => item.key === type);

  if (!clientId || !clientSecret || !config) {
    return { provider: 'naver', items: [], skipped: true, reason: 'Missing API credentials' };
  }

  const response = await axios.get(`https://openapi.naver.com/v1/search/${config.path}`, {
    params: {
      query,
      display,
      start,
      sort: config.sort
    },
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret
    },
    timeout: 10000
  });

  return {
    provider: 'naver',
    type,
    label: config.label,
    total: response.data.total || 0,
    start: response.data.start || start,
    display: response.data.display || display,
    items: (response.data.items || []).map((item) => ({
      kind: 'result',
      source: 'naver',
      sourceType: type,
      sourceLabel: config.label,
      title: stripHtml(item.title),
      snippet: stripHtml(item.description),
      url: item.originallink || item.link,
      publishedAt: toIsoDate(item.pubDate || item.postdate)
    }))
  };
}

async function searchGoogle(query) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !searchEngineId) {
    return { provider: 'google', items: [], skipped: true, reason: 'Missing API credentials' };
  }

  const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
    params: {
      key: apiKey,
      cx: searchEngineId,
      q: query,
      num: 10,
      sort: 'date'
    },
    timeout: 10000
  });

  return {
    provider: 'google',
    items: (response.data.items || []).map((item) => ({
      kind: 'result',
      source: 'google',
      title: item.title?.trim() || 'Untitled',
      snippet: item.snippet?.trim() || '',
      url: item.link,
      publishedAt: toIsoDate(extractGoogleDate(item))
    }))
  };
}

function getProviderErrorMessage(error) {
  const apiMessage = error?.response?.data?.errorMessage || error?.response?.data?.error?.message;
  if (apiMessage) {
    return apiMessage;
  }

  if (error?.response?.status) {
    return `Request failed with status ${error.response.status}`;
  }

  return error?.message || 'Search failed';
}

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const start = Math.max(1, Number.parseInt(String(req.query.start || '1'), 10) || 1);
  const display = Math.min(10, Math.max(1, Number.parseInt(String(req.query.display || '10'), 10) || 10));

  if (!query) {
    return res.status(400).json({ message: 'Query parameter `q` is required.' });
  }

  const providerResults = await Promise.allSettled(
    NAVER_SEARCH_TYPES.map((type) => searchNaverType(type.key, query, start, display))
  );
  const providers = NAVER_SEARCH_TYPES.map((type) => `naver:${type.key}`);
  const providerStatus = [];
  const items = [];
  const sourceCounts = {};
  const totalBySource = {};

  for (const [index, result] of providerResults.entries()) {
    if (result.status === 'rejected') {
      providerStatus.push({
        provider: providers[index],
        ok: false,
        skipped: false,
        message: getProviderErrorMessage(result.reason),
        count: 0
      });
      continue;
    }

    sourceCounts[result.value.type] = result.value.items.length;
    totalBySource[result.value.type] = result.value.total || 0;
    providerStatus.push({
      provider: providers[index],
      ok: !result.value.skipped,
      skipped: Boolean(result.value.skipped),
      message: result.value.reason || null,
      count: result.value.items.length
    });

    items.push(...result.value.items);
  }

  const deduped = new Map();

  for (const item of items) {
    if (!item.url || deduped.has(item.url)) {
      continue;
    }

    deduped.set(item.url, item);
  }

  const sortedItems = Array.from(deduped.values()).sort((left, right) => {
    const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
    const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
    return rightTime - leftTime;
  });

  const itemsWithImages = await Promise.all(
    sortedItems.map(async (item) => ({
      ...item,
      previewImage: await fetchPreviewImage(item.url)
    }))
  );

  const totalAvailable = Object.values(totalBySource).reduce((sum, count) => sum + count, 0) || itemsWithImages.length;
  const nextStart = start + display;
  const hasMore = Object.values(totalBySource).some((count) => nextStart <= count);

  return res.json({
    query,
    count: itemsWithImages.length,
    totalAvailable,
    sourceCounts,
    totalBySource,
    start,
    display,
    nextStart: hasMore ? nextStart : null,
    hasMore,
    relatedKeywords: buildRelatedKeywords(itemsWithImages, query),
    providerStatus,
    items: itemsWithImages
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Search API listening on http://localhost:${port}`);
});

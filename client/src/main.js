import './styles.css';

const app = document.querySelector('#app');
const PAGE_SIZE = 5;
const SERVER_PAGE_SIZE = 10;
const RECENT_SEARCHES_KEY = 'search-aggregator.recent-searches';
const SEARCH_CACHE_PREFIX = 'search-aggregator.cache.';
const FILTER_OPTIONS = [
  { key: 'all', label: '전체' },
  { key: 'news', label: '뉴스' },
  { key: 'web', label: '웹문서' },
  { key: 'blog', label: '블로그' }
];

let latestData = null;
let visibleCount = PAGE_SIZE;
let loadMoreObserver = null;
let isFetchingMore = false;
let activeFilter = 'all';

app.innerHTML = `
  <main class="layout">
    <section class="hero">
      <p class="eyebrow">Search Aggregator</p>
      <h1>검색어와 관련된 정보를 빠르게 모아봅니다.</h1>
      <form class="search-form" id="search-form">
        <input
          id="query"
          name="query"
          type="search"
          placeholder="검색어를 입력하세요"
          autocomplete="off"
          required
        />
        <button type="submit">검색</button>
      </form>
      <p class="helper">검색어와 관련된 링크와 요약을 모아 최신순으로 보여줍니다.</p>
    </section>
    <section class="content-grid">
      <aside class="related-panel" id="related-panel"></aside>
      <section class="results" id="results"></section>
    </section>
  </main>
  <button class="scroll-top" id="scroll-top" type="button" aria-label="최상단으로 이동">TOP</button>
`;

const form = document.querySelector('#search-form');
const input = document.querySelector('#query');
const results = document.querySelector('#results');
const relatedPanel = document.querySelector('#related-panel');
const scrollTopButton = document.querySelector('#scroll-top');

function getSearchUrl(query, filter = activeFilter) {
  const url = new URL(window.location.href);

  if (query) {
    url.searchParams.set('q', query);
  } else {
    url.searchParams.delete('q');
  }

  url.searchParams.delete('start');
  url.searchParams.delete('display');

  if (filter && filter !== 'all') {
    url.searchParams.set('type', filter);
  } else {
    url.searchParams.delete('type');
  }

  return `${url.pathname}${url.search}`;
}

function readRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeRecentSearches(query) {
  const next = [query, ...readRecentSearches().filter((item) => item !== query)].slice(0, 10);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
}

function getCachedSearch(query) {
  try {
    return JSON.parse(sessionStorage.getItem(`${SEARCH_CACHE_PREFIX}${query}`) || 'null');
  } catch {
    return null;
  }
}

function setCachedSearch(query, data) {
  sessionStorage.setItem(`${SEARCH_CACHE_PREFIX}${query}`, JSON.stringify(data));
}

function escapeHtml(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) {
    return '날짜 정보 없음';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function renderStatus(providerStatus = []) {
  return '';
}

function disconnectLoadMoreObserver() {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
}

function mergeUniqueItems(existingItems, newItems) {
  const seen = new Set(existingItems.map((item) => item.url));
  const merged = [...existingItems];

  for (const item of newItems) {
    if (seen.has(item.url)) {
      continue;
    }

    seen.add(item.url);
    merged.push(item);
  }

  return merged;
}

function mergeKeywords(existingKeywords = [], newKeywords = []) {
  const counts = new Map();

  for (const keyword of [...existingKeywords, ...newKeywords]) {
    counts.set(keyword.keyword, (counts.get(keyword.keyword) || 0) + keyword.count);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ko'))
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));
}

function getFilteredItems(data) {
  if (!data) {
    return [];
  }

  if (activeFilter === 'all') {
    return data.items;
  }

  return data.items.filter((item) => item.sourceType === activeFilter);
}

function renderSidebar(data) {
  const recentSearches = readRecentSearches();
  const relatedKeywords = data?.relatedKeywords || [];

  if (!recentSearches.length && !relatedKeywords.length) {
    relatedPanel.innerHTML = '';
    return;
  }

  relatedPanel.innerHTML = `
    ${recentSearches.length ? `
      <div class="related-card">
        <h2>최근 검색</h2>
        <div class="related-list">
          ${recentSearches
            .map(
              (item) => `
                <button class="related-chip recent" type="button" data-query="${escapeHtml(item)}">
                  ${escapeHtml(item)}
                </button>
              `
            )
            .join('')}
        </div>
      </div>
    ` : ''}
    ${relatedKeywords.length ? `
      <div class="related-card">
        <h2>관련 검색어</h2>
        <div class="related-list">
          ${relatedKeywords
          .map(
            (item) => `
              <button class="related-chip" type="button" data-keyword="${escapeHtml(item.keyword)}">
                ${escapeHtml(item.keyword)}
              </button>
            `
          )
          .join('')}
        </div>
      </div>
    ` : ''}
  `;

  for (const button of relatedPanel.querySelectorAll('[data-query]')) {
    button.addEventListener('click', () => {
      input.value = button.dataset.query || '';
      form.requestSubmit();
    });
  }

  for (const button of relatedPanel.querySelectorAll('[data-keyword]')) {
    button.addEventListener('click', () => {
      input.value = button.dataset.keyword || '';
      form.requestSubmit();
    });
  }
}

async function fetchSearchPage(query, start) {
  const response = await fetch(`http://localhost:4000/api/search?q=${encodeURIComponent(query)}&start=${start}&display=${SERVER_PAGE_SIZE}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || '검색 요청에 실패했습니다.');
  }

  return data;
}

async function runSearch(query, options = {}) {
  const { useCache = true, updateHistory = true, filter = activeFilter } = options;

  if (!query) {
    return;
  }

  input.value = query;
  results.innerHTML = '<div class="empty">검색 중...</div>';
  renderSidebar(null);

  try {
    activeFilter = FILTER_OPTIONS.some((option) => option.key === filter) ? filter : 'all';
    let data = useCache ? getCachedSearch(query) : null;

    if (!data) {
      data = await fetchSearchPage(query, 1);
      setCachedSearch(query, data);
    }

    visibleCount = PAGE_SIZE;
    isFetchingMore = false;
    writeRecentSearches(query);

    if (updateHistory) {
      window.history.pushState({ query, filter: activeFilter }, '', getSearchUrl(query, activeFilter));
    }

    renderResults(data);
  } catch (error) {
    latestData = null;
    disconnectLoadMoreObserver();
    results.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadMoreResults() {
  if (!latestData || isFetchingMore) {
    return;
  }

  if (visibleCount < latestData.items.length) {
    visibleCount = Math.min(visibleCount + PAGE_SIZE, latestData.items.length);
    renderResults(latestData);
    return;
  }

  if (!latestData.hasMore || !latestData.nextStart) {
    return;
  }

  isFetchingMore = true;

  try {
    const nextPage = await fetchSearchPage(latestData.query, latestData.nextStart);
    const mergedItems = mergeUniqueItems(latestData.items, nextPage.items);
    latestData = {
      ...latestData,
      items: mergedItems,
      count: mergedItems.length,
      totalAvailable: nextPage.totalAvailable,
      sourceCounts: nextPage.sourceCounts,
      totalBySource: nextPage.totalBySource,
      nextStart: nextPage.nextStart,
      hasMore: nextPage.hasMore,
      relatedKeywords: mergeKeywords(latestData.relatedKeywords, nextPage.relatedKeywords)
    };
    setCachedSearch(latestData.query, latestData);
    writeRecentSearches(latestData.query);
    visibleCount = Math.min(visibleCount + PAGE_SIZE, latestData.items.length);
    renderResults(latestData);
  } finally {
    isFetchingMore = false;
  }
}

function setupLoadMoreObserver() {
  disconnectLoadMoreObserver();

  if (!latestData || (!latestData.hasMore && visibleCount >= latestData.items.length)) {
    return;
  }

  const sentinel = document.querySelector('#load-more-sentinel');
  if (!sentinel) {
    return;
  }

  loadMoreObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) {
      return;
    }

    loadMoreResults();
  }, {
    rootMargin: '200px 0px'
  });

  loadMoreObserver.observe(sentinel);
}

function renderResults(data) {
  latestData = data;
  renderSidebar(data);
  const filteredItems = getFilteredItems(data);

  if (!data.items.length) {
    disconnectLoadMoreObserver();
    results.innerHTML = `
      ${renderStatus(data.providerStatus)}
      <div class="empty">표시할 검색 결과가 없습니다.</div>
    `;
    return;
  }

  const visibleItems = filteredItems.slice(0, visibleCount);
  const selectedTotal = activeFilter === 'all'
    ? (data.totalAvailable ?? data.count)
    : (data.totalBySource?.[activeFilter] ?? filteredItems.length);
  const hasMore = visibleCount < filteredItems.length || data.hasMore;

  results.innerHTML = `
    ${renderStatus(data.providerStatus)}
    <div class="filter-bar">
      ${FILTER_OPTIONS.map((option) => {
        const count = option.key === 'all'
          ? (data.totalAvailable ?? data.count)
          : (data.totalBySource?.[option.key] ?? 0);

        return `
          <button class="filter-chip ${activeFilter === option.key ? 'active' : ''}" type="button" data-filter="${option.key}">
            ${option.label} ${count}건
          </button>
        `;
      }).join('')}
    </div>
    <div class="result-summary">총 ${selectedTotal}건 중 ${visibleItems.length}건 표시</div>
    <div class="result-list">
      ${visibleItems
        .map(
          (item) => `
            <article class="result-card">
              <a class="result-thumb" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">
                ${item.previewImage
                  ? `<img src="${escapeHtml(item.previewImage)}" alt="${escapeHtml(item.title)}" loading="lazy" />`
                  : `<span class="thumb-fallback">NO IMAGE</span>`}
              </a>
              <div class="result-body">
                <div class="result-meta">
                  <span class="source">${escapeHtml(item.sourceLabel || item.source)}</span>
                  <time>${escapeHtml(formatDate(item.publishedAt))}</time>
                </div>
                <a class="result-title" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
                <p class="result-snippet">${escapeHtml(item.snippet)}</p>
                <a class="result-url" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a>
              </div>
            </article>
          `
        )
        .join('')}
    </div>
    ${hasMore ? `<div class="load-more-sentinel" id="load-more-sentinel">${isFetchingMore ? '더 불러오는 중...' : '스크롤하면 5개씩 더 불러옵니다.'}</div>` : ''}
  `;

  for (const button of results.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter || 'all';
      visibleCount = PAGE_SIZE;
      window.history.replaceState({ query: latestData.query, filter: activeFilter }, '', getSearchUrl(latestData.query, activeFilter));
      renderResults(latestData);
    });
  }

  setupLoadMoreObserver();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const query = input.value.trim();
  if (!query) {
    return;
  }

  runSearch(query, { useCache: true, updateHistory: true });
});

scrollTopButton.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

window.addEventListener('scroll', () => {
  scrollTopButton.classList.toggle('visible', window.scrollY > 320);
});

window.addEventListener('popstate', () => {
  const searchParams = new URLSearchParams(window.location.search);
  const query = searchParams.get('q')?.trim() || '';
  const filter = searchParams.get('type')?.trim() || 'all';

  if (!query) {
    latestData = null;
    disconnectLoadMoreObserver();
    input.value = '';
    activeFilter = 'all';
    renderSidebar(null);
    results.innerHTML = '';
    return;
  }

  runSearch(query, { useCache: true, updateHistory: false, filter });
});

const initialSearchParams = new URLSearchParams(window.location.search);
const initialQuery = initialSearchParams.get('q')?.trim() || '';
const initialFilter = initialSearchParams.get('type')?.trim() || 'all';
if (initialQuery) {
  runSearch(initialQuery, { useCache: true, updateHistory: false, filter: initialFilter });
} else {
  renderSidebar(null);
}

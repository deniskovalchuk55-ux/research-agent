// ============================================================================
//  ІНСТРУМЕНТИ — кожен вмикається коли є його ключ (env). Нема ключа → fallback.
//  Роутер у tasks.js каже який інструмент під задачу; тут — реалізація.
// ============================================================================

const EXA_API_KEY = process.env.EXA_API_KEY;
const APIFY_API_KEY = process.env.APIFY_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PARALLEL_API_KEY = process.env.PARALLEL_API_KEY;

// які інструменти доступні (є ключ)
export const AVAILABLE = {
  exa: !!EXA_API_KEY,
  apify: !!APIFY_API_KEY,
  firecrawl: !!FIRECRAWL_API_KEY,
  perplexity: !!PERPLEXITY_API_KEY,
  parallel: !!PARALLEL_API_KEY,
  meta_ads: false, // Meta Ads Library — потребує окремої інтеграції, поки fallback
  google: false,
};

// ─── EXA (семантичний пошук) ─────────────────────────────────────────────────
export async function exaSearch(query, num = 6) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
    body: JSON.stringify({ query, numResults: num, type: "auto", contents: { text: { maxCharacters: 1200 } } }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0,120)}`);
  const d = await res.json();
  return (d.results || []).map(r => ({ title: r.title||"", url: r.url||"", text: r.text||"", source: "exa" }));
}

// ─── PERPLEXITY (відповідь + джерела) ────────────────────────────────────────
export async function perplexitySearch(query) {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PERPLEXITY_API_KEY}` },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const d = await res.json();
  const text = d.choices?.[0]?.message?.content || "";
  const citations = d.citations || [];
  return [{ title: "Perplexity", url: citations[0] || "", text, source: "perplexity", citations }];
}

// ─── APIFY (IG/TikTok акаунти й контент) ─────────────────────────────────────
// Запускає актора Instagram scraper. Потребує APIFY_API_KEY.
export async function apifySearch(query, num = 10) {
  // actor: apify/instagram-search-scraper (пошук за хештегом/ключем)
  const actor = "apify~instagram-search-scraper";
  const res = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${APIFY_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ search: query, searchType: "user", searchLimit: num }),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0,120)}`);
  const items = await res.json();
  return (items || []).slice(0, num).map(it => ({
    title: it.username || it.name || it.fullName || "",
    url: it.url || (it.username ? `https://instagram.com/${it.username}` : ""),
    text: `${it.fullName||""} ${it.biography||""} підписників: ${it.followersCount||"?"}`.trim(),
    source: "apify",
  }));
}

// ─── FIRECRAWL (контент сайту — для розборів) ────────────────────────────────
export async function firecrawlScrape(url) {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) throw new Error(`Firecrawl ${res.status}`);
  const d = await res.json();
  return [{ title: d.data?.metadata?.title || url, url, text: (d.data?.markdown||"").slice(0, 4000), source: "firecrawl" }];
}

// ─── PARALLEL (широкий збір) — fallback на Exa якщо нема ──────────────────────
export async function parallelSearch(query, num = 8) {
  if (!PARALLEL_API_KEY) return exaSearch(query, num);
  const res = await fetch("https://api.parallel.ai/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": PARALLEL_API_KEY },
    body: JSON.stringify({ query, max_results: num }),
  });
  if (!res.ok) return exaSearch(query, num); // graceful fallback
  const d = await res.json();
  return (d.results || []).map(r => ({ title: r.title||"", url: r.url||"", text: r.snippet||r.text||"", source: "parallel" }));
}

// ─── РОУТЕР ВИКЛИКУ: обирає інструмент з урахуванням наявних ключів ───────────
// preferred — список бажаних інструментів із задачі (tasks.js)
// повертає {tool, results}
export async function routeSearch(preferred, query, num = 6) {
  for (const tool of preferred) {
    if (!AVAILABLE[tool]) continue;
    try {
      if (tool === "exa") return { tool, results: await exaSearch(query, num) };
      if (tool === "perplexity") return { tool, results: await perplexitySearch(query) };
      if (tool === "apify") return { tool, results: await apifySearch(query, num) };
      if (tool === "parallel") return { tool, results: await parallelSearch(query, num) };
      // firecrawl/meta_ads/google — не для загального пошуку тут
    } catch (e) {
      console.error(`${tool} впав:`, e.message); // пробуємо наступний
    }
  }
  // нічого з бажаних — fallback на Exa (він майже завжди є)
  if (AVAILABLE.exa) return { tool: "exa", results: await exaSearch(query, num) };
  throw new Error("Нема доступних інструментів пошуку (додай EXA_API_KEY)");
}

// паралельний пошук по підзапитах з роутингом
export async function multiSearch(preferred, subqueries, num = 6) {
  const jobs = subqueries.map(async (sq) => {
    try {
      const { tool, results } = await routeSearch(preferred, sq.query, num);
      return { name: sq.name, query: sq.query, tool, results };
    } catch (e) {
      return { name: sq.name, query: sq.query, results: [], error: e.message };
    }
  });
  return Promise.all(jobs);
}

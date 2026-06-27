// ============================================================================
//  EXA — модуль веб-пошуку.
//  Документація: https://docs.exa.ai
// ============================================================================

const EXA_API_KEY = process.env.EXA_API_KEY;

// Один пошуковий запит через Exa.
// Повертає масив результатів: { title, url, text, ... }
export async function exaSearch(query, numResults = 5) {
  if (!EXA_API_KEY) throw new Error("EXA_API_KEY не заданий");

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      numResults,
      type: "auto",            // Exa сам обирає neural / keyword
      contents: {
        text: { maxCharacters: 1000 },  // короткий витяг тексту з кожної сторінки
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Exa ${res.status}: ${t.slice(0, 150)}`);
  }

  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    text: r.text || "",
    published: r.publishedDate || "",
  }));
}

// Паралельний пошук по кількох підзадачах одночасно.
// subtasks: [{name, query}]
// Повертає: [{name, query, results:[...]}]
export async function exaSearchParallel(subtasks, numPerTask = 5) {
  const jobs = subtasks.map(async (st) => {
    try {
      const results = await exaSearch(st.query, numPerTask);
      return { name: st.name, query: st.query, results };
    } catch (e) {
      return { name: st.name, query: st.query, results: [], error: e.message };
    }
  });
  return await Promise.all(jobs);
}

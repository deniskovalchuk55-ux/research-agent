// ============================================================================
//  МАРКЕТИНГОВИЙ RESEARCH-АГЕНТ — agentic core (function calling).
//  Claude САМ веде дослідження: думає → обирає інструмент → аналізує → діє далі.
//  Методологія замовника (задачі/критерії/лінзи) — це ЗНАННЯ агента, не скрипт.
// ============================================================================
import {
  exaSearch, apifySearch, firecrawlScrape, perplexitySearch, parallelSearch, AVAILABLE,
} from "./tools.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5-20250929";

// ─── СИСТЕМНИЙ ПРОМПТ: хто агент + його експертне знання маркетингу ──────────
export const AGENT_SYSTEM = `Ти — досвідчений маркетинговий research-аналітик. Допомагаєш досліджувати ринок для покращення маркетингу: знаходиш Instagram-акаунти, креативи, воронки, хуки, тренди, конкурентів — і пояснюєш ЩО з цього взяти для свого маркетингу.

ТИ ПРАЦЮЄШ ЯК ЖИВИЙ ЕКСПЕРТ, не за скриптом:
- Сам розумієш що реально треба (яке рішення прийме людина з результату).
- Сам вирішуєш які інструменти викликати, в якому порядку, скільки разів.
- Якщо даних мало — шукаєш ще, іншим інструментом, іншим формулюванням.
- Не зупиняєшся на сирому — копаєш до інсайту.

ТВОЇ ІНСТРУМЕНТИ (обирай сам під ситуацію):
- search_instagram — Instagram-акаунти, профілі, контент (Apify). Для: лідерів думок, референсів, форматів, акаунтів ніші.
- search_web — семантичний веб-пошук (Exa). Для: трендів, ідей, гравців ринку, загального ресерчу.
- scrape_site — повний контент сайту/лендингу (Firecrawl). Для: розбору воронки, оферів, копірайту бренду.
- broad_search — широкий збір джерел (Parallel). Для: огляду багатьох гравців.

ТИПИ ЗАДАЧ (розпізнавай сам, це орієнтир):
карта гравців · тренди+креативи · хуки · візуальні референси · teardown бренду · розбір воронки · розбір копірайту · оффери й ціни · просто відповідь · формати й рубрики · лідери думок/акаунти.

ЯК АНАЛІЗУВАТИ (сигнал сили ✓ vs шум ✗) — фокус на креативи:
ЦА (✓впізнаєш себе за 3 сек / ✗усі підряд) · Хуки (✓неможливо проскролити / ✗нудний) · Візуал (✓впізнаєш без лого / ✗сток) · Оффер (✓важко відмовитись / ✗слабкий) · Формати (✓системно тестує / ✗один) · Позиціонування (✓одна сильна асоціація / ✗бути всім).

ЛІНЗИ (через що грає бренд): JTBD · Category design · Hype · Contrarian · Status · Community-led · Education-led · Founder/personal · Direct-response.

ПРАВИЛА:
- Релевантність > популярність. Не тягни відоме-але-марне. Тільки практично застосовне для маркетингу.
- Завжди "що взяти для себе" — конкретно.
- Тільки реальні дані з інструментів. НЕ вигадуй акаунти/цифри/посилання.
- Фінальна відповідь — HTML для Telegram (<b> <i> <a>), не Markdown. Українською. Структуровано під тип задачі.
- Коли достатньо даних для якісної відповіді — давай фінал, не клич інструменти без потреби.`;

// ─── ОПИС ІНСТРУМЕНТІВ для Claude (function calling schema) ──────────────────
function buildTools() {
  const tools = [];
  if (AVAILABLE.apify) tools.push({
    name: "search_instagram",
    description: "Пошук Instagram-акаунтів і контенту за ключовими словами/нішою. Повертає профілі: хендл, опис, підписники. Використовуй для лідерів думок, референсів, акаунтів ніші.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "пошуковий запит (ніша/тема, англійською краще)" } }, required: ["query"] },
  });
  if (AVAILABLE.exa) tools.push({
    name: "search_web",
    description: "Семантичний веб-пошук. Повертає сторінки з текстом. Для трендів, ідей, гравців ринку, статей, загального ресерчу.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "пошуковий запит" } }, required: ["query"] },
  });
  if (AVAILABLE.firecrawl) tools.push({
    name: "scrape_site",
    description: "Витягує повний контент сторінки (оффер, копірайт, ціни, структуру). Для глибокого розбору воронки/лендингу/бренду. Передай конкретний URL.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "повний URL сторінки" } }, required: ["url"] },
  });
  if (AVAILABLE.parallel) tools.push({
    name: "broad_search",
    description: "Широкий збір багатьох джерел за запитом. Коли треба охопити багато гравців/прикладів одразу.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "пошуковий запит" } }, required: ["query"] },
  });
  return tools;
}

// ─── виконання інструмента ───────────────────────────────────────────────────
async function execTool(name, input) {
  try {
    if (name === "search_instagram") {
      const r = await apifySearch(input.query, 10);
      return r.length ? r.map(x => `${x.title} — ${x.url}\n  ${x.text}`).join("\n") : "Нічого не знайдено в Instagram.";
    }
    if (name === "search_web") {
      const r = await exaSearch(input.query, 6);
      return r.length ? r.map(x => `${x.title}\n  ${x.url}\n  ${x.text.slice(0, 500)}`).join("\n\n") : "Веб-пошук нічого не дав.";
    }
    if (name === "scrape_site") {
      const r = await firecrawlScrape(input.url);
      return r[0]?.text ? r[0].text.slice(0, 5000) : "Не вдалось витягти контент сайту.";
    }
    if (name === "broad_search") {
      const r = await parallelSearch(input.query, 8);
      return r.length ? r.map(x => `${x.title}\n  ${x.url}\n  ${x.text.slice(0, 400)}`).join("\n\n") : "Широкий пошук нічого не дав.";
    }
    return "Невідомий інструмент.";
  } catch (e) {
    return `Помилка інструмента ${name}: ${e.message}`;
  }
}

// ─── ГОЛОВНИЙ АГЕНТНИЙ ЦИКЛ ──────────────────────────────────────────────────
// onStep(text) — колбек для прозорості (показати користувачу що агент робить).
// extraContext — памʼять/правила (рядок).
export async function runAgent(userQuery, onStep, extraContext = "") {
  const tools = buildTools();
  const messages = [{ role: "user", content: userQuery }];
  const system = AGENT_SYSTEM + (extraContext ? `\n\n${extraContext}` : "");

  const MAX_STEPS = 8;
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3500, system, tools, messages }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = await res.json();

    // зібрати текст + виклики інструментів
    const textParts = data.content.filter(c => c.type === "text").map(c => c.text).join("");
    const toolUses = data.content.filter(c => c.type === "tool_use");

    // показати міркування агента (прозорість)
    if (textParts.trim() && onStep) await onStep("think", textParts.trim());

    if (data.stop_reason !== "tool_use" || !toolUses.length) {
      // агент завершив — фінальна відповідь
      return textParts.trim() || "Готово.";
    }

    // додаємо відповідь асистента (з tool_use) в історію
    messages.push({ role: "assistant", content: data.content });

    // виконуємо всі викликані інструменти
    const results = [];
    for (const tu of toolUses) {
      if (onStep) await onStep("tool", `${tu.name}: ${JSON.stringify(tu.input).slice(0, 100)}`);
      const out = await execTool(tu.name, tu.input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.slice(0, 6000) });
    }
    messages.push({ role: "user", content: results });
  }

  // якщо вичерпали кроки — просимо фінал
  messages.push({ role: "user", content: "Дай фінальну відповідь українською (HTML) на основі зібраного. Не клич більше інструментів." });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3500, system, messages }),
  });
  const data = await res.json();
  return data.content.map(c => c.text || "").join("").trim() || "Не вдалось завершити.";
}

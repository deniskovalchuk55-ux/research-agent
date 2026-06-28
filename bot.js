// ============================================================================
//  AI MARKET-RESEARCH AGENT v2
//  Telegram → класифікація наміру → research (Exa) → звіт (HTML) → Sheets
//  Памʼять на Neon: правила-фідбеки (дотримується завжди) + архів досліджень.
//  Інструкції/проміти — в instructions.js (читай/правь там).
// ============================================================================
import TelegramBot from "node-telegram-bot-api";
import { callClaude, callClaudeJSON } from "./claude.js";
import { exaSearchParallel } from "./exa.js";
import { exportToSheet, SHEETS_ENABLED } from "./sheets.js";
import {
  initDB, addRule, getRules, listRules, deleteRule, clearRules,
  saveResearch, findResearch, listResearch, deleteResearch,
} from "./db.js";
import {
  SYSTEM_ROLE, SPLIT_PROMPT, SYNTHESIS_PROMPT, BRIEF_PROMPT,
  NEEDS_BRIEF_PROMPT, CLASSIFY_PROMPT, ROWS_PROMPT, feedbackRulesBlock,
} from "./instructions.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Research-агент v2 запущено");
await initDB();

// короткострокова памʼять сесії (поточна тема) — довга на Neon
const session = {};
function getS(id) {
  if (!session[id]) session[id] = { lastQuery: null, lastResult: null, lastTopic: null, pendingBrief: null };
  return session[id];
}

// ─── надсилання (HTML, з розбивкою) ──────────────────────────────────────────
function chunk(t, size = 3800) { const o = []; for (let i = 0; i < t.length; i += size) o.push(t.slice(i, i + size)); return o; }
async function send(chatId, html) {
  for (const part of chunk(html)) {
    await bot.sendMessage(chatId, part, { parse_mode: "HTML", disable_web_page_preview: true })
      .catch(() => bot.sendMessage(chatId, part.replace(/<[^>]+>/g, ""))); // якщо HTML зламався — без тегів
  }
}

// ─── головний research-флоу ──────────────────────────────────────────────────
async function runResearch(chatId, query, isFeedback = false) {
  const s = getS(chatId);
  const rules = await getRules(chatId);              // правила користувача (дотримуємось завжди)
  const rulesBlock = feedbackRulesBlock(rules);

  const status = await bot.sendMessage(chatId, "🧠 Формую контекст, розбиваю задачу…");

  // 1. розбивка на підзадачі
  let split;
  try {
    split = await callClaudeJSON(
      SYSTEM_ROLE + rulesBlock,
      `${SPLIT_PROMPT}\n\nЗАПИТ:\n${query}`
    );
  } catch (e) {
    return bot.editMessageText("❌ Розбивка: " + e.message, { chat_id: chatId, message_id: status.message_id });
  }

  await bot.editMessageText(
    `📋 ${split.context}\n\n🔍 Шукаю по напрямках: ` + split.subtasks.map((x) => x.name).join(", "),
    { chat_id: chatId, message_id: status.message_id }
  );

  // 2. паралельний Exa
  let results;
  try { results = await exaSearchParallel(split.subtasks, 5); }
  catch (e) { return bot.sendMessage(chatId, "❌ Exa: " + e.message); }

  // матеріал для зведення
  let material = `ЗАПИТ: ${query}\nКОНТЕКСТ: ${split.context}\n`;
  for (const b of results) {
    material += `\n=== ${b.name} ===\n`;
    if (b.error) { material += `(пошук впав: ${b.error})\n`; continue; }
    for (const r of b.results) material += `• ${r.title}\n  ${r.url}\n  ${r.text.slice(0, 400)}\n`;
  }

  // 3. зведення (HTML-звіт)
  let report;
  try {
    report = await callClaude(SYSTEM_ROLE + rulesBlock, `${SYNTHESIS_PROMPT}\n\nМАТЕРІАЛ:\n${material.slice(0, 30000)}`, 3000);
  } catch (e) { return bot.sendMessage(chatId, "❌ Зведення: " + e.message); }

  s.lastQuery = query; s.lastResult = report; s.lastTopic = split.context;
  await send(chatId, report);

  // 4. Google Sheets (якщо налаштовано)
  if (SHEETS_ENABLED) {
    try {
      const rows = await callClaudeJSON(SYSTEM_ROLE, `${ROWS_PROMPT}\n\nДОСЛІДЖЕННЯ:\n${report}`, 3000);
      if (Array.isArray(rows) && rows.length) {
        const link = await exportToSheet(rows, "Accounts");
        await bot.sendMessage(chatId, `📊 Додав у таблицю (${rows.length}): ${link}`, { disable_web_page_preview: true });
      }
    } catch (e) {
      await bot.sendMessage(chatId, "⚠️ Таблиця: " + e.message);
    }
  }

  // 5. зберегти в архів памʼяті
  await saveResearch(chatId, split.context.slice(0, 200), query, report.slice(0, 4000));
}

// ─── обробка повідомлень ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getS(chatId);

  // ── команди ──
  if (text === "/start") {
    return bot.sendMessage(chatId,
      "👋 Я Market-Research аналітик.\n\n" +
      "• Напиши задачу — досліджу (розіб'ю → знайду через Exa → зведу аналітику).\n" +
      "• Я сам розумію: нова це тема чи уточнення попередньої.\n" +
      "• Памʼятаю твої правила й минулі дослідження — спитай «памʼятаєш про …?».\n\n" +
      "Команди: /правила /архів /очистити");
  }
  if (text === "/правила") {
    const rules = await listRules(chatId);
    if (!rules.length) return bot.sendMessage(chatId, "Правил поки нема. Дай фідбек — і я почну їх дотримуватись.");
    return bot.sendMessage(chatId, "📋 Твої правила:\n" + rules.map((r) => `#${r.id}: ${r.rule}`).join("\n") + "\n\nВидалити: /видалити_правило <номер>");
  }
  if (text.startsWith("/видалити_правило")) {
    const id = parseInt(text.split(/\s+/)[1]); if (!id) return bot.sendMessage(chatId, "Вкажи номер: /видалити_правило 3");
    await deleteRule(chatId, id); return bot.sendMessage(chatId, "🗑 Правило видалено.");
  }
  if (text === "/архів") {
    const arr = await listResearch(chatId);
    if (!arr.length) return bot.sendMessage(chatId, "Архів порожній.");
    return bot.sendMessage(chatId, "📚 Дослідження:\n" + arr.map((r) => `#${r.id}: ${r.topic}`).join("\n") + "\n\nВидалити: /видалити_дослідження <номер>");
  }
  if (text.startsWith("/видалити_дослідження")) {
    const id = parseInt(text.split(/\s+/)[1]); if (!id) return bot.sendMessage(chatId, "Вкажи номер.");
    await deleteResearch(chatId, id); return bot.sendMessage(chatId, "🗑 Видалено з архіву.");
  }
  if (text === "/очистити") {
    await clearRules(chatId); return bot.sendMessage(chatId, "🧹 Правила очищено.");
  }
  if (text.startsWith("/brief")) {
    const q = text.replace("/brief", "").trim();
    if (!q) return bot.sendMessage(chatId, "Напиши: /brief <задача>");
    const questions = await callClaude(SYSTEM_ROLE, `${BRIEF_PROMPT}\n\nЗАДАЧА:\n${q}`);
    s.pendingBrief = q;
    return bot.sendMessage(chatId, "📋 Уточнення:\n\n" + questions);
  }

  // ── відповідь на бриф ──
  if (s.pendingBrief) {
    const full = `${s.pendingBrief}\n\nУточнення: ${text}`;
    s.pendingBrief = null;
    return runResearch(chatId, full);
  }

  // ── класифікація наміру (нова / фідбек / памʼять) ──
  let intent = "new", topic = "", focus = "";
  if (s.lastResult) {
    try {
      const c = await callClaudeJSON(SYSTEM_ROLE,
        `${CLASSIFY_PROMPT}\n\nПОПЕРЕДНЯ ЗАДАЧА: ${s.lastQuery}\nНОВЕ ПОВІДОМЛЕННЯ: ${text}`);
      intent = c.intent || "new"; topic = c.topic || ""; focus = c.focus || "";
    } catch { intent = "new"; }
  }

  // ── звернення до памʼяті ──
  if (intent === "recall") {
    const found = await findResearch(chatId, topic || text);
    if (!found.length) return bot.sendMessage(chatId, `Не знайшов у памʼяті дослідження по «${topic || text}». Можливо інша назва?`);
    const f = found[0];
    await bot.sendMessage(chatId, `📚 Так, памʼятаю — досліджували: ${f.topic}\n(${new Date(f.created_at).toLocaleDateString("uk")})`);
    await send(chatId, f.result);
    s.lastQuery = f.query; s.lastResult = f.result; s.lastTopic = f.topic;
    return;
  }

  // ── refine: розвиток теми (новий фокус + контекст попереднього) ──
  if (intent === "refine") {
    const refinedQuery = `${s.lastQuery}\n\nТЕПЕР ЗВУЗЬ/РОЗВИНЬ ФОКУС НА: ${focus || text}\n(Це продовження попередньої теми, але досліди саме цей напрямок конкретно.)`;
    await bot.sendMessage(chatId, `🔎 Розвиваю тему — фокус: ${focus || text}`);
    return runResearch(chatId, refinedQuery);
  }

  // ── фідбек: зберігаємо як правило + переробляємо ──
  if (intent === "feedback") {
    await addRule(chatId, text);                 // запамʼятовуємо правило назавжди
    await bot.sendMessage(chatId, "✏️ Врахував і запамʼятав. Переробляю…");
    return runResearch(chatId, s.lastQuery, true);
  }

  // ── нова задача: перевірка чи не надто широка ──
  try {
    const check = await callClaudeJSON(SYSTEM_ROLE, `${NEEDS_BRIEF_PROMPT}\n\nЗАПИТ:\n${text}`);
    if (check.needs_brief) {
      const questions = await callClaude(SYSTEM_ROLE, `${BRIEF_PROMPT}\n\nЗАДАЧА:\n${text}`);
      s.pendingBrief = text;
      return bot.sendMessage(chatId, "📋 Запит широкий, уточни:\n\n" + questions);
    }
  } catch {}

  await runResearch(chatId, text);
});

bot.on("polling_error", (e) => console.error("polling:", e.message));

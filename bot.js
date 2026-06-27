// ============================================================================
//  AI MARKET-RESEARCH AGENT — головна логіка.
//  Чат (Telegram) → розбивка запиту → пошук Exa (паралельно) → зведення.
//
//  Усі ІНСТРУКЦІЇ/ПРОМПТИ — у instructions.js (там їх можна читати й правити).
// ============================================================================
import TelegramBot from "node-telegram-bot-api";
import { callClaude, callClaudeJSON } from "./claude.js";
import { exaSearchParallel } from "./exa.js";
import {
  SYSTEM_ROLE,
  SPLIT_PROMPT,
  SYNTHESIS_PROMPT,
  BRIEF_PROMPT,
  NEEDS_BRIEF_PROMPT,
} from "./instructions.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Research-агент запущено");

// памʼять діалогу + фідбек (поки в памʼяті процесу; далі винесемо в Neon)
const memory = {};   // chatId -> { lastQuery, lastResult, feedback:[] }

function getMem(chatId) {
  if (!memory[chatId]) memory[chatId] = { lastQuery: null, lastResult: null, feedback: [] };
  return memory[chatId];
}

// розбити довгий текст на частини (ліміт Telegram ~4096)
function chunk(text, size = 3800) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
async function sendLong(chatId, text) {
  for (const part of chunk(text)) {
    await bot.sendMessage(chatId, part, { parse_mode: "Markdown" }).catch(() =>
      bot.sendMessage(chatId, part)  // якщо Markdown зламався — шлемо як є
    );
  }
}

// ─── Головний research-флоу ──────────────────────────────────────────────────
async function runResearch(chatId, query) {
  const mem = getMem(chatId);
  const status = await bot.sendMessage(chatId, "🧠 Формую контекст і розбиваю задачу...");

  // 1. розбивка на підзадачі (+ контекст)
  let split;
  try {
    split = await callClaudeJSON(
      SYSTEM_ROLE,
      `${SPLIT_PROMPT}\n\nЗАПИТ КОРИСТУВАЧА:\n${query}` +
      (mem.feedback.length ? `\n\nВРАХУЙ ПОПЕРЕДНІЙ ФІДБЕК КОРИСТУВАЧА:\n${mem.feedback.join("\n")}` : "")
    );
  } catch (e) {
    return bot.editMessageText("❌ Помилка розбивки: " + e.message, { chat_id: chatId, message_id: status.message_id });
  }

  await bot.editMessageText(
    `📋 Контекст: ${split.context}\n\n🔍 Шукаю по ${split.subtasks.length} напрямках:\n` +
    split.subtasks.map((s, i) => `${i + 1}. ${s.name}`).join("\n"),
    { chat_id: chatId, message_id: status.message_id }
  );

  // 2. паралельний пошук Exa по підзадачах
  let searchResults;
  try {
    searchResults = await exaSearchParallel(split.subtasks, 5);
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Помилка пошуку Exa: " + e.message);
  }

  // 3. зведення в звіт
  await bot.sendMessage(chatId, "📝 Зводжу результати у звіт...");

  // готуємо матеріал для зведення (компактно)
  let material = `ЗАПИТ: ${query}\nКОНТЕКСТ: ${split.context}\n\n`;
  for (const block of searchResults) {
    material += `\n=== Підзадача: ${block.name} ===\n`;
    if (block.error) { material += `(помилка пошуку: ${block.error})\n`; continue; }
    for (const r of block.results) {
      material += `• ${r.title}\n  ${r.url}\n  ${r.text.slice(0, 400)}\n`;
    }
  }

  let report;
  try {
    report = await callClaude(SYSTEM_ROLE, `${SYNTHESIS_PROMPT}\n\nМАТЕРІАЛ:\n${material.slice(0, 30000)}`, 3000);
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Помилка зведення: " + e.message);
  }

  mem.lastQuery = query;
  mem.lastResult = report;
  await sendLong(chatId, report);
  await bot.sendMessage(chatId, "💬 Дай фідбек (що покращити) — і я перероблю. Або нова задача.");
}

// ─── Обробка повідомлень ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const mem = getMem(chatId);

  // команди
  if (text === "/start") {
    return bot.sendMessage(chatId,
      "👋 Я Market-Research агент.\n\n" +
      "• Напиши задачу — досліджу (розіб'ю на підзадачі, знайду через Exa, зведу звіт).\n" +
      "• /brief <задача> — спершу задам уточнюючі питання.\n" +
      "• Після результату — дай фідбек, перероблю з урахуванням.\n\n" +
      "Приклад: «знайди конкурентів і їхні фішки у ніші доставки кави Київ»"
    );
  }

  // примусовий бриф
  if (text.startsWith("/brief")) {
    const q = text.replace("/brief", "").trim();
    if (!q) return bot.sendMessage(chatId, "Напиши: /brief <твоя задача>");
    try {
      const questions = await callClaude(SYSTEM_ROLE, `${BRIEF_PROMPT}\n\nЗАДАЧА:\n${q}`);
      mem.pendingBrief = q;
      return bot.sendMessage(chatId, "📋 Кілька уточнень:\n\n" + questions + "\n\n(Відповідай одним повідомленням — і почну пошук.)");
    } catch (e) {
      return bot.sendMessage(chatId, "❌ " + e.message);
    }
  }

  // якщо чекаємо відповіді на бриф → обʼєднуємо й шукаємо
  if (mem.pendingBrief) {
    const fullQuery = `${mem.pendingBrief}\n\nУточнення користувача: ${text}`;
    mem.pendingBrief = null;
    return runResearch(chatId, fullQuery);
  }

  // якщо вже був результат → вважаємо це фідбеком, переробляємо
  if (mem.lastResult) {
    mem.feedback.push(text);
    await bot.sendMessage(chatId, "✏️ Врахував фідбек, переробляю...");
    return runResearch(chatId, mem.lastQuery);
  }

  // новий запит — перевіряємо чи не надто широкий
  try {
    const check = await callClaudeJSON(SYSTEM_ROLE, `${NEEDS_BRIEF_PROMPT}\n\nЗАПИТ:\n${text}`);
    if (check.needs_brief) {
      const questions = await callClaude(SYSTEM_ROLE, `${BRIEF_PROMPT}\n\nЗАДАЧА:\n${text}`);
      mem.pendingBrief = text;
      return bot.sendMessage(chatId, "📋 Запит широкий, кілька уточнень:\n\n" + questions + "\n\n(Відповідай — і почну.)");
    }
  } catch (e) {
    // якщо перевірка впала — просто шукаємо
  }

  await runResearch(chatId, text);
});

bot.on("polling_error", (e) => console.error("polling:", e.message));

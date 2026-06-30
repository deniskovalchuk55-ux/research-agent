// ============================================================================
//  МАРКЕТИНГОВИЙ RESEARCH-АГЕНТ — Telegram.
//  Агентне ядро (agent.js): Claude САМ веде дослідження з інструментами.
//  Прозорість: показуємо думки агента + які інструменти кличе.
//  Памʼять (Neon): правила-фідбеки + архів. Google Sheets для табличних.
// ============================================================================
import TelegramBot from "node-telegram-bot-api";
import { runAgent } from "./agent.js";
import { callClaude, callClaudeJSON } from "./claude.js";
import { exportToSheet, SHEETS_ENABLED } from "./sheets.js";
import { initDB, addRule, getRules, listRules, deleteRule, saveResearch, findResearch, listResearch, deleteResearch, clearRules } from "./db.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Маркетинговий агент (agentic) запущено");
await initDB();

const session = {};
const getS = (id) => (session[id] ||= { lastQuery: null, lastResult: null });

function chunk(t, s = 3800) { const o = []; for (let i = 0; i < t.length; i += s) o.push(t.slice(i, i + s)); return o; }
async function send(chatId, html) {
  for (const p of chunk(html))
    await bot.sendMessage(chatId, p, { parse_mode: "HTML", disable_web_page_preview: true })
      .catch(() => bot.sendMessage(chatId, p.replace(/<[^>]+>/g, "")));
}

// ─── запуск агента з прозорістю ──────────────────────────────────────────────
async function research(chatId, query) {
  const s = getS(chatId);
  const rules = await getRules(chatId);
  const ctx = rules.length ? `ПРАВИЛА КОРИСТУВАЧА (завжди дотримуйся):\n${rules.map((r,i)=>`${i+1}. ${r}`).join("\n")}` : "";

  let toolMsg = await bot.sendMessage(chatId, "🧠 Думаю над задачею…");
  let steps = [];

  // колбек прозорості — оновлюємо одне повідомлення зі станом
  const onStep = async (type, text) => {
    if (type === "tool") {
      steps.push(`🔧 ${text}`);
    } else if (type === "think") {
      // показуємо коротку думку (перші 160 символів)
      const t = text.length > 160 ? text.slice(0, 160) + "…" : text;
      steps.push(`💭 ${t}`);
    }
    const view = steps.slice(-6).join("\n");
    await bot.editMessageText(view || "🧠 Працюю…", { chat_id: chatId, message_id: toolMsg.message_id }).catch(()=>{});
  };

  let report;
  try {
    report = await runAgent(query, onStep, ctx);
  } catch (e) {
    return bot.editMessageText("❌ " + e.message, { chat_id: chatId, message_id: toolMsg.message_id });
  }

  await bot.editMessageText("✅ Готово", { chat_id: chatId, message_id: toolMsg.message_id }).catch(()=>{});
  s.lastQuery = query; s.lastResult = report;
  await send(chatId, report);

  // Google Sheets — якщо у відповіді є структуровані сутності
  if (SHEETS_ENABLED) {
    try {
      const rows = await callClaudeJSON("Ти витягуєш дані для таблиці.",
        `Якщо у цьому маркетинговому дослідженні є СПИСОК сутностей (акаунти/бренди/гравці/оффери) — витягни JSON-масив рядків {"name","platform","niche","relevance","utp","url","comment","takeaway"}. Якщо це суцільний текст-розбір без списку — поверни [].\n\nДОСЛІДЖЕННЯ:\n${report.slice(0,6000)}`);
      if (Array.isArray(rows) && rows.length) {
        const link = await exportToSheet(rows, "Research");
        await bot.sendMessage(chatId, `📊 Додав у таблицю (${rows.length}): ${link}`, { disable_web_page_preview: true });
      }
    } catch {}
  }

  await saveResearch(chatId, query.slice(0,200), query, report.slice(0,4000));
}

// ─── повідомлення ────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id, text = msg.text.trim(), s = getS(chatId);

  if (text === "/start") return bot.sendMessage(chatId,
    "👋 Я маркетинговий research-агент.\n\n" +
    "Дай задачу про маркетинг — знайду акаунти, креативи, воронки, тренди, конкурентів і скажу що взяти для себе. Я сам обираю інструменти й веду пошук, показуючи логіку.\n\n" +
    "🧠 /правила · 📚 /архів\n\n" +
    "Приклад: «знайди топ Instagram-акаунти бізнес-івентів в Україні і їхні фішки»");

  if (text === "/правила") {
    const r = await listRules(chatId);
    return bot.sendMessage(chatId, r.length ? "📋 Правила:\n"+r.map(x=>`#${x.id}: ${x.rule}`).join("\n")+"\n\n/видалити_правило N" : "Правил нема. Дай фідбек — запамʼятаю.");
  }
  if (text.startsWith("/видалити_правило")) { const id=+text.split(/\s+/)[1]; if(id){await deleteRule(chatId,id); return bot.sendMessage(chatId,"🗑 ок");} }
  if (text === "/архів") {
    const a = await listResearch(chatId);
    return bot.sendMessage(chatId, a.length ? "📚 Архів:\n"+a.map(x=>`#${x.id}: ${x.topic}`).join("\n")+"\n\n/видалити_дослідження N" : "Архів порожній.");
  }
  if (text.startsWith("/видалити_дослідження")) { const id=+text.split(/\s+/)[1]; if(id){await deleteResearch(chatId,id); return bot.sendMessage(chatId,"🗑 ок");} }
  if (text === "/очистити") { await clearRules(chatId); return bot.sendMessage(chatId,"🧹 ок"); }

  // якщо вже був результат — це фідбек чи нова задача? агент сам розбереться, але правила-фідбек ловимо
  if (s.lastResult) {
    try {
      const c = await callClaudeJSON("Класифікатор.",
        `Це фідбек про стиль/підхід (правило на майбутнє), уточнення поточного дослідження, чи нова задача? JSON: {"intent":"feedback"|"refine"|"new","focus":""}\n\nПОПЕРЕДНЄ: ${s.lastQuery}\nНОВЕ: ${text}`);
      if (c.intent === "feedback") { await addRule(chatId, text); await bot.sendMessage(chatId, "✏️ Запамʼятав, переробляю…"); return research(chatId, s.lastQuery); }
      if (c.intent === "refine") return research(chatId, `${s.lastQuery}\nУточнення/фокус: ${c.focus || text}`);
    } catch {}
  }

  await research(chatId, text);
});

bot.on("polling_error", (e) => console.error("polling:", e.message));

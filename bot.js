// ============================================================================
//  AI RESEARCH AGENT v3 — по методології замовника.
//  ЗАДАЧА(11) → роутер → інструмент → ФІКСОВАНА ФОРМА (+критерії/лінзи).
//  Прозоро: видно яку задачу обрав, режим, інструмент, кроки.
// ============================================================================
import TelegramBot from "node-telegram-bot-api";
import { callClaude, callClaudeJSON } from "./claude.js";
import { multiSearch, AVAILABLE, firecrawlScrape } from "./tools.js";
import { exportToSheet, SHEETS_ENABLED } from "./sheets.js";
import { initDB, addRule, getRules, saveResearch, findResearch, listRules, deleteRule, listResearch, deleteResearch, clearRules } from "./db.js";
import {
  TASKS, ROUTER_PROMPT, OUTPUT_FORMS, CRITERIA_BLOCK, LENSES_BLOCK,
  SYSTEM_ROLE, SUBQUERIES_PROMPT,
} from "./tasks.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Research-агент v3 (методологія) запущено");
await initDB();

const session = {};
const getS = (id) => (session[id] ||= { lastTask: null, lastQuery: null, lastResult: null, pendingTask: null });

function chunk(t, s = 3800) { const o = []; for (let i = 0; i < t.length; i += s) o.push(t.slice(i, i + s)); return o; }
async function send(chatId, html) {
  for (const p of chunk(html))
    await bot.sendMessage(chatId, p, { parse_mode: "HTML", disable_web_page_preview: true })
      .catch(() => bot.sendMessage(chatId, p.replace(/<[^>]+>/g, "")));
}

// ─── ГОЛОВНИЙ ФЛОУ по методології ────────────────────────────────────────────
async function runTask(chatId, query, forcedTask = null) {
  const s = getS(chatId);
  const rules = await getRules(chatId);
  const rulesBlock = rules.length ? `\n\nПРАВИЛА КОРИСТУВАЧА (завжди дотримуйся):\n${rules.map((r,i)=>`${i+1}. ${r}`).join("\n")}` : "";

  // 1. РОУТЕР — яка задача
  let taskNum = forcedTask, extracted = {}, reason = "";
  if (!taskNum) {
    const status = await bot.sendMessage(chatId, "🧭 Визначаю тип задачі...");
    try {
      const r = await callClaudeJSON(SYSTEM_ROLE, `${ROUTER_PROMPT}\n\nЗАПИТ:\n${query}`);
      taskNum = r.task; extracted = r.extracted || {}; reason = r.reason || "";
      // якщо не впевнений і є уточнення — питаємо, НЕ пливемо
      if (r.confidence === "low" && r.clarify) {
        bot.deleteMessage(chatId, status.message_id).catch(()=>{});
        s.pendingClarify = { query, suggestedTask: taskNum };
        return bot.sendMessage(chatId, `🤔 Уточню щоб не піти не туди:\n\n${r.clarify}\n\n(Відповідай — і почну. Або напиши «задача N» щоб задати тип напряму.)`);
      }
    } catch (e) {
      return bot.editMessageText("❌ Роутер: " + e.message, { chat_id: chatId, message_id: status.message_id });
    }
    bot.deleteMessage(chatId, status.message_id).catch(()=>{});
  }
  const task = TASKS[taskNum];
  if (!task) return bot.sendMessage(chatId, "Не зміг визначити задачу. Спробуй конкретніше.");

  // який інструмент реально доступний (з бажаних задачі)
  const realTool = task.tools.find(t => AVAILABLE[t]) || "exa";
  const toolNote = realTool !== task.tools[0]
    ? ` (бажано ${task.tools[0]}, але працюю через ${realTool} — додай ключ для ${task.tools[0]})`
    : "";

  // показуємо ЛОГІКУ (прозорість)
  await bot.sendMessage(chatId,
    `🧭 <b>Задача №${taskNum}:</b> ${task.name}\n` +
    `⚙️ Режим: ${task.mode} · Форма: ${task.form}\n` +
    `🔧 Інструмент: ${realTool}${toolNote}\n` +
    (reason ? `💡 ${reason}` : ""),
    { parse_mode: "HTML" });

  // 2. Підзапити
  const status2 = await bot.sendMessage(chatId, "🔍 Готую пошук...");
  let sub;
  try {
    sub = await callClaudeJSON(SYSTEM_ROLE, `${SUBQUERIES_PROMPT}\n\nЗАДАЧА: ${task.name}\nЗАПИТ: ${query}\nВитягнуто: ${JSON.stringify(extracted)}`);
  } catch (e) { return bot.editMessageText("❌ " + e.message, { chat_id: chatId, message_id: status2.message_id }); }

  await bot.editMessageText(`🔍 Шукаю (${realTool}): ${sub.subqueries.map(x=>x.name).join(", ")}`, { chat_id: chatId, message_id: status2.message_id });

  // 3. Пошук через РОУТЕР інструментів (Exa/Apify/Perplexity... за наявними ключами)
  let results;
  try { results = await multiSearch(task.tools, sub.subqueries, 6); }
  catch (e) { return bot.sendMessage(chatId, "❌ Пошук: " + e.message); }

  let material = `ЗАДАЧА: ${task.name}\nЗАПИТ: ${query}\nКОНТЕКСТ: ${sub.context}\n`;
  for (const b of results) {
    material += `\n=== ${b.name} ===\n`;
    if (b.error) { material += `(пошук впав: ${b.error})\n`; continue; }
    for (const r of b.results) material += `• ${r.title}\n  ${r.url}\n  ${r.text.slice(0,400)}\n`;
  }

  // 3b. Для глибоких розборів (5,6,7,8) — дотягуємо повний контент сайту через Firecrawl
  if (["Розбір"].includes(task.mode) || task.form === "Огляд оферів") {
    if (AVAILABLE.firecrawl) {
      const topUrls = results.flatMap(b => b.results || []).map(r => r.url).filter(u => u && u.startsWith("http")).slice(0, 2);
      if (topUrls.length) {
        await bot.sendMessage(chatId, `🔬 Розбираю сайт глибше (Firecrawl)...`);
        for (const url of topUrls) {
          try {
            const scraped = await firecrawlScrape(url);
            if (scraped[0]?.text) material += `\n=== ПОВНИЙ КОНТЕНТ ${url} ===\n${scraped[0].text.slice(0, 3000)}\n`;
          } catch (e) { /* пропускаємо якщо не вийшло */ }
        }
      }
    }
  }

  // перевірка чи взагалі є результати
  const totalFound = results.reduce((n, b) => n + (b.results?.length || 0), 0);
  if (totalFound === 0) {
    return bot.sendMessage(chatId, "🔍 Нічого не знайшов по цьому запиту. Спробуй переформулювати — додати нішу, гео або конкретніше тему. Або «задача N» щоб задати тип напряму.");
  }

  // 4. СИНТЕЗ у ФІКСОВАНІЙ ФОРМІ (+ критерії/лінзи для розборів)
  await bot.sendMessage(chatId, "📝 Збираю у форму...");
  const form = OUTPUT_FORMS[task.form] || OUTPUT_FORMS["Відповідь"];
  const deep = ["Розбір", "Добірка"].includes(task.mode);
  const synthPrompt =
    `Зроби результат СТРОГО у цій формі (нічого не додавай поза формою):\n${form}\n\n` +
    (deep ? `${CRITERIA_BLOCK}\n\n${LENSES_BLOCK}\n\n` : "") +
    `ЖОРСТКІ ПРАВИЛА:\n` +
    `- Тільки реальні дані з матеріалу. Якщо чогось нема — НЕ вигадуй, пропусти або познач "(даних мало)".\n` +
    `- Релевантність > популярність: відкинь відоме-але-марне для цього бізнесу.\n` +
    `- Кожен пункт = практична користь для маркетингу/креативу. Не вода.\n` +
    `- HTML <b><i><a> (не Markdown). Українською.${rulesBlock}\n\nМАТЕРІАЛ:\n${material.slice(0, 28000)}`;

  let report;
  try { report = await callClaude(SYSTEM_ROLE, synthPrompt, 3500); }
  catch (e) { return bot.sendMessage(chatId, "❌ Синтез: " + e.message); }

  s.lastTask = taskNum; s.lastQuery = query; s.lastResult = report;
  await send(chatId, `<b>📋 ${task.form}</b>\n\n` + report);

  // 5. Google Sheets (для табличних форм)
  if (SHEETS_ENABLED && ["Карта поля","Список акаунтів","Огляд оферів","Карта форматів"].includes(task.form)) {
    try {
      const rows = await callClaudeJSON(SYSTEM_ROLE,
        `Витягни знахідки у JSON-масив рядків для таблиці. Кожен: {"name","platform","niche","relevance","utp","url","comment","takeaway"}. Тільки реальні дані.\n\nРЕЗУЛЬТАТ:\n${report}`);
      if (Array.isArray(rows) && rows.length) {
        const link = await exportToSheet(rows, task.form.replace(/[^\wа-яіїєґ]/gi,"_").slice(0,30) || "Research");
        await bot.sendMessage(chatId, `📊 Таблиця (${rows.length}): ${link}`, { disable_web_page_preview: true });
      }
    } catch (e) { await bot.sendMessage(chatId, "⚠️ Таблиця: " + e.message); }
  }

  await saveResearch(chatId, `${task.name}: ${sub.context}`.slice(0,200), query, report.slice(0,4000));
}

// ─── повідомлення ────────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id, text = msg.text.trim(), s = getS(chatId);

  if (text === "/start") return bot.sendMessage(chatId,
    "👋 Research-агент (по методології).\n\n" +
    "Напиши задачу — я визначу її ТИП (з 11), оберу інструмент і видам у фіксованій формі.\n\n" +
    "📋 /задачі — список типів задач\n🧠 /правила · 📚 /архів\n\n" +
    "Приклад: «знайди топ Instagram-акаунти у ніші бізнес-івентів, гео Україна»");

  if (text === "/задачі") {
    let out = "📋 <b>Типи задач:</b>\n\n";
    for (const [n, t] of Object.entries(TASKS)) out += `${n}. ${t.name} <i>(${t.mode} → ${t.form})</i>\n`;
    out += "\nМожеш почати з номера: «задача 11 ніша бізнес-івенти» або просто опиши.";
    return bot.sendMessage(chatId, out, { parse_mode: "HTML" });
  }
  if (text === "/правила") {
    const r = await listRules(chatId);
    return bot.sendMessage(chatId, r.length ? "📋 Правила:\n"+r.map(x=>`#${x.id}: ${x.rule}`).join("\n")+"\n\n/видалити_правило N" : "Правил нема.");
  }
  if (text.startsWith("/видалити_правило")) { const id=+text.split(/\s+/)[1]; if(id){await deleteRule(chatId,id); return bot.sendMessage(chatId,"🗑 ок");} }
  if (text === "/архів") {
    const a = await listResearch(chatId);
    return bot.sendMessage(chatId, a.length ? "📚 Архів:\n"+a.map(x=>`#${x.id}: ${x.topic}`).join("\n")+"\n\n/видалити_дослідження N" : "Архів порожній.");
  }
  if (text.startsWith("/видалити_дослідження")) { const id=+text.split(/\s+/)[1]; if(id){await deleteResearch(chatId,id); return bot.sendMessage(chatId,"🗑 ок");} }
  if (text === "/очистити") { await clearRules(chatId); return bot.sendMessage(chatId,"🧹 Правила очищено."); }

  // відповідь на уточнення роутера → запускаємо з уточненим запитом
  if (s.pendingClarify) {
    const { query: origQ } = s.pendingClarify;
    s.pendingClarify = null;
    return runTask(chatId, `${origQ}\n\nУточнення: ${text}`);
  }

  // явна задача: "задача N ..."
  const m = text.match(/^задача\s+(\d{1,2})\s*(.*)/i);
  if (m) { const n=+m[1]; if(TASKS[n]) return runTask(chatId, m[2]||text, n); }

  // якщо вже був результат — класифікуємо: нова / refine / feedback / recall
  if (s.lastResult) {
    try {
      const c = await callClaudeJSON(SYSTEM_ROLE,
        `Визнач намір. JSON: {"intent":"new"|"refine"|"feedback"|"recall","topic":"","focus":""}\n`+
        `- new: інша тема\n- refine: розвиток поточної ("а як для X","глибше про Y")\n- feedback: правка стилю ("коротше","не тягни популярне")\n- recall: память ("памʼятаєш про Z")\n\n`+
        `ПОПЕРЕДНЄ: ${s.lastQuery}\nНОВЕ: ${text}`);
      if (c.intent === "recall") {
        const f = await findResearch(chatId, c.topic || text);
        if (!f.length) return bot.sendMessage(chatId, `Не знайшов у памʼяті «${c.topic||text}».`);
        await bot.sendMessage(chatId, `📚 Памʼятаю: ${f[0].topic}`);
        return send(chatId, f[0].result);
      }
      if (c.intent === "feedback") { await addRule(chatId, text); await bot.sendMessage(chatId,"✏️ Запамʼятав правило, переробляю..."); return runTask(chatId, s.lastQuery, s.lastTask); }
      if (c.intent === "refine") { await bot.sendMessage(chatId,`🔎 Розвиваю: ${c.focus||text}`); return runTask(chatId, `${s.lastQuery}\nФОКУС: ${c.focus||text}`); }
    } catch {}
  }

  await runTask(chatId, text);
});

bot.on("polling_error", (e) => console.error("polling:", e.message));

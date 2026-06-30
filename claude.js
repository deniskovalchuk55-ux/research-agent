// ============================================================================
//  CLAUDE — модуль виклику моделі.
// ============================================================================
import { CLAUDE_MODEL } from "./tasks.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Базовий виклик Claude. system — інструкція, userContent — запит.
export async function callClaude(system, userContent, maxTokens = 2000) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY не заданий");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude ${res.status}: ${t.slice(0, 150)}`);
  }

  const data = await res.json();
  return data.content.map((c) => c.text || "").join("").trim();
}

// Виклик що очікує JSON-відповідь (парсить її).
// витягує перший повний JSON-обʼєкт/масив з тексту (ігнорує зайве навколо)
function extractJSON(raw) {
  let s = raw.replace(/```json|```/gi, "").trim();
  // знаходимо перший { або [
  const start = s.search(/[{\[]/);
  if (start === -1) throw new Error("нема JSON у відповіді");
  s = s.slice(start);
  // йдемо по символах рахуючи баланс дужок (з урахуванням рядків)
  const open = s[0], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return JSON.parse(s.slice(0, i + 1)); }
  }
  // якщо не закрилось — пробуємо як є
  return JSON.parse(s);
}

export async function callClaudeJSON(system, userContent, maxTokens = 2000) {
  const raw = await callClaude(system, userContent, maxTokens);
  return extractJSON(raw);
}

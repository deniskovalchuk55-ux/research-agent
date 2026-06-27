// ============================================================================
//  CLAUDE — модуль виклику моделі.
// ============================================================================
import { CLAUDE_MODEL } from "./instructions.js";

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
export async function callClaudeJSON(system, userContent, maxTokens = 2000) {
  const raw = await callClaude(system, userContent, maxTokens);
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

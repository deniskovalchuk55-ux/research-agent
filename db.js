// ============================================================================
//  ПАМʼЯТЬ агента на Neon (Postgres).
//  Два види:
//   1) feedback_rules — правила від користувача, агент дотримується ЗАВЖДИ
//   2) research_archive — архів досліджень, агент памʼятає теми ("памʼятаєш про Х?")
// ============================================================================
import pkg from "pg";
const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;
export const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// створення таблиць при старті
export async function initDB() {
  if (!pool) { console.warn("⚠️ DATABASE_URL не заданий — памʼять вимкнена"); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_rules (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      rule TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS research_archive (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      topic TEXT NOT NULL,
      query TEXT,
      result TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log("✓ Памʼять (Neon) готова");
}

// ─── ПРАВИЛА-ФІДБЕКИ ─────────────────────────────────────────────────────────
export async function addRule(chatId, rule) {
  if (!pool) return;
  await pool.query(`INSERT INTO feedback_rules (chat_id, rule) VALUES ($1,$2)`, [chatId, rule]);
}
export async function getRules(chatId) {
  if (!pool) return [];
  const r = await pool.query(`SELECT rule FROM feedback_rules WHERE chat_id=$1 ORDER BY id`, [chatId]);
  return r.rows.map((x) => x.rule);
}
export async function listRules(chatId) {
  if (!pool) return [];
  const r = await pool.query(`SELECT id, rule FROM feedback_rules WHERE chat_id=$1 ORDER BY id`, [chatId]);
  return r.rows;
}
export async function deleteRule(chatId, id) {
  if (!pool) return;
  await pool.query(`DELETE FROM feedback_rules WHERE chat_id=$1 AND id=$2`, [chatId, id]);
}
export async function clearRules(chatId) {
  if (!pool) return;
  await pool.query(`DELETE FROM feedback_rules WHERE chat_id=$1`, [chatId]);
}

// ─── АРХІВ ДОСЛІДЖЕНЬ ────────────────────────────────────────────────────────
export async function saveResearch(chatId, topic, query, result) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO research_archive (chat_id, topic, query, result) VALUES ($1,$2,$3,$4)`,
    [chatId, topic, query, result]
  );
}
// пошук у архіві за темою (для "памʼятаєш про Х?")
export async function findResearch(chatId, topic) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT topic, query, result, created_at FROM research_archive
     WHERE chat_id=$1 AND (topic ILIKE $2 OR query ILIKE $2)
     ORDER BY created_at DESC LIMIT 3`,
    [chatId, `%${topic}%`]
  );
  return r.rows;
}
export async function listResearch(chatId) {
  if (!pool) return [];
  const r = await pool.query(
    `SELECT id, topic, created_at FROM research_archive WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [chatId]
  );
  return r.rows;
}
export async function deleteResearch(chatId, id) {
  if (!pool) return;
  await pool.query(`DELETE FROM research_archive WHERE chat_id=$1 AND id=$2`, [chatId, id]);
}

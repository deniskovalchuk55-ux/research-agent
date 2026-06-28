// ============================================================================
//  GOOGLE SHEETS — запис знахідок у таблицю.
//
//  НАЛАШТУВАННЯ (робить користувач):
//   1. Google Cloud → новий проєкт → увімкнути Google Sheets API
//   2. Create Service Account → завантажити JSON-ключ
//   3. Створити Google таблицю → дати доступ (Share) email сервіс-акаунту (з JSON, поле client_email) як Editor
//   4. У Railway env:
//        GOOGLE_CREDENTIALS = весь вміст JSON-ключа (одним рядком)
//        SHEET_ID           = id таблиці (з URL: docs.google.com/spreadsheets/d/{SHEET_ID}/edit)
// ============================================================================
import { google } from "googleapis";

const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;
const SHEET_ID = process.env.SHEET_ID;

// колонки (заголовки) — українською, як у ТЗ
const HEADERS = [
  "Назва / Account", "Платформа", "Ніша / Аудиторія", "Чому релевантно",
  "УТП / Pain points", "Посилання (URL)", "Коментар", "Що взяти для себе",
];

function getClient() {
  if (!GOOGLE_CREDENTIALS) throw new Error("GOOGLE_CREDENTIALS не заданий");
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// гарантуємо що вкладка існує і має заголовки
async function ensureSheet(sheets, tabName) {
  // дізнаємось які вкладки є
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    // заголовки
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }
}

// rows: [{name, platform, niche, relevance, utp, url, comment, takeaway}]
// tabName: "Accounts" / "Trends" / "Competitors"
// повертає лінк на таблицю
export async function exportToSheet(rows, tabName = "Accounts") {
  if (!SHEET_ID) throw new Error("SHEET_ID не заданий");
  const sheets = getClient();
  await ensureSheet(sheets, tabName);

  const values = rows.map((r) => [
    r.name || "", r.platform || "", r.niche || "", r.relevance || "",
    r.utp || "", r.url || "", r.comment || "", r.takeaway || "",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
}

export const SHEETS_ENABLED = !!(GOOGLE_CREDENTIALS && SHEET_ID);

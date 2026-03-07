import express from "express";
import { Pool } from "pg";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "20mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize Database using Neon standard dialect
const initDB = async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS session_results (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        amount REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settlements (
        id SERIAL PRIMARY KEY,
        payer_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        payee_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        amount REAL NOT NULL,
        date TEXT NOT NULL,
        status TEXT DEFAULT 'completed'
      );
      
      CREATE TABLE IF NOT EXISTS player_aliases (
        id SERIAL PRIMARY KEY,
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        alias TEXT UNIQUE NOT NULL
      );

      -- Alter existing table to add status column if it doesn't exist
      ALTER TABLE settlements ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
    `);
    client.release();
  } catch (err) {
    console.error("Error creating tables", err);
  }
};

initDB();

// API Routes
app.get("/api/players", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        p.id, 
        p.name, 
        (
          COALESCE((SELECT SUM(amount) FROM session_results WHERE player_id = p.id), 0)
          + COALESCE((SELECT SUM(amount) FROM settlements WHERE payer_id = p.id AND status = 'completed'), 0)
          - COALESCE((SELECT SUM(amount) FROM settlements WHERE payee_id = p.id AND status = 'completed'), 0)
        ) as total_profit
      FROM players p
      ORDER BY total_profit DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch players" });
  }
});

app.get("/api/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.date, s.note, 
             COALESCE(
               json_agg(
                 json_build_object('name', p.name, 'amount', sr.amount)
               ) FILTER (WHERE sr.id IS NOT NULL),
               '[]'
             ) as results
      FROM sessions s
      LEFT JOIN session_results sr ON sr.session_id = s.id
      LEFT JOIN players p ON sr.player_id = p.id
      GROUP BY s.id
      ORDER BY s.date DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { date, note, results } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert session
    const sessionRes = await client.query(
      "INSERT INTO sessions (date, note) VALUES ($1, $2) RETURNING id",
      [date, note]
    );
    const sessionId = sessionRes.rows[0].id;

    for (const result of results) {
      // Resolve aliases before saving
      const resolvedName = await resolvePlayerName(client, result.name);
      // Upsert player and get ID
      const playerRes = await client.query(
        "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [resolvedName]
      );
      const playerId = playerRes.rows[0].id;

      // Insert session result
      await client.query(
        "INSERT INTO session_results (session_id, player_id, amount) VALUES ($1, $2, $3)",
        [sessionId, playerId, result.amount]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, sessionId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save session" });
  } finally {
    client.release();
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM session_results WHERE session_id = $1", [id]);
    await client.query("DELETE FROM sessions WHERE id = $1", [id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete session" });
  } finally {
    client.release();
  }
});

app.get("/api/settlements", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.amount, s.date, s.status, p1.name as payer, p2.name as payee
      FROM settlements s
      JOIN players p1 ON s.payer_id = p1.id
      JOIN players p2 ON s.payee_id = p2.id
      ORDER BY s.date DESC, s.id DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch settlements" });
  }
});

app.post("/api/settlements", async (req, res) => {
  const { payer, payee, amount, date } = req.body;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Upsert payer and payee to guarantee they exist and grab IDs
    const payerRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payer]
    );
    const payeeRes = await client.query(
      "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [payee]
    );

    const payerId = payerRes.rows[0].id;
    const payeeId = payeeRes.rows[0].id;

    const settlementRes = await client.query(
      "INSERT INTO settlements (payer_id, payee_id, amount, date, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id",
      [payerId, payeeId, amount, date]
    );

    await client.query("COMMIT");
    res.json({ success: true, settlementId: settlementRes.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to save settlement" });
  } finally {
    client.release();
  }
});

app.delete("/api/settlements/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE settlements SET status = 'voided' WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to void settlement" });
  }
});

app.patch("/api/settlements/:id/restore", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("UPDATE settlements SET status = 'completed' WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to restore settlement" });
  }
});

// --- Player Alias Management ---

// Resolve a name to canonical player name using aliases (case-insensitive)
async function resolvePlayerName(client: any, name: string): Promise<string> {
  // Check if this name is a known alias
  const aliasRes = await client.query(
    `SELECT p.name FROM player_aliases pa JOIN players p ON pa.player_id = p.id WHERE LOWER(pa.alias) = LOWER($1)`,
    [name.trim()]
  );
  if (aliasRes.rows.length > 0) {
    return aliasRes.rows[0].name;
  }
  return name.trim();
}

// Get all players with their aliases
app.get("/api/players/aliases", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.name,
        COALESCE(
          json_agg(json_build_object('id', pa.id, 'alias', pa.alias))
          FILTER (WHERE pa.id IS NOT NULL), '[]'
        ) as aliases
      FROM players p
      LEFT JOIN player_aliases pa ON pa.player_id = p.id
      GROUP BY p.id
      ORDER BY p.name
    `);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch player aliases" });
  }
});

// Add an alias to a player
app.post("/api/players/:id/aliases", async (req, res) => {
  const { id } = req.params;
  const { alias } = req.body;
  if (!alias?.trim()) {
    return res.status(400).json({ error: "Alias cannot be empty" });
  }
  try {
    // Check if alias conflicts with an existing player name
    const existing = await pool.query("SELECT id FROM players WHERE LOWER(name) = LOWER($1)", [alias.trim()]);
    if (existing.rows.length > 0 && existing.rows[0].id !== parseInt(id)) {
      return res.status(409).json({ error: `"${alias}" is already a player name. Merge them instead by adding "${alias}" as an alias after removing that player.` });
    }
    await pool.query(
      "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2)",
      [id, alias.trim()]
    );
    res.json({ success: true });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: "This alias is already mapped to a player." });
    }
    console.error(error);
    res.status(500).json({ error: "Failed to add alias" });
  }
});

// Remove an alias
app.delete("/api/players/aliases/:aliasId", async (req, res) => {
  try {
    await pool.query("DELETE FROM player_aliases WHERE id = $1", [req.params.aliasId]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to remove alias" });
  }
});

// Merge player: reassign all results/settlements from one player to another, then delete
app.post("/api/players/merge", async (req, res) => {
  const { sourceId, targetId } = req.body;
  if (!sourceId || !targetId || sourceId === targetId) {
    return res.status(400).json({ error: "Invalid merge parameters" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Get source player name to add as alias
    const srcRes = await client.query("SELECT name FROM players WHERE id = $1", [sourceId]);
    if (srcRes.rows.length > 0) {
      // Add source name as alias of target (ignore if already exists)
      await client.query(
        "INSERT INTO player_aliases (player_id, alias) VALUES ($1, $2) ON CONFLICT (alias) DO NOTHING",
        [targetId, srcRes.rows[0].name]
      );
    }
    // Move all aliases from source to target
    await client.query("UPDATE player_aliases SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    // Move session results
    await client.query("UPDATE session_results SET player_id = $1 WHERE player_id = $2", [targetId, sourceId]);
    // Move settlements
    await client.query("UPDATE settlements SET payer_id = $1 WHERE payer_id = $2", [targetId, sourceId]);
    await client.query("UPDATE settlements SET payee_id = $1 WHERE payee_id = $2", [targetId, sourceId]);
    // Delete source player
    await client.query("DELETE FROM players WHERE id = $1", [sourceId]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to merge players" });
  } finally {
    client.release();
  }
});

// Delete a player and all their data
app.delete("/api/players/:id", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM player_aliases WHERE player_id = $1", [id]);
    await client.query("DELETE FROM session_results WHERE player_id = $1", [id]);
    await client.query("DELETE FROM settlements WHERE payer_id = $1 OR payee_id = $1", [id]);
    await client.query("DELETE FROM players WHERE id = $1", [id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to delete player" });
  } finally {
    client.release();
  }
});

// Reset all data
app.post("/api/reset", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM session_results");
    await client.query("DELETE FROM settlements");
    await client.query("DELETE FROM player_aliases");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM players");
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Failed to reset data" });
  } finally {
    client.release();
  }
});

// Extract poker results from uploaded file using Gemini AI
app.post("/api/extract", async (req, res) => {
  const { data, mimeType, isText } = req.body;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Gemini API key is not configured on the server." });
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-2.5-flash";

  const prompt = `
    Extract player names and their corresponding profit/loss amounts from this poker session data.
    Look for names and numbers (positive for profit, negative for loss).
    Return the data as a clean JSON array of objects with 'name' and 'amount' properties.
    If a name looks like an alias or is misspelled, keep it as is; the user will correct it.
  `;

  const parts: any[] = [{ text: prompt }];

  if (isText) {
    parts.push({ text: data });
  } else {
    // data is a base64 data URL like "data:application/pdf;base64,..."
    const base64Data = data.includes(",") ? data.split(",")[1] : data;
    parts.push({
      inlineData: {
        mimeType: mimeType,
        data: base64Data,
      },
    });
  }

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount: { type: Type.NUMBER },
            },
            required: ["name", "amount"],
          },
        },
      },
    });

    const results = JSON.parse(response.text || "[]");
    res.json(results);
  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const msg = error?.message || "";
    if (msg.includes("API key")) {
      return res.status(401).json({ error: "Invalid or missing Gemini API key." });
    }
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
      return res.status(429).json({ error: "Gemini API rate limit exceeded. Please wait a moment and try again, or check your API key quota at https://aistudio.google.com/apikey." });
    }
    res.status(500).json({ error: "Failed to process file with AI. Please try again." });
  }
});

export default app;

import express from "express";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

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
      // Upsert player and get ID
      const playerRes = await client.query(
        "INSERT INTO players (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [result.name]
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
    res.status(500).json({ error: "Failed to delete settlement" });
  }
});

export default app;

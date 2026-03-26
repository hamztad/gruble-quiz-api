const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 3000;

async function setupTestTable() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Database connection error: DATABASE_URL is not set");
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test (
        id SERIAL PRIMARY KEY,
        message TEXT
      )
    `);
    await pool.query("INSERT INTO test (message) VALUES ($1)", [
      "Hello from Gruble",
    ]);
    const result = await pool.query("SELECT * FROM test ORDER BY id");
    console.log("Database connected");
    console.log("All rows in test:", result.rows);
  } catch (err) {
    console.error("Database connection error:", err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

setupTestTable();

app.get("/", (_req, res) => {
  res.status(200).send("Gruble API kjører");
});

app.get("/api/quiz/today", (_req, res) => {
  res.status(200).json({
    theme: "Test",
    questions: [
      {
        id: 1,
        question: "Hva heter hovedstaden i Norge?",
        options: ["Oslo", "Bergen", "Trondheim", "Stavanger"],
      },
    ],
  });
});

app.listen(port, () => {
  console.log(`Gruble API listening on port ${port}`);
});

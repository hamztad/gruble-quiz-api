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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY,
        theme TEXT,
        questions JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query("INSERT INTO test (message) VALUES ($1)", [
      "Hello from Gruble",
    ]);
    const quizCountResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM quizzes"
    );

    if (quizCountResult.rows[0].count === 0) {
      await pool.query(
        "INSERT INTO quizzes (theme, questions) VALUES ($1, $2::jsonb)",
        [
          "Test",
          JSON.stringify([
            {
              id: 1,
              question: "Hva heter hovedstaden i Norge?",
              options: ["Oslo", "Bergen", "Trondheim", "Stavanger"],
              answer: "Oslo",
            },
          ]),
        ]
      );
    }

    const result = await pool.query("SELECT * FROM test ORDER BY id");
    const quizzesResult = await pool.query("SELECT * FROM quizzes ORDER BY id");
    console.log("Database connected");
    console.log("All rows in test:", result.rows);
    console.log("All rows in quizzes:", quizzesResult.rows);
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

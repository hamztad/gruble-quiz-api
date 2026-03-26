const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT) || 3000;

function testDatabaseConnection() {
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

  pool
    .query("SELECT 1")
    .then(() => {
      console.log("Database connected");
      return pool.end();
    })
    .catch((err) => {
      console.error("Database connection error:", err.message);
      return pool.end().catch(() => {});
    });
}

testDatabaseConnection();

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

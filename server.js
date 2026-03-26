const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(cors());

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

app.get("/prototype", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/quiz/today", async (_req, res) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(500).json({ error: "DATABASE_URL is not set" });
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
    const result = await pool.query(
      "SELECT * FROM quizzes ORDER BY created_at DESC LIMIT 1"
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "No quiz found" });
      return;
    }

    const quiz = result.rows[0];
    const questions =
      typeof quiz.questions === "string"
        ? JSON.parse(quiz.questions)
        : JSON.parse(JSON.stringify(quiz.questions));

    const questionsForClient = questions.map((q) => {
      const { answer, ...rest } = q;
      return rest;
    });

    res.status(200).json({
      theme: quiz.theme,
      questions: questionsForClient,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

app.post("/api/quiz/answer", async (req, res) => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(500).json({ error: "DATABASE_URL is not set" });
    return;
  }

  const { questionId, answer, mode, attemptNumber } = req.body ?? {};
  if (questionId === undefined || questionId === null || answer === undefined) {
    res.status(400).json({ error: "Missing questionId or answer" });
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
    const result = await pool.query(
      "SELECT * FROM quizzes ORDER BY created_at DESC LIMIT 1"
    );

    if (result.rows.length === 0) {
      res.status(200).json({ correct: false, points: 0 });
      return;
    }

    const quiz = result.rows[0];
    const questions =
      typeof quiz.questions === "string"
        ? JSON.parse(quiz.questions)
        : JSON.parse(JSON.stringify(quiz.questions));

    const question = questions.find(
      (q) => Number(q.id) === Number(questionId)
    );

    if (!question || question.answer === undefined) {
      res.status(200).json({ correct: false, points: 0 });
      return;
    }

    const userAnswer = String(answer).trim().toLowerCase();
    const correctAnswer = String(question.answer).trim().toLowerCase();
    const correct = userAnswer === correctAnswer;

    const answerMode = mode === "mc" ? "mc" : "written";
    let points = 0;

    if (answerMode === "mc") {
      const attempt = Math.min(4, Math.max(1, Number(attemptNumber) || 1));
      if (correct) {
        points = Math.max(0, 4 - attempt);
      }
    } else {
      points = correct ? 3 : 0;
    }

    res.status(200).json({ correct, points });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

function validateGeneratedQuiz(payload, expectedTheme) {
  if (!payload || typeof payload !== "object") {
    return "Invalid payload";
  }
  if (typeof payload.theme !== "string" || !payload.theme.trim()) {
    return "theme missing";
  }
  if (payload.theme.trim().toLowerCase() !== expectedTheme.toLowerCase()) {
    return "theme mismatch";
  }
  const questions = payload.questions;
  if (!Array.isArray(questions) || questions.length < 3 || questions.length > 5) {
    return "questions must be an array of 3–5 items";
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== "object") {
      return `question ${i} invalid`;
    }
    if (typeof q.id !== "number" || !Number.isInteger(q.id)) {
      return `question ${i} id must be integer`;
    }
    if (typeof q.question !== "string" || !q.question.trim()) {
      return `question ${i} question text missing`;
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      return `question ${i} must have exactly 4 options`;
    }
    if (!q.options.every((o) => typeof o === "string" && o.trim())) {
      return `question ${i} options must be non-empty strings`;
    }
    if (typeof q.answer !== "string" || !q.answer.trim()) {
      return `question ${i} answer missing`;
    }
    if (!q.options.includes(q.answer)) {
      return `question ${i} answer must match one of options`;
    }
  }
  return null;
}

app.post("/api/internal/generate-test-quiz", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    return;
  }

  const theme =
    typeof req.body?.theme === "string" ? req.body.theme.trim() : "";
  if (!theme) {
    res.status(400).json({ error: "Missing or empty theme" });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const themeJson = JSON.stringify(theme);
  const userPrompt = `Generer mellom 3 og 5 enkle flervalgsoppgaver på norsk om temaet: ${themeJson}.

Hvert element i "questions" skal ha:
- id: heltall fra 1 og oppover
- question: spørsmålstekst
- options: nøyaktig 4 strenger (ett riktig svar, tre plausibel feil)
- answer: eksakt lik én av strengene i options

Feltet "theme" i JSON-svaret skal være eksakt: ${themeJson}

Returner KUN JSON med denne formen (ingen markdown):
{"theme":...,"questions":[...]}`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Du svarer kun med gyldig JSON-objekt. Ingen forklaring, ingen markdown.",
        },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      res.status(502).json({ error: "Empty response from OpenAI" });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      res.status(502).json({ error: "OpenAI returned non-JSON" });
      return;
    }

    const validationError = validateGeneratedQuiz(parsed, theme);
    if (validationError) {
      res.status(502).json({
        error: "Invalid quiz shape from model",
        detail: validationError,
      });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    const message =
      err && typeof err.message === "string" ? err.message : "OpenAI failed";
    res.status(502).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`Gruble API listening on port ${port}`);
});

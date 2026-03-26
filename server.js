const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const OpenAI = require("openai");

const app = express();
const port = Number(process.env.PORT) || 3000;

function readPromptFile(filename) {
  return fs.readFileSync(path.join(__dirname, "prompts", filename), "utf8").trim();
}

const WRITTEN_EVAL_SYSTEM = readPromptFile("evaluateWritten.txt");
const GENERATE_QUIZ_SYSTEM = readPromptFile("generateQuiz.txt");
const CHECK_QUESTION_SYSTEM = readPromptFile("checkQuestionSuitability.txt");

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

async function evaluateWrittenAnswerWithOpenAI(
  openai,
  model,
  questionText,
  correctAnswer,
  userAnswer
) {
  const payload = {
    question: questionText,
    correctAnswer,
    userAnswer,
  };

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: WRITTEN_EVAL_SYSTEM },
      {
        role: "user",
        content: `Vurder brukerens svar mot spørsmålet og fasiten. Returner JSON med correct, points og feedback.\n\n${JSON.stringify(
          payload
        )}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.25,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty OpenAI response");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned non-JSON");
  }

  let points = Number(parsed.points);
  if (!Number.isFinite(points)) {
    points = 0;
  }
  points = Math.round(Math.max(0, Math.min(10, points)));

  let correct = points > 0;

  const feedback =
    typeof parsed.feedback === "string" ? parsed.feedback.trim() : "";

  return {
    correct,
    points,
    feedback:
      feedback ||
      (correct
        ? `Du fikk ${points} poeng.`
        : "Svaret ditt treffer ikke godt nok."),
  };
}

async function parseJsonChatCompletion(completionPromise) {
  const completion = await completionPromise;
  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty OpenAI response");
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("OpenAI returned non-JSON");
  }
}

async function generateQuizWithOpenAI(openai, model, theme, questionCount) {
  const themeJson = JSON.stringify(theme);
  const userPrompt = `Generer ${questionCount} enkle flervalgsoppgaver på norsk om temaet: ${themeJson}.

Hvert element i "questions" skal ha:
- id: heltall fra 1 og oppover
- question: spørsmålstekst
- options: nøyaktig 4 strenger (ett riktig svar, tre plausibel feil)
- answer: eksakt lik én av strengene i options

Feltet "theme" i JSON-svaret skal være eksakt: ${themeJson}

Returner KUN JSON med denne formen (ingen markdown):
{"theme":...,"questions":[...]}`;

  const parsed = await parseJsonChatCompletion(
    openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: GENERATE_QUIZ_SYSTEM,
        },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    })
  );

  const validationError = validateGeneratedQuiz(
    parsed,
    theme,
    questionCount,
    questionCount
  );
  if (validationError) {
    throw new Error(`Invalid quiz shape from model: ${validationError}`);
  }

  return {
    ...parsed,
    questions: parsed.questions.map(shuffleQuestionOptions),
  };
}

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

    const answerMode = mode === "mc" ? "mc" : "written";

    if (answerMode === "mc") {
      const userAnswerNorm = String(answer).trim().toLowerCase();
      const correctAnswerNorm = String(question.answer).trim().toLowerCase();
      const correct = userAnswerNorm === correctAnswerNorm;
      const attempt = Math.min(4, Math.max(1, Number(attemptNumber) || 1));
      let points = 0;
      if (correct) {
        points = Math.max(0, 4 - attempt);
      }
      res.status(200).json({ correct, points });
      return;
    }

    const userAnswerRaw = String(answer).trim();
    if (!userAnswerRaw) {
      res.status(200).json({
        correct: false,
        points: 0,
        feedback: "Du sendte ikke inn noe svar.",
      });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "OPENAI_API_KEY is not set" });
      return;
    }

    const openai = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const questionText = String(question.question ?? "").trim();
    const correctAnswer = String(question.answer).trim();

    let evaluated;
    try {
      evaluated = await evaluateWrittenAnswerWithOpenAI(
        openai,
        model,
        questionText,
        correctAnswer,
        userAnswerRaw
      );
    } catch (evalErr) {
      const msg =
        evalErr && typeof evalErr.message === "string"
          ? evalErr.message
          : "OpenAI evaluation failed";
      res.status(502).json({ error: msg });
      return;
    }

    res.status(200).json({
      correct: evaluated.correct,
      points: evaluated.points,
      feedback: evaluated.feedback,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

function validateGeneratedQuiz(payload, expectedTheme, minQuestions = 3, maxQuestions = 5) {
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
  if (
    !Array.isArray(questions) ||
    questions.length < minQuestions ||
    questions.length > maxQuestions
  ) {
    return `questions must be an array of ${minQuestions}–${maxQuestions} items`;
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

function shuffleArray(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function shuffleQuestionOptions(question) {
  return {
    ...question,
    options: shuffleArray(question.options),
  };
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

  try {
    const questionCount = 3 + Math.floor(Math.random() * 3);
    const parsed = await generateQuizWithOpenAI(openai, model, theme, questionCount);

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
      await pool.query(
        "INSERT INTO quizzes (theme, questions) VALUES ($1, $2::jsonb)",
        [parsed.theme.trim(), JSON.stringify(parsed.questions)]
      );
    } catch (dbErr) {
      const dbMessage =
        dbErr && typeof dbErr.message === "string"
          ? dbErr.message
          : "Failed to save quiz";
      res.status(500).json({ error: dbMessage });
      return;
    } finally {
      await pool.end().catch(() => {});
    }

    res.status(200).json(parsed);
  } catch (err) {
    const message =
      err && typeof err.message === "string" ? err.message : "OpenAI failed";
    res.status(502).json({ error: message });
  }
});

app.post("/api/quiz/check-question", async (req, res) => {
  const { question, questionId, theme } = req.body ?? {};
  const questionText = typeof question === "string" ? question.trim() : "";
  const themeText = typeof theme === "string" ? theme.trim() : "";

  if (!questionText || questionId === undefined || questionId === null || !themeText) {
    res.status(400).json({ error: "Missing question, questionId or theme" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  let suitability;
  try {
    suitability = await parseJsonChatCompletion(
      openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: CHECK_QUESTION_SYSTEM,
          },
          {
            role: "user",
            content: JSON.stringify({
              question: questionText,
              questionId,
              theme: themeText,
            }),
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      })
    );
  } catch (err) {
    const message =
      err && typeof err.message === "string"
        ? err.message
        : "OpenAI suitability check failed";
    res.status(502).json({ error: message });
    return;
  }

  if (suitability && suitability.valid === true) {
    res.status(200).json({
      valid: true,
      message: "Dette spørsmålet kan besvares skriftlig.",
    });
    return;
  }

  let replacementQuestion;
  try {
    const replacementQuiz = await generateQuizWithOpenAI(openai, model, themeText, 1);
    replacementQuestion = replacementQuiz.questions[0];
    if (replacementQuestion && Number.isFinite(Number(questionId))) {
      replacementQuestion = {
        ...replacementQuestion,
        id: Number(questionId),
      };
    }
  } catch (err) {
    const message =
      err && typeof err.message === "string"
        ? err.message
        : "Failed to generate replacement question";
    res.status(502).json({ error: message });
    return;
  }

  res.status(200).json({
    valid: false,
    message: "Du har rett, spørsmålet egner seg ikke for skrivesvar.",
    points: 5,
    question: replacementQuestion,
  });
});

app.listen(port, () => {
  console.log(`Gruble API listening on port ${port}`);
});

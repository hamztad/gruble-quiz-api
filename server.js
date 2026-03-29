const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");
const OpenAI = require("openai");
const {
  attachDecorativeQuizImages,
  pickSharedDecorativeImage,
  normalizeQuizQuestionsFromDb,
  serializeQuizForStorage,
} = require("./quizImages");
const {
  QUIZ_MEMORY_MODE,
  filterQuizQuestionsAgainstMemory,
  insertQuizQuestionMemoryRows,
  normalizeFactKey,
  normalizeQuizQuestionText,
  normalizeQuizAnswerText,
  normalizedAnswersTooSimilar,
  normalizedFactKeysTooSimilar,
  normalizedQuestionsTooSimilar,
} = require("./quizMemory");

const app = express();
const port = Number(process.env.PORT) || 3000;

function readPromptFile(filename) {
  return fs.readFileSync(path.join(__dirname, "prompts", filename), "utf8").trim();
}

const WRITTEN_EVAL_SYSTEM = readPromptFile("evaluateWritten.txt");
const EXPLAIN_MC_ANSWER_SYSTEM = readPromptFile("explainMcAnswer.txt");
const GENERATE_QUIZ_SYSTEM = readPromptFile("generateQuiz.txt");
const CHECK_QUESTION_SYSTEM = readPromptFile("checkQuestionSuitability.txt");
const EVALUATE_PROTEST_SYSTEM = readPromptFile("evaluateProtest.txt");

/** @param {unknown} raw */
function normalizeQuizDifficulty(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "easy" || s === "lett") {
    return "easy";
  }
  if (s === "hard" || s === "vanskelig") {
    return "hard";
  }
  if (s === "normal") {
    return "normal";
  }
  return "easy";
}

/** Poengmultiplikator for riktige svar (server-styrt ut fra lagret quiz). */
function getQuizDifficultyPointMultiplier(difficulty) {
  switch (normalizeQuizDifficulty(difficulty)) {
    case "easy":
      return 1;
    case "normal":
      return 1.5;
    case "hard":
      return 2;
    default:
      return 1.5;
  }
}

const QUIZ_DIFFICULTY_GENERATION_INSTRUCTIONS = {
  easy: `VANSKEGRAD — LETT
- Balanse mellom tilgjengelighet og kunnskapskrav, i tråd med øvrige regler i denne systemmeldingen.`,
  normal: `VANSKEGRAD — NORMAL
- Still mer presise eller spesifikke spørsmål som krever solid kunnskap, fortsatt med nøyaktig én entydig, dokumenterbar fasit.
- Lag feilsvar som er mer krevende og sannsynlige for noen som kan litt, uten flere riktige svar.
- Unngå de aller mest opplagte «første-faktum»-spørsmålene om temaet.
- Unngå helt grunnleggende skolebokspørsmål som de fleste kan svare på umiddelbart uten fordypning, som «Hvilket organ pumper blod gjennom kroppen?» eller «Hva heter hovedstaden i Norge?».`,
  hard: `VANSKEGRAD — VANSKELIG
- Still tydelig mer krevende spørsmål enn NORMAL, med smalere eller mindre opplagte, men fortsatt godt dokumenterbare fakta.
- Lag feilsvar som ligger tett opptil fasiten i type, detaljnivå eller periode, uten at flere svar kan forsvares.
- Foretrekk spørsmål som skiller god kunnskap fra overflatisk gjetting.
- Unngå brede, innledende eller veldig kjente faktaspørsmål; velg heller et mindre opplagt, men fortsatt rettferdig og dokumenterbart snitt av temaet.
- Ikke bruk obskur eller udokumenterbar trivia som bryter trygghets- og sannhetskravene over.`,
};

/** @param {unknown} difficulty */
function buildGenerateQuizSystemContent(difficulty) {
  const d = normalizeQuizDifficulty(difficulty);
  const extra =
    QUIZ_DIFFICULTY_GENERATION_INSTRUCTIONS[d] ||
    QUIZ_DIFFICULTY_GENERATION_INSTRUCTIONS.normal;
  return `${GENERATE_QUIZ_SYSTEM}\n\n---\n\n${extra}`;
}

/**
 * @param {number} points
 * @param {unknown} difficulty
 */
function applyQuizDifficultyToPoints(points, difficulty) {
  const n = Number(points);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  const m = getQuizDifficultyPointMultiplier(difficulty);
  return Math.max(0, Math.round(n * m));
}

/** Nytt: maksimal lengde og ord for tema ved quizgenerering fra brukerinput. */
const THEME_INPUT_MAX_CHARS = 50;
const THEME_INPUT_MAX_WORDS = 3;

/** Lagres som `variant` i questions JSONB; skiller bilde-10-quiz fra standard flyt. */
const VISUAL_TEN_QUIZ_VARIANT = "visual-10";
const VISUAL_TEN_QUIZ_QUESTION_COUNT = 10;
/** Lagres som quiz-radens tema og i JSON; spørsmål 1–9 har egne undertemaer. */
const VISUAL_TEN_DISPLAY_THEME = "Allmenn quiz";
const VISUAL_TEN_BATCH_SIZE = 3;
const VISUAL_TEN_RECENT_QUIZ_COOLING_LIMIT = 4;
const VISUAL_TEN_IMAGE_PICK_TRIES = 10;
const VISUAL_TEN_THEME_PRESETS = Object.freeze([
  { theme: "historie", weight: 18, subjectMode: true },
  { theme: "geografi", weight: 16, subjectMode: true },
  { theme: "naturfag", weight: 16, subjectMode: true },
  { theme: "kunst", weight: 12, subjectMode: true },
  { theme: "musikk", weight: 11, subjectMode: false },
  { theme: "dyr", weight: 10, subjectMode: false },
  { theme: "litteratur", weight: 10, subjectMode: false },
  { theme: "arkitektur", weight: 9, subjectMode: false },
  { theme: "idrett", weight: 9, subjectMode: false },
  { theme: "romfart", weight: 7, subjectMode: false },
  { theme: "teknologi", weight: 7, subjectMode: false },
  { theme: "oppfinnelser", weight: 6, subjectMode: false },
  { theme: "mytologi", weight: 6, subjectMode: false },
  { theme: "verdensarv", weight: 6, subjectMode: false },
]);

function getQuizMemoryRuntime(memoryOptions) {
  const mode =
    memoryOptions && memoryOptions.mode === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;
  const pool =
    memoryOptions &&
    memoryOptions.pool &&
    typeof memoryOptions.pool.query === "function"
      ? memoryOptions.pool
      : null;
  return { mode, pool };
}

function pickWeightedVisualTenThemePreset() {
  const totalWeight = VISUAL_TEN_THEME_PRESETS.reduce(
    (sum, preset) => sum + Math.max(0, Number(preset.weight) || 0),
    0
  );
  if (totalWeight <= 0) {
    return VISUAL_TEN_THEME_PRESETS[0];
  }
  let cursor = Math.random() * totalWeight;
  for (const preset of VISUAL_TEN_THEME_PRESETS) {
    cursor -= Math.max(0, Number(preset.weight) || 0);
    if (cursor < 0) {
      return preset;
    }
  }
  return VISUAL_TEN_THEME_PRESETS[VISUAL_TEN_THEME_PRESETS.length - 1];
}

function getVisualTenPresetAdjustedWeight(preset, recentThemeCounts, excludedThemes) {
  if (!preset) {
    return 0;
  }
  if (excludedThemes && excludedThemes.has(preset.theme)) {
    return 0;
  }
  const base = Math.max(0, Number(preset.weight) || 0);
  const recentCount = Math.max(0, Number(recentThemeCounts?.[preset.theme]) || 0);
  if (recentCount <= 0) {
    return base;
  }
  return Math.max(0.25, base / (1 + recentCount * 1.15));
}

function pickWeightedVisualTenThemePresetWithCooling(
  recentThemeCounts = null,
  excludedThemes = null
) {
  const weights = VISUAL_TEN_THEME_PRESETS.map((preset) =>
    getVisualTenPresetAdjustedWeight(preset, recentThemeCounts, excludedThemes)
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    for (const preset of VISUAL_TEN_THEME_PRESETS) {
      if (!excludedThemes || !excludedThemes.has(preset.theme)) {
        return preset;
      }
    }
    return VISUAL_TEN_THEME_PRESETS[0];
  }
  let cursor = Math.random() * totalWeight;
  for (let i = 0; i < VISUAL_TEN_THEME_PRESETS.length; i += 1) {
    cursor -= weights[i];
    if (cursor < 0) {
      return VISUAL_TEN_THEME_PRESETS[i];
    }
  }
  return VISUAL_TEN_THEME_PRESETS[VISUAL_TEN_THEME_PRESETS.length - 1];
}

/**
 * Trekker undertemaer uten duplikater i samme bilde-quiz.
 * Det gir bredere variasjon i én og samme runde, men ulik miks mellom runder.
 */
function pickWeightedVisualTenThemePresetsMany(count, recentThemeCounts = null) {
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  const out = [];
  const excludedThemes = new Set();
  while (out.length < n && excludedThemes.size < VISUAL_TEN_THEME_PRESETS.length) {
    const picked = pickWeightedVisualTenThemePresetWithCooling(
      recentThemeCounts,
      excludedThemes
    );
    if (!picked || excludedThemes.has(picked.theme)) {
      break;
    }
    excludedThemes.add(picked.theme);
    out.push(picked);
  }
  while (out.length < n) {
    out.push(
      pickWeightedVisualTenThemePresetWithCooling(recentThemeCounts, new Set())
    );
  }
  return out;
}

function isValidVisualTenQuizPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  if (questions.length !== VISUAL_TEN_QUIZ_QUESTION_COUNT) {
    return false;
  }
  if (payload.variant && payload.variant !== VISUAL_TEN_QUIZ_VARIANT) {
    return false;
  }
  const lastQuestion = questions[questions.length - 1];
  if (!lastQuestion || lastQuestion.imageQuestion !== true) {
    return false;
  }
  const sharedImage = payload.sharedImage;
  if (
    !sharedImage ||
    typeof sharedImage !== "object" ||
    typeof sharedImage.url !== "string" ||
    !sharedImage.url.trim()
  ) {
    return false;
  }
  return true;
}

/**
 * Nytt: avvis for langt tema før OpenAI-kall (testgenerering).
 * @returns {string|null} feilmelding på norsk, eller null hvis OK
 */
/** Fjerner backend-felt som ikke skal til klient. */
function stripQuestionForPublicClient(q) {
  if (!q || typeof q !== "object") {
    return q;
  }
  const { answer, fact_key, source_theme, ...rest } = q;
  return rest;
}

/** Fjerner fact_key fra generert quiz-payload (svar beholdes for interne kall). */
function stripFactKeyFromQuizPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const qs = payload.questions;
  if (!Array.isArray(qs)) {
    return payload;
  }
  return {
    ...payload,
    questions: qs.map((q) => {
      if (!q || typeof q !== "object") {
        return q;
      }
      const { fact_key, source_theme, ...rest } = q;
      return rest;
    }),
  };
}

async function fetchRecentVisualTenThemeCounts(pool) {
  if (!pool || typeof pool.query !== "function") {
    return {};
  }
  try {
    const result = await pool.query(
      `SELECT questions
       FROM quizzes
       WHERE questions::jsonb->>'variant' = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [VISUAL_TEN_QUIZ_VARIANT, VISUAL_TEN_RECENT_QUIZ_COOLING_LIMIT]
    );
    const counts = {};
    for (const row of result.rows) {
      const payload = getQuizQuestionsPayloadFromRow(row);
      const qs = Array.isArray(payload?.questions) ? payload.questions : [];
      for (const q of qs) {
        const theme = String(q?.source_theme ?? "").trim();
        if (!theme) {
          continue;
        }
        counts[theme] = (counts[theme] || 0) + 1;
      }
    }
    return counts;
  } catch (err) {
    console.warn(
      "[visual-10] recent theme counts unavailable:",
      err && typeof err.message === "string" ? err.message : String(err)
    );
    return {};
  }
}

function chunkArray(values, size) {
  const list = Array.isArray(values) ? values : [];
  const n = Math.max(1, Math.floor(Number(size)) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    out.push(list.slice(i, i + n));
  }
  return out;
}

function buildVisualTenBatchUserPrompt(slots, existingQuestions, difficulty) {
  const diffNorm = normalizeQuizDifficulty(difficulty);
  const diffHuman =
    diffNorm === "easy" ? "lett" : diffNorm === "hard" ? "vanskelig" : "normal";
  const slotLines = slots
    .map(
      (slot, idx) =>
        `${idx + 1}. ${JSON.stringify(slot.theme)} (${slot.subjectMode ? "fagmodus" : "allmennmodus"})`
    )
    .join("\n");
  const existingLines =
    Array.isArray(existingQuestions) && existingQuestions.length > 0
      ? existingQuestions
          .map(
            (q, idx) =>
              `${idx + 1}. undertema=${JSON.stringify(String(q?.source_theme ?? ""))} spørsmål=${JSON.stringify(String(q?.question ?? ""))} fasit=${JSON.stringify(String(q?.answer ?? ""))} fact_key=${JSON.stringify(String(q?.fact_key ?? ""))}`
          )
          .join("\n")
      : "";

  return `Du lager delspørsmål 1–9 i en allmenn bilde-quiz.

Temaet for hele JSON-svaret skal være eksakt ${JSON.stringify(VISUAL_TEN_DISPLAY_THEME)}.
Vanskegrad: ${diffHuman}.

Lag nøyaktig ${slots.length} flervalgsoppgaver, og bruk hvert undertema nøyaktig én gang:
${slotLines}

For hvert spørsmål i "questions":
- bruk nøyaktig ett av undertemaene over
- legg inn feltet "source_theme" med eksakt undertema-streng
- legg inn feltene id, question, options, answer, fact_key
- fact_key er obligatorisk og skal beskrive kjernefaktumet
- spørsmålene må være fullt selvstendige, dokumenterbare og ha én klar fasit
- ikke knytt spørsmålene til illustrasjonsbildet; det kommer først i spørsmål 10

Fagmodus betyr at undertemaet skal tolkes som skolefag eller undervisningsstoff, ikke løs trivia.
Allmennmodus betyr vanlig allmennkunnskap.

Variasjon er svært viktig:
- ett spørsmål per undertema, ikke flere vinkler på samme detalj
- ikke gjenbruk samme kjernefaktum mellom undertemaene
- unngå overbrukte kontrollspørsmål og smal trivia når bredere, mer relevante fakta finnes
- spre spørsmålene over ulike deler av undertemaene når mulig

${
  existingLines
    ? `Allerede brukt i denne quizen (ikke gjenta samme faktum, formulering eller nærvariant):
${existingLines}
`
    : ""
}
Returner KUN gyldig JSON med formen:
{"theme":"${VISUAL_TEN_DISPLAY_THEME}","questions":[{"id":1,"source_theme":"...","question":"...","options":["...","...","...","..."],"answer":"...","fact_key":"..."}]}`;
}

function getVisualTenBatchValidationError(payload, slots) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (questions.length !== slots.length) {
    return `visual-10 batch expected ${slots.length} questions`;
  }
  const allowedThemes = new Set(slots.map((slot) => String(slot.theme).trim()));
  const seenThemes = new Set();
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const sourceTheme = String(q?.source_theme ?? "").trim();
    if (!sourceTheme) {
      return `visual-10 batch question ${i + 1} missing source_theme`;
    }
    if (!allowedThemes.has(sourceTheme)) {
      return `visual-10 batch question ${i + 1} source_theme invalid`;
    }
    if (seenThemes.has(sourceTheme)) {
      return `visual-10 batch source_theme repeated: ${sourceTheme}`;
    }
    seenThemes.add(sourceTheme);
  }
  if (seenThemes.size !== allowedThemes.size) {
    return "visual-10 batch missing one or more source themes";
  }
  return null;
}

function validateThemeForQuizInput(theme) {
  const raw = String(theme ?? "").trim();
  if (raw.length > THEME_INPUT_MAX_CHARS) {
    return "Tema er for langt (maks 50 tegn).";
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > THEME_INPUT_MAX_WORDS) {
    return "Tema kan ha maks 3 ord.";
  }
  return null;
}

app.use(express.json());
app.use(cors());
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

const transcribeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

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
    await pool.query(`
      ALTER TABLE quizzes
      ADD COLUMN IF NOT EXISTS difficulty TEXT NOT NULL DEFAULT 'easy'
    `);
    await pool.query(`
      ALTER TABLE quizzes
      ALTER COLUMN difficulty SET DEFAULT 'easy'
    `);
    /* Nytt: minne for duplikatkontroll av spørsmålstekster (første versjon). */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quiz_question_memory (
        id SERIAL PRIMARY KEY,
        theme_normalized TEXT NOT NULL DEFAULT '',
        question_original TEXT NOT NULL,
        question_normalized TEXT NOT NULL,
        quiz_source TEXT NOT NULL DEFAULT 'custom',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_quiz_question_memory_created
      ON quiz_question_memory (created_at DESC)
    `);
    await pool.query(`
      ALTER TABLE quiz_question_memory
      ADD COLUMN IF NOT EXISTS answer_original TEXT NOT NULL DEFAULT ''
    `);
    await pool.query(`
      ALTER TABLE quiz_question_memory
      ADD COLUMN IF NOT EXISTS answer_normalized TEXT NOT NULL DEFAULT ''
    `);
    await pool.query(`
      ALTER TABLE quiz_question_memory
      ADD COLUMN IF NOT EXISTS fact_key_normalized TEXT NOT NULL DEFAULT ''
    `);
    await pool.query("INSERT INTO test (message) VALUES ($1)", [
      "Hello from Gruble",
    ]);
    const quizCountResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM quizzes"
    );

    if (quizCountResult.rows[0].count === 0) {
      await pool.query(
        "INSERT INTO quizzes (theme, questions, difficulty) VALUES ($1, $2::jsonb, $3)",
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
          "easy",
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

/** Leser questions JSONB (array el. { sharedImage, questions }). */
function getQuizQuestionsPayloadFromRow(quizRow) {
  try {
    const raw =
      typeof quizRow.questions === "string"
        ? JSON.parse(quizRow.questions)
        : JSON.parse(JSON.stringify(quizRow.questions));
    return normalizeQuizQuestionsFromDb(raw);
  } catch {
    return { sharedImage: null, questions: [], variant: null };
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("Gruble API kjører");
});

app.get("/prototype", (_req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
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

async function explainMcAnswerWithOpenAI(
  openai,
  model,
  questionText,
  correctAnswer,
  selectedAnswer,
  isCorrect
) {
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: EXPLAIN_MC_ANSWER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          question: questionText,
          correctAnswer,
          selectedAnswer,
          isCorrect,
        }),
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

  const feedback =
    typeof parsed.feedback === "string" ? parsed.feedback.trim() : "";
  return feedback;
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

function normalizeProtestMvpResult(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      status: "rejected",
      points: 0,
      feedback: "Kunne ikke tolke modellens svar.",
    };
  }

  const s = String(raw.status ?? "")
    .trim()
    .toLowerCase();
  let status;
  if (
    s === "partial" ||
    s === "delvis" ||
    s.includes("partial") ||
    s.includes("delvis")
  ) {
    status = "partial";
  } else if (
    s === "approved" ||
    s === "godkjent" ||
    (s.includes("godkjent") && !/ikke|avvis/.test(s))
  ) {
    status = "approved";
  } else if (s === "rejected" || s === "avvist" || s.includes("avvist")) {
    status = "rejected";
  } else {
    status = "rejected";
  }

  const points =
    status === "approved" ? 10 : status === "partial" ? 5 : 0;

  let feedback = typeof raw.feedback === "string" ? raw.feedback.trim() : "";
  if (!feedback) {
    feedback =
      status === "approved"
        ? "Protesten ble vurdert som godkjent."
        : status === "partial"
          ? "Protesten ble delvis tatt til følge."
          : "Protesten ble avvist.";
  }

  return { status, points, feedback };
}

async function fetchAnswerForProtestFromDb(questionId) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return "";
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  try {
    const findAnswer = (quiz) => {
      const { questions } = getQuizQuestionsPayloadFromRow(quiz);
      const q = questions.find((item) => Number(item.id) === Number(questionId));
      if (!q || q.answer === undefined || q.answer === null) {
        return "";
      }
      return String(q.answer).trim();
    };

    const standard = await pool.query(
      `SELECT * FROM quizzes
       WHERE (questions::jsonb->>'variant' IS DISTINCT FROM $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [VISUAL_TEN_QUIZ_VARIANT]
    );
    if (standard.rows.length > 0) {
      const a = findAnswer(standard.rows[0]);
      if (a) {
        return a;
      }
    }

    const visual = await pool.query(
      `SELECT * FROM quizzes
       WHERE questions::jsonb->>'variant' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [VISUAL_TEN_QUIZ_VARIANT]
    );
    if (visual.rows.length > 0) {
      return findAnswer(visual.rows[0]);
    }
    return "";
  } catch {
    return "";
  } finally {
    await pool.end().catch(() => {});
  }
}

function pickQuestionFromBody(body, questions) {
  const { questionId, questionOverride } = body ?? {};
  const overrideQuestion =
    questionOverride &&
    typeof questionOverride === "object" &&
    typeof questionOverride.question === "string" &&
    Array.isArray(questionOverride.options) &&
    typeof questionOverride.answer === "string"
      ? questionOverride
      : null;

  return (
    overrideQuestion ||
    questions.find((q) => Number(q.id) === Number(questionId)) ||
    null
  );
}

/**
 * Nytt: defensiv sjekk for 2–3 ords navn — brukes til vague-oppslag og til split-reserve
 * (kun når fraseoppslag er tomt og tema fortsatt matcher denne profilen).
 * Krever stor forbokstav per ord, kun bokstaver (Unicode), rimelig ordlengde.
 */
function themeLooksLikeMultiWordName(theme) {
  const raw = String(theme ?? "").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) {
    return false;
  }
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.length < 2 || w.length > 14) {
      return false;
    }
    if (!/^[\p{L}]+$/u.test(w)) {
      return false;
    }
    if (!/^\p{Lu}/u.test(w)) {
      return false;
    }
  }
  return true;
}

/**
 * Korte eller tvetydige tema er mer utsatt for hallusinasjoner.
 * Denne heuristikken er bevisst enkel og heller mot oppslag for korte tema.
 */
function themeNeedsLookupSupport(theme) {
  const raw = String(theme ?? "").trim();
  if (!raw || /\d/.test(raw)) {
    return false;
  }

  const lower = raw.toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const broadMarkers = [
    "historie",
    "geografi",
    "musikk",
    "kunst",
    "film",
    "filmer",
    "sport",
    "vitenskap",
    "teknologi",
    "litteratur",
    "språk",
    "dyr",
    "land",
    "byer",
    "matematikk",
    "fysikk",
    "kjemi",
    "biologi",
    "religion",
    "mytologi",
    "politikk",
  ];
  if (broadMarkers.some((marker) => lower.includes(marker))) {
    return false;
  }

  if (words.length === 1) {
    return raw.length <= 24;
  }

  if (words.length === 2) {
    return words.every((word) => word.length <= 14) && !/[,:;()/]/.test(raw);
  }

  /** Nytt: tre ord kun når det ser ut som flerords navn (unngår brede fraser). */
  if (words.length === 3) {
    return (
      words.every((word) => word.length <= 14) &&
      !/[,:;()/]/.test(raw) &&
      themeLooksLikeMultiWordName(raw)
    );
  }

  return false;
}

function normalizeLookupTitle(value) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function trimLookupText(text, maxLength = 240) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (raw.length <= maxLength) {
    return raw;
  }
  const clipped = raw.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > 80 ? clipped.slice(0, lastSpace) : clipped).trim()}...`;
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "gruble-quiz-api/0.1",
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Lookup failed with status ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikipediaTitles(theme) {
  const url = new URL("https://nb.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: theme,
    /** Litt flere treff slik at vi kan plukke navneartikkel + noen biografier uten nytt søk */
    srlimit: "15",
    utf8: "1",
    format: "json",
  }).toString();

  const payload = await fetchJsonWithTimeout(url);
  const rows = Array.isArray(payload?.query?.search) ? payload.query.search : [];
  return rows
    .map((row) => String(row?.title ?? "").trim())
    .filter(Boolean);
}

function pickLookupTitles(theme, titles) {
  const themeNorm = normalizeLookupTitle(theme);
  const picked = [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = titles[i];
    const titleNorm = normalizeLookupTitle(title);
    if (
      titleNorm === themeNorm ||
      titleNorm.startsWith(`${themeNorm} (`)
    ) {
      picked.push(title);
    }
  }
  return [...new Set(picked)].slice(0, 3);
}

/**
 * Ett enkelt ord som ser ut som fornavn → kan forsøke biografitreff fra samme søkeliste.
 * Bevisst snever: unngår å gjette "person" for Mercury, Rose (ting/plante) osv.
 */
function themeLooksLikeSingleFirstName(theme) {
  const raw = String(theme ?? "").trim();
  if (!raw) {
    return false;
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length !== 1 || raw.length > 22) {
    return false;
  }
  return /^[\p{L}]+$/u.test(raw);
}

/** Enkeltord som ofte er ting/planeter/planter — ikke forsøk biografioppslag for disse. */
function themeAllowsPersonArticleLookup(theme) {
  if (!themeLooksLikeSingleFirstName(theme)) {
    return false;
  }
  const block = new Set([
    "mercury",
    "mars",
    "venus",
    "jupiter",
    "saturn",
    "uranus",
    "neptune",
    "pluto",
    "rose",
    "lily",
    "iris",
    "ruby",
    "jade",
  ]);
  return !block.has(String(theme).trim().toLowerCase());
}

/**
 * Plukker mulige biografier: "Fornavn Etternavn" fra søkeresultat, ikke navneartikkel/disambig.
 */
function pickPersonTitlesFromSearch(theme, titles) {
  const raw = String(theme ?? "").trim();
  const themeNorm = normalizeLookupTitle(raw);
  if (!themeNorm || !Array.isArray(titles)) {
    return [];
  }

  const parenNoise =
    /\(\s*(navn|album|film|filmer|sang|singel|bok|bøker|serie|tv|spill|lag|klubb|sted|by|kommune|fylke|land|planet|stjerne|dyr|plante)\s*\)/i;

  const picked = [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = titles[i];
    const titleNorm = normalizeLookupTitle(title);
    if (titleNorm === themeNorm || titleNorm.startsWith(`${themeNorm} (`)) {
      continue;
    }
    if (!titleNorm.startsWith(`${themeNorm} `)) {
      continue;
    }
    if (parenNoise.test(title)) {
      continue;
    }
    const wordsInTitle = title.trim().split(/\s+/).filter(Boolean);
    if (wordsInTitle.length < 2) {
      continue;
    }
    if (normalizeLookupTitle(wordsInTitle[0]) !== themeNorm) {
      continue;
    }
    const afterFirst = title.slice(wordsInTitle[0].length).trim();
    if (!afterFirst || afterFirst.startsWith("(")) {
      continue;
    }
    picked.push(title);
    if (picked.length >= 3) {
      break;
    }
  }
  return [...new Set(picked)];
}

/**
 * Biografiintro på bokmål har ofte fødselsår; krever dette for å unngå svake person-treff.
 */
function isUsablePersonBioExtract(extract) {
  if (!isUsableLookupExtract(extract)) {
    return false;
  }
  const t = String(extract);
  if (/\b(født|fødd)\b/i.test(t)) {
    return true;
  }
  if (/\b(18|19|20)\d{2}\b/.test(t)) {
    return true;
  }
  return false;
}

async function fetchWikipediaExtracts(titles) {
  if (!titles.length) {
    return [];
  }

  const url = new URL("https://nb.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    redirects: "1",
    titles: titles.join("|"),
    utf8: "1",
    format: "json",
  }).toString();

  const payload = await fetchJsonWithTimeout(url);
  const pages = Object.values(payload?.query?.pages ?? {});
  return pages
    .map((page) => ({
      title: String(page?.title ?? "").trim(),
      extract: String(page?.extract ?? "").trim(),
    }))
    .filter((page) => page.title && page.extract);
}

function isUsableLookupExtract(extract) {
  const lower = String(extract ?? "").toLowerCase();
  if (!lower || lower.length < 40) {
    return false;
  }
  if (
    lower.includes("kan vise til") ||
    lower.includes("pekerside") ||
    lower.includes("flere betydninger")
  ) {
    return false;
  }
  return true;
}

async function buildWikipediaLookupContext(theme) {
  const titles = await searchWikipediaTitles(theme);
  const nameTitles = pickLookupTitles(theme, titles);
  const personTitles = themeAllowsPersonArticleLookup(theme)
    ? pickPersonTitlesFromSearch(theme, titles)
    : [];

  const fetchTitles = [...new Set([...nameTitles, ...personTitles])];
  if (!fetchTitles.length) {
    return {
      titles: [],
      nameTitles: [],
      personTitles: [],
      hasPersonContext: false,
      context: "",
    };
  }

  const extracts = await fetchWikipediaExtracts(fetchTitles);
  const byTitle = new Map(
    extracts.map((e) => [e.title, e])
  );

  const nameLines = [];
  for (let i = 0; i < nameTitles.length; i += 1) {
    const entry = byTitle.get(nameTitles[i]);
    if (
      entry &&
      isUsableLookupExtract(entry.extract)
    ) {
      nameLines.push(
        `${entry.title}: ${trimLookupText(entry.extract)}`
      );
    }
  }

  const personLines = [];
  for (let i = 0; i < personTitles.length; i += 1) {
    const entry = byTitle.get(personTitles[i]);
    if (
      entry &&
      isUsablePersonBioExtract(entry.extract)
    ) {
      personLines.push(
        `${entry.title}: ${trimLookupText(entry.extract, 280)}`
      );
    }
  }

  const nameBlock =
    nameLines.length > 0 ? `[NAVNEFAKTA]\n${nameLines.join("\n")}` : "";
  const personBlock =
    personLines.length > 0
      ? `[PERSONER FRA OPPSLAG]\n${personLines.join("\n")}`
      : "";

  const context = [nameBlock, personBlock].filter(Boolean).join("\n\n");
  const hasPersonContext = personLines.length > 0;

  return {
    titles: fetchTitles,
    nameTitles,
    personTitles,
    hasPersonContext,
    context,
  };
}

/**
 * Nytt: per-navn Wikipedia-oppslag og samlet kontekst [NAVN 1] / [NAVN 2] / …
 * (samme regler som buildWikipediaLookupContext per del).
 */
async function buildSplitNameLookupContext(parts) {
  const sections = [];
  const titleSet = new Set();
  const nameTitleSet = new Set();
  const personTitleSet = new Set();
  let hasPersonContext = false;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const chunk = await buildWikipediaLookupContext(part);
    if (chunk.hasPersonContext) {
      hasPersonContext = true;
    }
    (chunk.titles || []).forEach((t) => titleSet.add(t));
    (chunk.nameTitles || []).forEach((t) => nameTitleSet.add(t));
    (chunk.personTitles || []).forEach((t) => personTitleSet.add(t));
    const block = String(chunk.context ?? "").trim();
    if (block) {
      sections.push(`[NAVN ${i + 1}]\n${block}`);
    }
  }

  return {
    titles: [...titleSet],
    nameTitles: [...nameTitleSet],
    personTitles: [...personTitleSet],
    hasPersonContext,
    context: sections.join("\n\n"),
    splitParts: parts,
  };
}

/** Nytt: fraseoppslag ga ingen brukbar tekst → split kan vurderes som reserve (kun for navn). */
function isWeakThemeLookupContext(lookup) {
  return !String(lookup?.context ?? "").trim();
}

/** Nytt: felles tom lookup-struktur, også brukt når fagmodus bevisst hopper over oppslag. */
function getEmptyThemeLookupSupport() {
  return {
    vague: false,
    titles: [],
    nameTitles: [],
    personTitles: [],
    hasPersonContext: false,
    context: "",
    split: false,
    splitParts: [],
  };
}

function normalizeLookupTraceText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\d\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLookupTraceTokens(text) {
  return normalizeLookupTraceText(text)
    .split(/\s+/)
    .filter((token) => token && (token.length >= 4 || /^\d{4}$/.test(token)));
}

/**
 * Nytt: streng kontroll for person-tema med lookup.
 * Gjelder både eksplisitte personoppslag og fullnavn som ser ut som en bio i konteksten.
 */
function shouldEnforceStrictPersonLookup(theme, lookup) {
  const context = String(lookup?.context ?? "").trim();
  if (!context) {
    return false;
  }
  if (lookup?.hasPersonContext || (lookup?.personTitles || []).length > 0) {
    return true;
  }

  const words = String(theme ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return false;
  }

  const themeNorm = normalizeLookupTraceText(theme);
  const contextNorm = normalizeLookupTraceText(context);
  return (
    Boolean(themeNorm) &&
    contextNorm.includes(themeNorm) &&
    (/\b(født|fødd)\b/i.test(context) || /\b(18|19|20)\d{2}\b/.test(context))
  );
}

function isAnswerTraceableToLookupContext(answerText, lookupContext) {
  const answerNorm = normalizeLookupTraceText(answerText);
  const contextNorm = normalizeLookupTraceText(lookupContext);
  if (!answerNorm || !contextNorm) {
    return false;
  }
  if (contextNorm.includes(answerNorm)) {
    return true;
  }

  const tokens = getLookupTraceTokens(answerText);
  if (tokens.length >= 2) {
    return tokens.every((token) => contextNorm.includes(token));
  }
  if (tokens.length === 1) {
    const token = tokens[0];
    if (/^\d{4}$/.test(token) || token.length >= 6) {
      return contextNorm.includes(token);
    }
  }

  return false;
}

async function maybeBuildThemeLookupSupport(theme) {
  const emptyLookup = getEmptyThemeLookupSupport();

  const vague = themeNeedsLookupSupport(theme);
  if (!vague) {
    return { ...emptyLookup };
  }

  try {
    /** Alltid hele frasen først; split bare reserve hvis tom kontekst og navn-lignende 2–3 ord. */
    let lookup = await buildWikipediaLookupContext(theme);
    let split = false;
    let splitParts = [];

    if (
      isWeakThemeLookupContext(lookup) &&
      themeLooksLikeMultiWordName(theme)
    ) {
      const parts = String(theme).trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2 && parts.length <= 3) {
        const merged = await buildSplitNameLookupContext(parts);
        if (merged.context.trim()) {
          lookup = merged;
          split = true;
          splitParts = parts;
        }
      }
    }

    return {
      vague: true,
      titles: Array.isArray(lookup?.titles) ? lookup.titles : [],
      nameTitles: Array.isArray(lookup?.nameTitles) ? lookup.nameTitles : [],
      personTitles: Array.isArray(lookup?.personTitles)
        ? lookup.personTitles
        : [],
      hasPersonContext: Boolean(lookup?.hasPersonContext),
      context: typeof lookup?.context === "string" ? lookup.context : "",
      split,
      splitParts,
    };
  } catch (err) {
    console.warn("Wikipedia lookup failed:", err.message);
    return {
      vague: true,
      titles: [],
      nameTitles: [],
      personTitles: [],
      hasPersonContext: false,
      context: "",
      split: false,
      splitParts: [],
    };
  }
}

/**
 * Bygger brukerprompt til quizgenerering.
 * @param {boolean} subjectMode Nytt: når true, tolkes temaet som skolefag (eksplisitt brukervalg).
 * @param {{ needOnly: number, existingQuestions: object[] }|null} topUp når flere modellkall trengs for å nå 5 spørsmål
 * @param {string} [difficulty] easy | normal | hard (easy hvis utelatt)
 * @param {'standard'|'subtheme'|'broad'} [fallbackMode] ekstra veiledning når genereringen henger (ikke svekker backend-validering)
 */
function buildQuizUserPrompt(
  theme,
  questionCount,
  lookup,
  subjectMode = false,
  topUp = null,
  difficulty = "easy",
  fallbackMode = "standard"
) {
  const themeJson = JSON.stringify(theme);
  const need =
    topUp && typeof topUp.needOnly === "number"
      ? topUp.needOnly
      : questionCount;

  let prompt;
  if (
    topUp &&
    Array.isArray(topUp.existingQuestions) &&
    topUp.existingQuestions.length > 0
  ) {
    const lines = topUp.existingQuestions
      .map(
        (q, i) =>
          `${i + 1}. Spørsmål: ${JSON.stringify(String(q?.question ?? ""))} — fasit: ${JSON.stringify(String(q?.answer ?? ""))} — fact_key: ${JSON.stringify(String(q?.fact_key ?? ""))}`
      )
      .join("\n");
    prompt = `Oppfølging: quizen om tema ${themeJson} mangler flere spørsmål.

Allerede godkjente spørsmål (ikke gjenta, ikke kopier samme faktum eller nær identisk formulering):
${lines}

Generer ${need} NYE flervalgsoppgaver. Målet er at listen "questions" i JSON har nøyaktig ${need} elementer. Når disse legges til listen over, skal quizen totalt nå ${questionCount} spørsmål.`;
  } else {
    prompt = `Generer ${need} enkle flervalgsoppgaver på norsk om temaet: ${themeJson}.
Målet er at listen "questions" i JSON har nøyaktig ${need} elementer.`;
  }

  const diffNorm = normalizeQuizDifficulty(difficulty);
  const diffHuman =
    diffNorm === "easy" ? "lett" : diffNorm === "hard" ? "vanskelig" : "normal";

  prompt += `

Vanskegrad for denne quizen: ${diffHuman}. Følg VANSKEGRAD-delen i systemmeldingen.

Bruk bare trygg kunnskap eller eksplisitt faktastøtte i denne samtalen — ikke gjettverk eller oppdiktede synonymer. Ved trangt tema: utvid forsiktig til nærliggende undertema i samme fagområde og strev mot nøyaktig ${need} gyldige spørsmål i dette JSON-svaret (ikke finn på fakta for å fylle ut).`;

  if (subjectMode) {
    prompt += `

Temaet skal her forstås som et skolefag eller undervisningsemne. Hvis temaet er "norsk", betyr det skolefaget norsk. Hvis temaet er "engelsk", betyr det skolefaget engelsk. Hvis temaet er "historie", "samfunnsfag", "matematikk" eller lignende, betyr det faget slik det brukes i skolen.`;
  }

  prompt += `

Spørsmålene må være selvstendige.
Brukeren skal kunne forstå og besvare hvert spørsmål uten artikkel, ingress, tekstutdrag eller annen skjult kontekst.
Språket skal være korrekt, naturlig norsk (grammatikk og bøyning); les hvert spørsmål som en norsklærer før du godkjenner det.
Ikke inkluder felt som "text", "context", "passage" eller lignende.

Hvert element i "questions" skal ha:
- id: heltall fra 1 og oppover
- question: spørsmålstekst
- options: nøyaktig 4 strenger (ett riktig svar, tre plausibel feil)
- answer: eksakt lik én av strengene i options
- fact_key: obligatorisk intern nøkkel for kjernefaktumet, slik at samme underliggende faktum får samme nøkkel selv om du formulerer spørsmålet annerledes

Feltet "theme" i JSON-svaret skal være eksakt: ${themeJson}`;

  if (lookup?.context) {
    prompt += `

Temaet virker kort eller tvetydig. Bruk kun denne faktastøtten fra Wikipedia/MediaWiki hvis du trenger å konkretisere temaet:
${lookup.context}

Struktur:
- [NAVNEFAKTA]: trygg bakgrunn om navnet/ordet.
- [PERSONER FRA OPPSLAG]: biografiske artikler som faktisk ble funnet i oppslaget.

Du kan variere spørsmål mellom navnefakta (fra NAVNEFAKTA) og konkrete enkeltfakta om personer listet under PERSONER, men:
- bruk KUN personer som er eksplisitt listet under [PERSONER FRA OPPSLAG]
- lag KUN personspørsmål der én klar, dokumenterbar fasit står direkte i utdragene (for eksempel eksplisitt årstall, tydelig yrke/rolle som er entydig, eller annet som ikke kan tolkes flere veier)
- ikke finn på biografiske detaljer, verk, hendelser eller kampanjer som ikke står i utdragene
- ikke spør om "i hvilket land er navnet vanlig" eller lignende der flere svar kan være like riktige
- hvis [PERSONER FRA OPPSLAG] mangler eller er for tynt til entydige spørsmål, hold deg til [NAVNEFAKTA] eller generelle trygge fakta

Ikke finn på konkrete personer, verk, hendelser eller kampanjer utover det som følger tydelig av faktastøtten.
Hvis faktastøtten ikke støtter en spesifikk retning, hold spørsmålene generelle, forsiktige og dokumenterbare.${
    lookup?.split
      ? `

Nytt (navn splittet som reserve etter svakt fraseoppslag, oppslag per del): Faktastøtten er gruppert som [NAVN 1], [NAVN 2] osv. Hver gruppe gjelder kun det navnet — ikke bland fakta mellom grupper.
Lag spørsmål som varierer mellom navnedelene når flere grupper har stoff; bruk fortsatt bare innhold som står eksplisitt i den aktuelle gruppen.
Unngå formuleringer som «vanlig», «populær», «kjent for» og nære varianter.`
      : ""
  }`;

    if (shouldEnforceStrictPersonLookup(theme, lookup)) {
      prompt += `

HARD REGEL FOR PERSONTEMA:
- All informasjon skal komme direkte fra lookup-konteksten over.
- Ikke bruk generell kunnskap, selv om du mener du vet noe om personen.
- Ikke bruk informasjon fra andre personer med samme eller lignende navn.
- Hvis en opplysning ikke står tydelig i konteksten, skal du ikke bruke den.
- Hver fasit må kunne spores direkte til tekst i lookup-konteksten. Hvis fasiten ikke kan gjenfinnes i konteksten, er spørsmålet ugyldig og må forkastes.`;
    }
  } else if (lookup?.vague) {
    prompt += `

Temaet virker kort eller tvetydig, og oppslag ga ikke trygg nok faktastøtte.
Ikke lag spørsmål om konkrete personer, hendelser, verk, TV-serier eller kampanjer.
Bruk bare generelle og dokumenterbare fakta som kan forsvares direkte ut fra temaet.
Ikke finn opp alternative navn, folkelige betegnelser, synonymer eller «vanlige navn» som du ikke kan dokumentere.`;
  }

  /* Nytt: fagmodus — kun når brukeren eksplisitt ber om det (subjectMode i API). */
  if (subjectMode) {
    prompt += `

FAGMODUS (aktiv — eksplisitt valgt av brukeren):
Temaet skal tolkes som et skolefag eller undervisningsemne, ikke som ordets etymologi, ikke som generell «trivia» om Norge eller begrepet i seg selv med mindre det er naturlig innen faget.
Lag oppgaver som er typiske i skolen innen dette faget, for eksempel:
- norsk: grammatikk, ordklasser, rettskriving, teksttyper, litteratur og språklige begreper som brukes i faget
- matematikk / matte: prosent, brøk, desimaler, regnerekkefølge, enkle likninger, geometriske begreper
- samfunnsfag: demokrati, Stortinget, grunnleggende samfunnsbegreper, kart og geografi, historie der det hører naturlig til faget
- engelsk: ordforråd, grammatikk og språklig stoff på engelsk som i språkfaget
- naturfag / historie: faglige begreper og stoff som i læreplanen for faget

Dette endrer ikke kvalitetskravene: hvert spørsmål skal fortsatt ha nøyaktig én klar og dokumenterbar fasit, være fullt selvstendig (ingen skjult kontekst), ikke være avhengig av å se svaralternativene, og ikke være vage eller åpent tolkbare.

Når fagmodus er aktiv, skal spørsmålene fortsatt være ekte quizspørsmål med ett entydig, dokumenterbart svar. Ikke lag åpne skolefaglige spørsmål med flere mulige riktige svar.

Unngå spesielt formuleringer og spørsmålsformer som ofte blir åpne eller diskusjonspregede:
- "Hva er en viktig del av ..."
- "Nevn noe som ..."
- "Hva kjennetegner ..."
- "Hva er et eksempel på ..." når gruppen ikke er klart lukket
- "Hvorfor ..."
- "Hvordan ..."

Hvis du er i tvil om spørsmålet kan ha flere riktige fritekstsvar, skal du forkaste det og lage et mer presist spørsmål med én klar fasit.`;
  }

  if (fallbackMode === "subtheme") {
    prompt += `

FALLBACK — UNDERTEMA (kvalitet som før):
Tidligere forsøk har feilet kvalitetssjekker. Du skal fortsatt ikke finne på fakta, synonymer eller usikre detaljer.
Utvid til tydelig beslektede undertema i samme fagområde som ${themeJson}, for eksempel: meitemark → leddormer, jord, nedbryting; norsk → grammatikk, ordklasser, rettskriving; samfunnsfag → demokrati, Storting, grunnleggende begreper — tilpass til det faktiske temaet.
Feltet "theme" i JSON-svaret skal fortsatt være eksakt: ${themeJson}.`;
  } else if (fallbackMode === "broad") {
    prompt += `

FALLBACK — BRED TRYGG KJERNE (kvalitet som før):
Det er fortsatt vanskelig å få godkjente spørsmål. Lag spørsmål med svært trygge, brede og lærebok-aktige fakta innen samme kunnskapsfelt som temaet naturlig hører til — bare det du er sikker på og kan dokumentere.
Ikke finn på detaljer, alternative navn eller «vanlige» påstander du ikke kan forsvare.
Feltet "theme" i JSON-svaret skal fortsatt være eksakt: ${themeJson}.`;
  }

  prompt += `

VARIASJONSKRAV (viktig):
- Når du lager flere spørsmål, spre dem over ulike deler av temaet i stedet for å kverne på én liten detalj
- Ikke lag to spørsmål om samme kjernefaktum, selv om de er formulert forskjellig
- Ikke lag «samme spørsmål i ny drakt» med annet årstall, annen vinkling eller annen ordlyd
- Unngå overbrukte og smale kontrollspørsmål hvis de ikke er særlig relevante for temaet
- Foretrekk bredde: ulike personer, steder, perioder, fenomener, verk, begreper eller kategorier der temaet tillater det
- fact_key skal brukes aktivt til dette: hvis to spørsmål ville hatt samme fact_key eller nesten samme fact_key, skal bare ett av dem få være med

Returner KUN JSON med denne formen (ingen markdown). "questions" skal sikte mot nøyaktig ${need} elementer:
{"theme":...,"questions":[...]}`;

  return prompt;
}

/**
 * @typedef {{ pool: import("pg").Pool, mode?: "daily"|"custom" }} QuizMemoryOptions
 */

/**
 * Genererer quiz via OpenAI. memoryOptions er valgfritt: spørsmålsminne / duplikatfilter mot Postgres.
 */
async function generateQuizWithOpenAI(
  openai,
  model,
  theme,
  questionCount,
  memoryOptions = null,
  subjectMode = false,
  difficulty = "easy",
  generationOptions = null
) {
  const startedAt = Date.now();
  const diffNorm = normalizeQuizDifficulty(difficulty);
  const skipDecorativeImages =
    generationOptions &&
    typeof generationOptions === "object" &&
    generationOptions.skipDecorativeImages === true;
  console.log(`[quiz mode] subjectMode=${subjectMode ? "true" : "false"}`);
  console.log(`[quiz mode] difficulty=${diffNorm}`);
  /* Nytt: i fagmodus hopper vi over lookup for å unngå at tvetydige ord som "norsk"
     blir låst til oppslagsbetydning (ord/språk) i stedet for skolefag. */
  const lookup = subjectMode
    ? getEmptyThemeLookupSupport()
    : await maybeBuildThemeLookupSupport(theme);
  console.log(
    `[quiz mode] lookupMode=${subjectMode ? "skipped_for_subject_mode" : "normal"}`
  );
  console.log(`[quiz lookup] theme=${JSON.stringify(theme)}`);
  console.log(`[quiz lookup] vague=${lookup.vague ? "true" : "false"}`);
  if (lookup.vague) {
    console.log(`[quiz lookup] titles=${JSON.stringify(lookup.titles || [])}`);
    console.log(
      `[quiz lookup] nameTitles=${JSON.stringify(lookup.nameTitles || [])}`
    );
    console.log(
      `[quiz lookup] personTitles=${JSON.stringify(lookup.personTitles || [])}`
    );
    console.log(
      `[quiz lookup] hasContext=${lookup.context ? "true" : "false"}`
    );
    console.log(
      `[quiz lookup] hasPersonContext=${lookup.hasPersonContext ? "true" : "false"}`
    );
    console.log(`[quiz lookup] split=${lookup.split ? "true" : "false"}`);
    console.log(
      `[quiz lookup] parts=${JSON.stringify(lookup.splitParts || [])}`
    );
  }
  console.log(
    `[quiz lookup] promptHasLookupContext=${lookup.context ? "true" : "false"}`
  );

  let lastValidationError = null;
  let resolvedTheme = String(theme).trim();
  /** @type {object[]} */
  let accumulated = [];

  const memMode =
    memoryOptions && memoryOptions.mode === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;
  const memoryPool =
    memoryOptions &&
    memoryOptions.pool &&
    typeof memoryOptions.pool.query === "function"
      ? memoryOptions.pool
      : null;

  /** Etter N mislykkede forsøk uten nytt godkjent spørsmål: sterkere undertema-/bredde-veiledning i brukerprompt (validering uendret). */
  const STALL_BEFORE_SUBTHEME_FALLBACK = 5;
  const STALL_BEFORE_BROAD_FALLBACK = 10;
  const maxTotalModelCalls = 22;

  let stallCount = 0;

  for (let callIdx = 0; callIdx < maxTotalModelCalls; callIdx += 1) {
    if (accumulated.length >= questionCount) {
      break;
    }

    const need = questionCount - accumulated.length;
    const fallbackMode =
      stallCount >= STALL_BEFORE_BROAD_FALLBACK
        ? "broad"
        : stallCount >= STALL_BEFORE_SUBTHEME_FALLBACK
          ? "subtheme"
          : "standard";
    if (fallbackMode !== "standard") {
      console.log(
        `[quiz generate] fallbackMode=${fallbackMode} stallCount=${stallCount} call=${callIdx + 1}`
      );
    }

    const userPrompt = buildQuizUserPrompt(
      theme,
      questionCount,
      lookup,
      subjectMode,
      accumulated.length > 0
        ? { needOnly: need, existingQuestions: accumulated }
        : null,
      diffNorm,
      fallbackMode
    );

    const parsed = await parseJsonChatCompletion(
      openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: buildGenerateQuizSystemContent(diffNorm),
          },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      })
    );

    const validationError = validateGeneratedQuiz(
      parsed,
      theme,
      1,
      need,
      lookup,
      subjectMode,
      diffNorm
    );
    if (validationError) {
      lastValidationError = validationError;
      stallCount += 1;
      console.log(
        `[quiz generate] call=${callIdx + 1} need=${need} validation=${JSON.stringify(validationError)}`
      );
      continue;
    }

    if (typeof parsed.theme === "string" && parsed.theme.trim()) {
      resolvedTheme = parsed.theme.trim();
    }

    parsed.questions = parsed.questions.map((q, idx) => ({
      ...q,
      id: idx + 1,
    }));

    const shuffled = parsed.questions.map(shuffleQuestionOptions);
    const memResult = await filterQuizQuestionsAgainstMemory(
      memoryPool,
      shuffled,
      theme,
      memMode,
      accumulated
    );
    const batch = memResult.questions;

    if (batch.length === 0) {
      lastValidationError =
        "all questions rejected as duplicates (quiz memory)";
      stallCount += 1;
      console.log(
        `[quiz generate] call=${callIdx + 1} need=${need} memoryRejected=all`
      );
      continue;
    }

    stallCount = 0;

    if (memResult.rejected > 0) {
      console.log(
        `[quiz generate] call=${callIdx + 1} need=${need} memoryAccepted=${batch.length} memoryRejected=${memResult.rejected}`
      );
    }

    accumulated = [...accumulated, ...batch];
    accumulated = accumulated.slice(0, questionCount);
    accumulated = accumulated.map((q, idx) => ({
      ...q,
      id: idx + 1,
    }));

    if (accumulated.length === questionCount) {
      const fullPayload = {
        theme: resolvedTheme,
        questions: accumulated,
      };
      const finalErr = validateGeneratedQuiz(
        fullPayload,
        theme,
        questionCount,
        questionCount,
        lookup,
        subjectMode,
        diffNorm
      );
      if (finalErr) {
        lastValidationError = finalErr;
        stallCount += 1;
        console.log(
          `[quiz generate] fullQuizValidation failed=${JSON.stringify(finalErr)} — resetting accumulated`
        );
        accumulated = [];
        continue;
      }

      let finalQuestions = accumulated;
      let sharedImage = null;
      if (!skipDecorativeImages) {
        try {
          const decorated = await attachDecorativeQuizImages(
            theme,
            lookup,
            accumulated
          );
          finalQuestions = decorated.questions;
          sharedImage = decorated.sharedImage;
        } catch (imgErr) {
          console.warn(
            "[quiz image] attach failed:",
            imgErr && typeof imgErr.message === "string"
              ? imgErr.message
              : String(imgErr)
          );
        }
      }

      console.log(
        `[quiz timing] theme=${JSON.stringify(theme)} questions=${questionCount} skipDecorativeImages=${skipDecorativeImages ? "true" : "false"} duration_ms=${Date.now() - startedAt}`
      );
      return {
        theme: resolvedTheme,
        questions: finalQuestions,
        sharedImage,
      };
    }
  }

  console.log(
    `[quiz timing] theme=${JSON.stringify(theme)} questions=${questionCount} failed duration_ms=${Date.now() - startedAt}`
  );
  throw new Error(
    `Could not produce ${questionCount} valid unique questions: ${lastValidationError || "unknown error"}`
  );
}

async function generateVisualTenQuestionBatch(
  openai,
  model,
  slots,
  priorAcceptedQuestions,
  memoryOptions = null,
  difficulty = "easy"
) {
  const diffNorm = normalizeQuizDifficulty(difficulty);
  const { mode: memMode, pool: memoryPool } = getQuizMemoryRuntime(memoryOptions);
  const lookup = getEmptyThemeLookupSupport();
  let accepted = [];
  let pendingSlots = [...slots];
  let lastError = null;
  const maxAttempts = 10;
  const batchStartedAt = Date.now();

  for (let attempt = 0; attempt < maxAttempts && pendingSlots.length > 0; attempt += 1) {
    const prompt = buildVisualTenBatchUserPrompt(
      pendingSlots,
      [...(priorAcceptedQuestions || []), ...accepted],
      diffNorm
    );
    let parsed;
    try {
      parsed = await parseJsonChatCompletion(
        openai.chat.completions.create({
          model,
          messages: [
            {
              role: "system",
              content: buildGenerateQuizSystemContent(diffNorm),
            },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        })
      );
    } catch (err) {
      lastError =
        err && typeof err.message === "string"
          ? err.message
          : "visual-10 batch OpenAI call failed";
      continue;
    }

    const batchValidationError = validateGeneratedQuiz(
      parsed,
      VISUAL_TEN_DISPLAY_THEME,
      pendingSlots.length,
      pendingSlots.length,
      lookup,
      false,
      diffNorm,
      { skipLookupSensitive: true }
    );
    if (batchValidationError) {
      lastError = batchValidationError;
      console.log(
        `[visual-10 batch] attempt=${attempt + 1} validation=${JSON.stringify(batchValidationError)}`
      );
      continue;
    }

    const sourceThemeError = getVisualTenBatchValidationError(parsed, pendingSlots);
    if (sourceThemeError) {
      lastError = sourceThemeError;
      console.log(
        `[visual-10 batch] attempt=${attempt + 1} sourceThemeValidation=${JSON.stringify(sourceThemeError)}`
      );
      continue;
    }

    const normalizedQuestions = parsed.questions.map((q, idx) => ({
      ...q,
      id: idx + 1,
      source_theme: String(q?.source_theme ?? "").trim(),
    }));
    const shuffled = normalizedQuestions.map(shuffleQuestionOptions);
    const memResult = await filterQuizQuestionsAgainstMemory(
      memoryPool,
      shuffled,
      VISUAL_TEN_DISPLAY_THEME,
      memMode,
      [...(priorAcceptedQuestions || []), ...accepted]
    );
    if (memResult.questions.length === 0) {
      lastError = "all visual-10 batch questions rejected as duplicates";
      console.log(
        `[visual-10 batch] attempt=${attempt + 1} memoryRejected=all pending=${pendingSlots.length}`
      );
      continue;
    }

    accepted = [...accepted, ...memResult.questions];
    const acceptedThemes = new Set(
      accepted.map((q) => String(q?.source_theme ?? "").trim()).filter(Boolean)
    );
    pendingSlots = pendingSlots.filter((slot) => !acceptedThemes.has(String(slot.theme)));
    if (memResult.rejected > 0) {
      console.log(
        `[visual-10 batch] attempt=${attempt + 1} accepted=${memResult.questions.length} rejected=${memResult.rejected} remaining=${pendingSlots.length}`
      );
    }
  }

  if (accepted.length !== slots.length) {
    throw new Error(
      `visual-10 batch failed: ${lastError || "could not fill all undertema slots"}`
    );
  }

  console.log(
    `[visual-10 batch timing] slots=${slots.length} duration_ms=${Date.now() - batchStartedAt}`
  );
  return accepted;
}

/**
 * Spørsmål 10: kun knyttet til illustrasjonsbildet (ikke til quizens øvrige undertemaer).
 */
async function generateVisualClimaxQuestion(
  openai,
  model,
  displayTheme,
  sharedImage,
  diffNorm
) {
  const themeStr = String(displayTheme ?? "").trim();
  const themeJson = JSON.stringify(themeStr);
  const title = String(sharedImage?.title ?? "").trim();
  const credit = String(sharedImage?.credit ?? "").trim();
  const url = String(sharedImage?.url ?? "").trim();

  const userPrompt = `Du genererer spørsmål nr. 10 i en allmenn bilde-quiz.

Spørsmål 1–9 i samme quiz er vanlig flervalgsquiz med varierende undertemaer (allmennkunnskap). De er ikke knyttet til illustrasjonsbildet.

Spørsmål 10 er det eneste som skal knyttes til bildet: bruk motivet som premiss — spør om noe som er tydelig synlig, eller som er trygt og dokumenterbart knyttet til motivet ut fra bildets tittel og alminnelig kunnskap (sted, byggverk, person, naturtype, gjenstand osv.). Ikke finn på detaljer du ikke kan forsvare; ikke spør om pikselnivå du ikke kan slå fast.

Bildemetadata fra kilde:
- tittel: ${JSON.stringify(title)}
- kreditering: ${JSON.stringify(credit)}
- bilde-URL (referanse for deg; ikke gjengi hele URL i spørsmålsteksten): ${JSON.stringify(url)}

Generer nøyaktig 1 flervalgsoppgave på norsk i samme JSON-format som vanlige quizer i dette systemet.

Krav:
- Feltet "theme" skal være eksakt: ${themeJson}
- "questions" skal ha nøyaktig 1 element med id, question, options (fire strenger), answer, fact_key
- Ett entydig riktig svar; samme kvalitetskrav som for øvrige spørsmål.

Returner KUN JSON med "theme" og "questions".`;

  const climaxLookup = getEmptyThemeLookupSupport();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parsed = await parseJsonChatCompletion(
      openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: buildGenerateQuizSystemContent(diffNorm),
          },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      })
    );
    const err = validateGeneratedQuiz(
      parsed,
      themeStr,
      1,
      1,
      climaxLookup,
      false,
      diffNorm,
      { skipLookupSensitive: true }
    );
    if (err) {
      console.log(
        `[visual-10 climax] attempt=${attempt + 1} validation=${JSON.stringify(err)}`
      );
      continue;
    }
    const q = parsed.questions?.[0];
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) {
      continue;
    }
    return shuffleQuestionOptions({
      ...q,
      id: 10,
      imageQuestion: true,
    });
  }
  throw new Error("Could not generate valid visual climax question");
}

/**
 * Bilde-10-variant: ni spørsmål i små batcher med undertema-kjøling, illustrasjon valgt separat,
 * og spørsmål 10 kun om bildet.
 */
async function buildVisualTenQuizAttempt(
  openai,
  model,
  memoryOptions = null,
  difficulty = "easy"
) {
  const attemptStartedAt = Date.now();
  const diffNorm = normalizeQuizDifficulty(difficulty);
  const displayTheme = VISUAL_TEN_DISPLAY_THEME;
  const { mode: memMode, pool: memoryPool } = getQuizMemoryRuntime(memoryOptions);
  const recentThemeCounts = await fetchRecentVisualTenThemeCounts(memoryPool);
  console.log(
    `[visual-10] recentThemeCounts=${JSON.stringify(recentThemeCounts)}`
  );
  const nineSlots = pickWeightedVisualTenThemePresetsMany(9, recentThemeCounts);
  const batchPlans = chunkArray(nineSlots, VISUAL_TEN_BATCH_SIZE);
  const nineClean = [];

  for (let batchIdx = 0; batchIdx < batchPlans.length; batchIdx += 1) {
    const slots = batchPlans[batchIdx];
    console.log(
      `[visual-10] batch ${batchIdx + 1}/${batchPlans.length} slots=${JSON.stringify(slots.map((slot) => ({
        theme: slot.theme,
        subjectMode: slot.subjectMode === true,
      })))}`
    );
    const batchQuestions = await generateVisualTenQuestionBatch(
      openai,
      model,
      slots,
      nineClean,
      memoryOptions,
      difficulty
    );
    nineClean.push(...batchQuestions);
  }

  const imageLookupCache = new Map();
  let shared = null;
  for (let a = 0; a < VISUAL_TEN_IMAGE_PICK_TRIES && !shared; a += 1) {
    const excludedThemes = new Set(nineSlots.map((slot) => slot.theme));
    const imgPreset = pickWeightedVisualTenThemePresetWithCooling(
      recentThemeCounts,
      excludedThemes
    );
    let imgLookup = imageLookupCache.get(imgPreset.theme);
    if (!imgLookup) {
      imgLookup = imgPreset.subjectMode
        ? getEmptyThemeLookupSupport()
        : await maybeBuildThemeLookupSupport(imgPreset.theme);
      imageLookupCache.set(imgPreset.theme, imgLookup);
    }
    shared = await pickSharedDecorativeImage(imgPreset.theme, imgLookup, "");
    console.log(
      `[visual-10 image] attempt=${a + 1}/${VISUAL_TEN_IMAGE_PICK_TRIES} theme=${JSON.stringify(imgPreset.theme)} found=${shared ? "true" : "false"}`
    );
  }
  if (!shared || typeof shared.url !== "string" || !shared.url.trim()) {
    throw new Error(
      "Could not resolve a shared image for visual-10 quiz (try again)"
    );
  }

  let q10 = null;
  for (let q10Attempt = 0; q10Attempt < 4 && !q10; q10Attempt += 1) {
    const candidate = await generateVisualClimaxQuestion(
      openai,
      model,
      displayTheme,
      shared,
      diffNorm
    );
    const deduped = await filterQuizQuestionsAgainstMemory(
      memoryPool,
      [candidate],
      displayTheme,
      memMode,
      nineClean
    );
    if (deduped.questions.length > 0) {
      q10 = deduped.questions[0];
      break;
    }
    console.log(
      `[visual-10 climax] duplicateRejected attempt=${q10Attempt + 1}/4`
    );
  }
  if (!q10) {
    throw new Error("Could not generate unique visual climax question");
  }

  const nineRenumbered = nineClean.map((q, idx) => ({
    ...q,
    id: idx + 1,
  }));
  const allQuestions = [...nineRenumbered, q10];

  const fullPayload = {
    theme: displayTheme,
    questions: allQuestions,
  };
  const packageLookup = getEmptyThemeLookupSupport();
  const finalErr = validateGeneratedQuiz(
    fullPayload,
    displayTheme,
    10,
    10,
    packageLookup,
    false,
    diffNorm,
    { skipLookupSensitive: true }
  );
  if (finalErr) {
    throw new Error(
      `visual-10 full quiz validation failed: ${JSON.stringify(finalErr)}`
    );
  }

  console.log(
    `[visual-10 timing] total_duration_ms=${Date.now() - attemptStartedAt}`
  );
  return {
    theme: fullPayload.theme,
    questions: allQuestions,
    sharedImage: shared,
    variant: VISUAL_TEN_QUIZ_VARIANT,
  };
}

async function generateVisualTenQuizWithOpenAI(
  openai,
  model,
  memoryOptions = null,
  difficulty = "easy"
) {
  const startedAt = Date.now();
  let lastErr = null;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (attempt > 0) {
        console.log(
          `[visual-10] retrying full generation attempt=${attempt + 1}/${maxAttempts}`
        );
      }
      const quiz = await buildVisualTenQuizAttempt(
        openai,
        model,
        memoryOptions,
        difficulty
      );
      console.log(
        `[visual-10 total timing] attempts=${attempt + 1} duration_ms=${Date.now() - startedAt}`
      );
      return quiz;
    } catch (err) {
      lastErr = err;
      console.log(
        `[visual-10] attempt=${attempt + 1}/${maxAttempts} failed=${
          err && typeof err.message === "string" ? err.message : String(err)
        }`
      );
    }
  }

  console.log(
    `[visual-10 total timing] failed duration_ms=${Date.now() - startedAt}`
  );
  throw lastErr || new Error("Could not generate visual-10 quiz");
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
      `SELECT * FROM quizzes
       WHERE (questions::jsonb->>'variant' IS DISTINCT FROM $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [VISUAL_TEN_QUIZ_VARIANT]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "No quiz found" });
      return;
    }

    const quiz = result.rows[0];
    const { sharedImage, questions, variant } = getQuizQuestionsPayloadFromRow(quiz);

    const questionsForClient = questions.map((q) => stripQuestionForPublicClient(q));

    res.status(200).json({
      theme: quiz.theme,
      difficulty: normalizeQuizDifficulty(quiz.difficulty),
      variant: variant || "standard",
      sharedImage: sharedImage || null,
      questions: questionsForClient,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

app.get("/api/quiz/visual-today", async (_req, res) => {
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
      `SELECT * FROM quizzes
       WHERE questions::jsonb->>'variant' = $1
       ORDER BY created_at DESC
       LIMIT 25`,
      [VISUAL_TEN_QUIZ_VARIANT]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "No visual-10 quiz found" });
      return;
    }

    let quiz = null;
    let sharedImage = null;
    let questions = [];
    let variant = VISUAL_TEN_QUIZ_VARIANT;
    for (const row of result.rows) {
      const parsed = getQuizQuestionsPayloadFromRow(row);
      if (!isValidVisualTenQuizPayload(parsed)) {
        continue;
      }
      quiz = row;
      sharedImage = parsed.sharedImage;
      questions = parsed.questions;
      variant = parsed.variant || VISUAL_TEN_QUIZ_VARIANT;
      break;
    }

    if (!quiz) {
      res.status(404).json({ error: "No valid visual-10 quiz found" });
      return;
    }

    const questionsForClient = questions.map((q) => stripQuestionForPublicClient(q));

    res.status(200).json({
      theme: quiz.theme,
      difficulty: normalizeQuizDifficulty(quiz.difficulty),
      variant: variant || VISUAL_TEN_QUIZ_VARIANT,
      sharedImage: sharedImage || null,
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

  const { questionId, answer, mode, attemptNumber, questionOverride } = req.body ?? {};
  const quizVariantRaw =
    typeof req.body?.quizVariant === "string" ? req.body.quizVariant.trim() : "";
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
    const result =
      quizVariantRaw === VISUAL_TEN_QUIZ_VARIANT
        ? await pool.query(
            `SELECT * FROM quizzes
             WHERE questions::jsonb->>'variant' = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [VISUAL_TEN_QUIZ_VARIANT]
          )
        : await pool.query(
            `SELECT * FROM quizzes
             WHERE (questions::jsonb->>'variant' IS DISTINCT FROM $1)
             ORDER BY created_at DESC
             LIMIT 1`,
            [VISUAL_TEN_QUIZ_VARIANT]
          );

    if (result.rows.length === 0) {
      res.status(200).json({ correct: false, points: 0 });
      return;
    }

    const quiz = result.rows[0];
    const quizDifficulty = normalizeQuizDifficulty(quiz.difficulty);
    const { questions } = getQuizQuestionsPayloadFromRow(quiz);

    const overrideQuestion =
      questionOverride &&
      typeof questionOverride === "object" &&
      typeof questionOverride.question === "string" &&
      Array.isArray(questionOverride.options) &&
      typeof questionOverride.answer === "string"
        ? questionOverride
        : null;

    const question =
      overrideQuestion ||
      questions.find((q) => Number(q.id) === Number(questionId));

    if (!question || question.answer === undefined) {
      res.status(200).json({ correct: false, points: 0 });
      return;
    }

    const answerMode = mode === "mc" ? "mc" : "written";

    if (answerMode === "mc") {
      const questionText = String(question.question ?? "").trim();
      const userAnswerDisplay = String(answer).trim();
      const userAnswerNorm = userAnswerDisplay.toLowerCase();
      const correctAnswerNorm = String(question.answer).trim().toLowerCase();
      const correct = userAnswerNorm === correctAnswerNorm;
      const attempt = Math.min(4, Math.max(1, Number(attemptNumber) || 1));
      let points = 0;
      if (correct) {
        const base = Math.max(0, 4 - attempt);
        points = applyQuizDifficultyToPoints(base, quizDifficulty);
      }

      let feedback = "";
      const apiKeyMc = process.env.OPENAI_API_KEY;
      if (apiKeyMc) {
        try {
          const openaiMc = new OpenAI({ apiKey: apiKeyMc });
          const modelMc = process.env.OPENAI_MODEL || "gpt-4o-mini";
          feedback = await explainMcAnswerWithOpenAI(
            openaiMc,
            modelMc,
            questionText,
            String(question.answer).trim(),
            userAnswerDisplay,
            correct
          );
        } catch (mcExplainErr) {
          console.error("explainMcAnswerWithOpenAI:", mcExplainErr);
        }
      }
      if (!feedback) {
        feedback = correct
          ? "Riktig svar."
          : "Ikke riktig — prøv et annet alternativ.";
      }

      res.status(200).json({ correct, points, feedback });
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
      points: applyQuizDifficultyToPoints(evaluated.points, quizDifficulty),
      feedback: evaluated.feedback,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end().catch(() => {});
  }
});

app.post("/api/quiz/protest", async (req, res) => {
  const body = req.body ?? {};
  const questionId = body.questionId;
  const themeText = typeof body.theme === "string" ? body.theme.trim() : "";
  const questionText =
    typeof body.question === "string" ? body.question.trim() : "";
  const { options } = body;
  const protestType =
    typeof body.protestType === "string" ? body.protestType.trim() : "";
  const userMessage =
    typeof body.userMessage === "string" ? body.userMessage.trim() : "";
  let answerText =
    typeof body.answer === "string" ? body.answer.trim() : "";

  if (questionId === undefined || questionId === null) {
    res.status(400).json({ error: "Missing questionId" });
    return;
  }
  if (!themeText) {
    res.status(400).json({ error: "Missing theme" });
    return;
  }
  if (!questionText) {
    res.status(400).json({ error: "Missing question" });
    return;
  }
  if (
    !Array.isArray(options) ||
    options.length < 2 ||
    !options.every((o) => typeof o === "string" && String(o).trim())
  ) {
    res.status(400).json({ error: "Invalid options" });
    return;
  }
  if (!protestType) {
    res.status(400).json({ error: "Missing protestType" });
    return;
  }
  if (!userMessage) {
    res.status(400).json({ error: "Missing userMessage" });
    return;
  }

  if (!answerText) {
    answerText = await fetchAnswerForProtestFromDb(questionId);
  }
  if (!answerText) {
    res
      .status(400)
      .json({ error: "Missing answer (send answer or ensure quiz has it in DB)" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const userPayload = {
    theme: themeText,
    questionId,
    question: questionText,
    options,
    answer: answerText,
    protestType,
    userMessage,
  };

  let parsed;
  try {
    parsed = await parseJsonChatCompletion(
      openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: EVALUATE_PROTEST_SYSTEM },
          {
            role: "user",
            content: JSON.stringify(userPayload),
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0.25,
      })
    );
  } catch (err) {
    const message =
      err && typeof err.message === "string"
        ? err.message
        : "OpenAI protest evaluation failed";
    res.status(502).json({ error: message });
    return;
  }

  res.status(200).json(normalizeProtestMvpResult(parsed));
});

function getQuestionContextValidationError(questionText) {
  const text = String(questionText ?? "").trim();
  if (!text) {
    return "question text missing";
  }

  if (
    /\b(i|ifølge|ifolge)\s+(teksten|artikkelen|saken|historien|innlegget|beskrivelsen|avsnittet|kilden)\b/i.test(
      text
    ) ||
    /\b(denne teksten|denne artikkelen|denne saken|teksten over|artikkelen over)\b/i.test(
      text
    )
  ) {
    return "must not refer to hidden source text";
  }

  if (
    /^(hva er spesielt med|hvor lenge hadde)\s+/i.test(text) &&
    /\b(den|det|de|denne|dette|disse|han|hun)\b/i.test(text)
  ) {
    return "must introduce the subject directly in the question";
  }

  return null;
}

/**
 * Nytt: defensiv sperre mot spørsmål som bare gir mening når svaralternativene vises.
 */
function getOptionDependentQuestionValidationError(questionText) {
  const text = String(questionText ?? "").trim();
  if (!text) {
    return null;
  }

  if (
    /^(hvilken|hvilket|hvilke)\s+av\s+(disse|folg(?:ende|jande))/i.test(
      text.replace(/ø/g, "o")
    ) ||
    /^hvem\s+av\s+disse\b/i.test(text) ||
    /^hvilket\s+alternativ\b/i.test(text)
  ) {
    return "must not depend on answer options";
  }

  return null;
}

/**
 * Nytt: defensiv sperre mot åpenbart åpne spørsmål som ikke egner seg for entydige fritekstsvar.
 * Bevisst konservativ: stopper bare klassiske undervisningsformuleringer.
 */
function getOpenEndedQuestionValidationError(questionText) {
  const text = String(questionText ?? "").trim();
  if (!text) {
    return null;
  }

  if (/^hvorfor\b/i.test(text) || /^hvordan\b/i.test(text)) {
    return "must not be an open why/how question";
  }

  if (
    /^hva\s+er\s+en\s+viktig\s+del\s+av\b/i.test(text) ||
    /^nevn\s+noe\s+som\b/i.test(text) ||
    /^hva\s+kjennetegner\b/i.test(text)
  ) {
    return "must not be an open-ended school question";
  }

  if (/^hva\s+er\s+et\s+eksempel\s+pa\b/i.test(text.replace(/å/g, "a"))) {
    return "must not ask for an unconstrained example";
  }

  return null;
}

/**
 * Enkle heuristikk-regler for åpenbar uoverensstemmelse mellom den/det og bestemt form (-en / -et).
 * Bevisst snever: bare mønstre med høy treffrate på faktiske feil (f.eks. «den største havdyren»).
 */
function getNorwegianGrammarHeuristicError(questionText) {
  const text = String(questionText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return null;
  }

  const t = text;
  const sup =
    "(?:største|minste|beste|høyeste|lengste|nyeste|eldste|verste|laveste|første|siste)";

  if (/\bden største havdyren\b/i.test(t)) {
    return "grammar: neuter «havdyr» → use det største havdyret (not den … havdyren)";
  }

  if (new RegExp(`\\bden ${sup} [a-zæøå]+et\\b`, "i").test(t)) {
    return "grammar: suspected den with neuter definite (-et); use det … where the noun is intetkjønn";
  }

  if (new RegExp(`\\bdet ${sup} [a-zæøå]+en\\b`, "i").test(t)) {
    return "grammar: suspected det with common-gender definite (-en); use den … where the noun is hankjønn/hunkjønn/felleskjønn";
  }

  if (new RegExp(`\\bden ${sup} \\w*dyren\\b`, "i").test(t)) {
    return "grammar: suspected wrong form *dyren with den; intetkjønn dyre/dyr → det … dyret";
  }

  return null;
}

/**
 * Nytt: defensiv sperre mot tydelig vage eller subjektive formuleringer.
 * Bevisst enkel: stopper bare noen klassiske uttrykk som ofte gjør spørsmålet
 * faglig uklart eller vanskelig å dokumentere presist.
 */
function getVagueQuestionValidationError(questionText) {
  const text = String(questionText ?? "").trim();
  if (!text) {
    return null;
  }

  if (
    /\b(kjent for|ofte regnet som|mange mener|anses som)\b/i.test(text)
  ) {
    return "must not use vague reputation-based phrasing";
  }

  if (/\b(mest populære|populært\s+blant)\b/i.test(text)) {
    return "must not use popularity-based phrasing";
  }

  if (/\b(vakker|silkeaktig|imponerende|spennende)\b/i.test(text)) {
    return "must not use subjective descriptive phrasing";
  }

  return null;
}

/** Ofte åpne / utydelige «type»-spørsmål uten én klar fasit. */
const ABSTRACT_TYPE_QUESTION_PATTERNS = [
  /\bhvilken type\b/i,
  /\bhva slags type\b/i,
  /\bhva slags\b/i,
];

function getAbstractTypeQuestionValidationError(questionText) {
  const text = String(questionText ?? "").trim();
  if (!text) {
    return null;
  }
  if (ABSTRACT_TYPE_QUESTION_PATTERNS.some((re) => re.test(text))) {
    return "must not use abstract type phrasing (hvilken type / hva slags)";
  }
  return null;
}

/**
 * Defensiv sperre mot spørsmål som er for elementære til valgt vanskegrad.
 * Bevisst smal: stopper bare tydelige «første-faktum»-spørsmål på normal/hard.
 */
function getTooEasyForDifficultyValidationError(questionText, difficulty) {
  const diff = normalizeQuizDifficulty(difficulty);
  if (diff === "easy") {
    return null;
  }

  const text = String(questionText ?? "").trim().toLowerCase();
  if (!text) {
    return null;
  }

  const ultraBasicPatterns = [
    /\bhvilket organ pumper blod gjennom kroppen\b/i,
    /\bhva heter hovedstaden i\b/i,
    /\bhvilken planet er nærmest solen\b/i,
    /\bhva er kroppens største organ\b/i,
    /\bhva kalles prosessen der planter lager sin egen næring\b/i,
  ];

  if (ultraBasicPatterns.some((re) => re.test(text))) {
    return "is too basic for selected difficulty";
  }

  if (
    diff === "hard" &&
    text.length <= 42 &&
    /^(hva er|hva heter|hva kalles|hvilket organ|hvilken planet)\b/i.test(text)
  ) {
    return "is too basic for hard difficulty";
  }

  return null;
}

/** Spørsmål om alias / folkelige navn uten dokumentasjon er høy hallusinasjonsrisiko (f.eks. oppdiktede «vanlige navn»). */
const ALTERNATE_NAME_HALLUCINATION_PATTERNS = [
  /\bet annet navn (?:for|på)\b/i,
  /\bannet navn (?:for|på)\b/i,
  /\bogså kalt\b/i,
  /\bogså kjent som\b/i,
  /\bvanlig brukt(?:\s+annet)?\s+navn\b/i,
  /\bkjent som\b/i,
  /\bpopulært kalt\b/i,
  /\bkalles ofte\b/i,
  /\bfolkelig(?:t)?\s+navn\b/i,
];

const MIN_LOOKUP_CONTEXT_CHARS_FOR_ALIAS_QUESTIONS = 100;

/**
 * Blokkerer typiske «annet navn / også kalt»-spørsmål når fasit ikke er sporbart i tilstrekkelig lookup-kontekst.
 * I fagmodus (subjectMode) hoppes sjekken over — der er det bevisst ingen wiki-kontekst.
 */
function getAlternateNameHallucinationValidationError(
  question,
  lookup,
  subjectMode
) {
  if (subjectMode) {
    return null;
  }
  const text = String(question?.question ?? "").trim();
  if (
    !ALTERNATE_NAME_HALLUCINATION_PATTERNS.some((re) => re.test(text))
  ) {
    return null;
  }
  const ctx = String(lookup?.context ?? "").trim();
  if (ctx.length < MIN_LOOKUP_CONTEXT_CHARS_FOR_ALIAS_QUESTIONS) {
    return "unverified alternate-name or synonym phrasing (insufficient lookup context)";
  }
  const answer = String(question?.answer ?? "").trim();
  if (!isAnswerTraceableToLookupContext(answer, ctx)) {
    return "unverified alternate-name phrasing (answer not traceable to lookup context)";
  }
  return null;
}

/**
 * Nytt: hard kontroll for person-tema med lookup.
 * Hvis fasiten ikke kan spores til lookup-konteksten, forkastes spørsmålet.
 */
function getLookupTraceabilityValidationError(question, expectedTheme, lookup) {
  if (!shouldEnforceStrictPersonLookup(expectedTheme, lookup)) {
    return null;
  }

  const answerText = String(question?.answer ?? "").trim();
  const lookupContext = String(lookup?.context ?? "").trim();
  if (!answerText || !lookupContext) {
    return "person theme answer must be traceable to lookup context";
  }

  if (!isAnswerTraceableToLookupContext(answerText, lookupContext)) {
    return "person theme answer must be traceable to lookup context";
  }

  return null;
}

/**
 * Nytt: enkel kvalitetskontroll for å hindre at riktig svar skiller seg for mye ut
 * i lengde/struktur sammenlignet med distraktørene.
 */
function getOptionBalanceProfile(optionText) {
  const text = String(optionText ?? "").replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").filter(Boolean) : [];
  const longWords = text.match(/\b[\p{L}]{7,}\b/gu) || [];
  const structureMarkers =
    text.match(/\b(ved|fra|innen|under|mellom|omkring|knyttet til)\b/giu) || [];
  const punctuationMarkers = text.match(/[,:();-]/g) || [];

  return {
    words: words.length,
    longWords: longWords.length,
    structureMarkers: structureMarkers.length,
    punctuationMarkers: punctuationMarkers.length,
    score:
      words.length +
      longWords.length +
      structureMarkers.length +
      Math.min(2, punctuationMarkers.length),
  };
}

function getAnswerOptionBalanceValidationError(question) {
  const answer = String(question?.answer ?? "").trim();
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!answer || options.length !== 4) {
    return null;
  }

  const distractors = options.filter((option) => String(option).trim() !== answer);
  if (distractors.length !== 3) {
    return null;
  }

  const answerProfile = getOptionBalanceProfile(answer);
  const distractorProfiles = distractors.map(getOptionBalanceProfile);
  const avgDistractorWords =
    distractorProfiles.reduce((sum, item) => sum + item.words, 0) /
    distractorProfiles.length;
  const avgDistractorScore =
    distractorProfiles.reduce((sum, item) => sum + item.score, 0) /
    distractorProfiles.length;
  const maxDistractorScore = Math.max(...distractorProfiles.map((item) => item.score));
  const maxDistractorWords = Math.max(...distractorProfiles.map((item) => item.words));

  const answerLooksSpecific =
    answerProfile.words >= 5 ||
    answerProfile.longWords >= 2 ||
    answerProfile.structureMarkers >= 1 ||
    answerProfile.punctuationMarkers >= 1;

  /**
   * Riktig svar er strengt lengre (ord) enn alle distraktører → ofte et gjettesignal.
   * Tillat små forskjeller; slå inn ved tydelig gap eller lang fasit.
   */
  if (
    answerProfile.words > maxDistractorWords &&
    answerProfile.words >= 5 &&
    answerProfile.words - maxDistractorWords >= 3
  ) {
    return "answer option is too dominant in word length vs distractors";
  }

  if (
    answerLooksSpecific &&
    answerProfile.words >= avgDistractorWords + 3 &&
    avgDistractorWords <= Math.max(3, answerProfile.words * 0.65)
  ) {
    return "answer option stands out too much in length";
  }

  if (
    answerLooksSpecific &&
    answerProfile.score >= maxDistractorScore + 4 &&
    avgDistractorScore > 0 &&
    answerProfile.score > avgDistractorScore * 1.6
  ) {
    return "answer option stands out too much in specificity";
  }

  return null;
}

/**
 * Sant når fasiten har flere ord enn den lengste distraktøren (unikt lengst blant de fire).
 */
function correctAnswerIsUniquelyLongestWords(question) {
  const answer = String(question?.answer ?? "").trim();
  const options = Array.isArray(question?.options) ? question.options : [];
  if (!answer || options.length !== 4) {
    return false;
  }
  const distractors = options.filter((option) => String(option).trim() !== answer);
  if (distractors.length !== 3) {
    return false;
  }
  const aw = getOptionBalanceProfile(answer).words;
  const mw = Math.max(
    ...distractors.map((d) => getOptionBalanceProfile(d).words)
  );
  return aw > mw;
}

function validateGeneratedQuiz(
  payload,
  expectedTheme,
  minQuestions = 3,
  maxQuestions = 5,
  lookup = null,
  subjectMode = false,
  difficulty = "easy",
  validationOptions = null
) {
  const skipLookupSensitive =
    validationOptions &&
    typeof validationOptions === "object" &&
    validationOptions.skipLookupSensitive === true;
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

  let uniquelyLongestCorrectCount = 0;
  const normalizedRows = [];

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
    if (typeof q.text === "string" && q.text.trim()) {
      return `question ${i} must not include hidden source text`;
    }
    const questionContextError = getQuestionContextValidationError(q.question);
    if (questionContextError) {
      return `question ${i} ${questionContextError}`;
    }
    const optionDependentError = getOptionDependentQuestionValidationError(q.question);
    if (optionDependentError) {
      return `question ${i} ${optionDependentError}`;
    }
    const openEndedError = getOpenEndedQuestionValidationError(q.question);
    if (openEndedError) {
      return `question ${i} ${openEndedError}`;
    }
    const grammarHeuristicError = getNorwegianGrammarHeuristicError(q.question);
    if (grammarHeuristicError) {
      return `question ${i} ${grammarHeuristicError}`;
    }
    const vagueQuestionError = getVagueQuestionValidationError(q.question);
    if (vagueQuestionError) {
      return `question ${i} ${vagueQuestionError}`;
    }
    const abstractTypeError = getAbstractTypeQuestionValidationError(q.question);
    if (abstractTypeError) {
      return `question ${i} ${abstractTypeError}`;
    }
    const tooEasyError = getTooEasyForDifficultyValidationError(
      q.question,
      difficulty
    );
    if (tooEasyError) {
      return `question ${i} ${tooEasyError}`;
    }
    if (!skipLookupSensitive) {
      const aliasHallucinationError = getAlternateNameHallucinationValidationError(
        q,
        lookup,
        subjectMode
      );
      if (aliasHallucinationError) {
        return `question ${i} ${aliasHallucinationError}`;
      }
      const lookupTraceError = getLookupTraceabilityValidationError(
        q,
        expectedTheme,
        lookup
      );
      if (lookupTraceError) {
        return `question ${i} ${lookupTraceError}`;
      }
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
    if (typeof q.fact_key !== "string" || !String(q.fact_key).trim()) {
      return `question ${i} fact_key missing`;
    }
    const fkNorm = normalizeFactKey(q.fact_key);
    if (!fkNorm) {
      return `question ${i} fact_key invalid (2–6 segments, e.g. norge|hovedstad|oslo)`;
    }
    const optionBalanceError = getAnswerOptionBalanceValidationError(q);
    if (optionBalanceError) {
      return `question ${i} ${optionBalanceError}`;
    }

    const answer = String(q.answer ?? "").trim();
    if (answer && getOptionBalanceProfile(answer).words >= 4) {
      if (correctAnswerIsUniquelyLongestWords(q)) {
        uniquelyLongestCorrectCount += 1;
      }
    }
    normalizedRows.push({
      question: normalizeQuizQuestionText(q.question),
      answer: normalizeQuizAnswerText(q.answer),
      factKey: fkNorm,
    });
  }

  const n = questions.length;
  for (let i = 0; i < normalizedRows.length; i += 1) {
    for (let j = i + 1; j < normalizedRows.length; j += 1) {
      const a = normalizedRows[i];
      const b = normalizedRows[j];
      if (a.factKey && b.factKey && normalizedFactKeysTooSimilar(a.factKey, b.factKey)) {
        return `quiz: questions ${i + 1} and ${j + 1} reuse the same fact_key`;
      }
      const questionsTooClose = normalizedQuestionsTooSimilar(
        a.question,
        b.question,
        QUIZ_MEMORY_MODE.DAILY
      );
      const answersTooClose = normalizedAnswersTooSimilar(
        a.answer,
        b.answer,
        QUIZ_MEMORY_MODE.DAILY
      );
      const factKeysTooClose =
        a.factKey && b.factKey && normalizedFactKeysTooSimilar(a.factKey, b.factKey);
      if (questionsTooClose && (answersTooClose || factKeysTooClose)) {
        return `quiz: questions ${i + 1} and ${j + 1} are too similar`;
      }
    }
  }
  if (n >= 3) {
    const maxAllowedUniquelyLongest = Math.max(1, Math.floor(n * 0.45));
    if (uniquelyLongestCorrectCount > maxAllowedUniquelyLongest) {
      return "quiz: correct answer is too often the longest option by word count";
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

  const themeInputError = validateThemeForQuizInput(theme);
  if (themeInputError) {
    res.status(400).json({ error: themeInputError });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const quizSourceRaw =
    typeof req.body?.quizSource === "string"
      ? req.body.quizSource.trim().toLowerCase()
      : typeof req.body?.source === "string"
        ? req.body.source.trim().toLowerCase()
        : "";
  const memoryMode =
    quizSourceRaw === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;

  /* Nytt: fagmodus — kun ved eksplisitt JSON boolean true (ingen auto-gjetting, ingen "truthy" strenger). */
  const subjectMode = req.body?.subjectMode === true;
  const difficulty = normalizeQuizDifficulty(req.body?.difficulty);

  try {
    const questionCount = 5;
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

    let parsed;
    try {
      parsed = await generateQuizWithOpenAI(
        openai,
        model,
        theme,
        questionCount,
        {
          pool,
          mode: memoryMode,
        },
        subjectMode,
        difficulty
      );
    } catch (genErr) {
      await pool.end().catch(() => {});
      throw genErr;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO quizzes (theme, questions, difficulty) VALUES ($1, $2::jsonb, $3)",
        [
          parsed.theme.trim(),
          serializeQuizForStorage(parsed.sharedImage ?? null, parsed.questions),
          difficulty,
        ]
      );
      await insertQuizQuestionMemoryRows(
        client,
        parsed.theme,
        parsed.questions,
        memoryMode
      );
      await client.query("COMMIT");
    } catch (dbErr) {
      await client.query("ROLLBACK").catch(() => {});
      const dbMessage =
        dbErr && typeof dbErr.message === "string"
          ? dbErr.message
          : "Failed to save quiz";
      res.status(500).json({ error: dbMessage });
      return;
    } finally {
      client.release();
      await pool.end().catch(() => {});
    }

    res.status(200).json({
      ...stripFactKeyFromQuizPayload(parsed),
      difficulty,
    });
  } catch (err) {
    const message =
      err && typeof err.message === "string" ? err.message : "OpenAI failed";
    res.status(502).json({ error: message });
  }
});

/**
 * Bilde-10-variant: egen lagringsrad og JSON-variant; grunnmotor brukes via generateVisualTenQuizWithOpenAI.
 */
app.post("/api/internal/generate-visual-10-quiz", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const quizSourceRaw =
    typeof req.body?.quizSource === "string"
      ? req.body.quizSource.trim().toLowerCase()
      : typeof req.body?.source === "string"
        ? req.body.source.trim().toLowerCase()
        : "";
  const memoryMode =
    quizSourceRaw === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;

  const difficulty = "normal";

  try {
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

    let parsed;
    try {
      parsed = await generateVisualTenQuizWithOpenAI(
        openai,
        model,
        {
          pool,
          mode: memoryMode,
        },
        difficulty
      );
    } catch (genErr) {
      await pool.end().catch(() => {});
      throw genErr;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO quizzes (theme, questions, difficulty) VALUES ($1, $2::jsonb, $3)",
        [
          parsed.theme.trim(),
          serializeQuizForStorage(
            parsed.sharedImage ?? null,
            parsed.questions,
            { variant: VISUAL_TEN_QUIZ_VARIANT }
          ),
          difficulty,
        ]
      );
      await insertQuizQuestionMemoryRows(
        client,
        parsed.theme,
        parsed.questions,
        memoryMode
      );
      await client.query("COMMIT");
    } catch (dbErr) {
      await client.query("ROLLBACK").catch(() => {});
      const dbMessage =
        dbErr && typeof dbErr.message === "string"
          ? dbErr.message
          : "Failed to save quiz";
      res.status(500).json({ error: dbMessage });
      return;
    } finally {
      client.release();
      await pool.end().catch(() => {});
    }

    res.status(200).json({
      ...stripFactKeyFromQuizPayload(parsed),
      difficulty,
      variant: VISUAL_TEN_QUIZ_VARIANT,
    });
  } catch (err) {
    const message =
      err && typeof err.message === "string" ? err.message : "OpenAI failed";
    res.status(502).json({ error: message });
  }
});

app.post("/api/quiz/check-question", async (req, res) => {
  const { question, questionId, theme } = req.body ?? {};
  let questionText = typeof question === "string" ? question.trim() : "";
  let themeText = typeof theme === "string" ? theme.trim() : "";

  if (questionId === undefined || questionId === null) {
    res.status(400).json({ error: "Missing questionId" });
    return;
  }

  if (!questionText || !themeText) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      res.status(400).json({ error: "Missing question or theme" });
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
        `SELECT * FROM quizzes
         WHERE (questions::jsonb->>'variant' IS DISTINCT FROM $1)
         ORDER BY created_at DESC
         LIMIT 1`,
        [VISUAL_TEN_QUIZ_VARIANT]
      );

      if (result.rows.length > 0) {
        const quiz = result.rows[0];
        const { questions } = getQuizQuestionsPayloadFromRow(quiz);

        if (!questionText) {
          const matchedQuestion = pickQuestionFromBody(req.body, questions);
          questionText = String(matchedQuestion?.question ?? "").trim();
        }

        if (!themeText) {
          themeText = String(quiz.theme ?? "").trim();
        }
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  if (!questionText || !themeText) {
    res.status(400).json({ error: "Missing question or theme" });
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
  let replacementMemoryPool = null;
  let replacementDifficulty = "easy";
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      replacementMemoryPool = new Pool({
        connectionString: dbUrl,
        ssl:
          process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
            : undefined,
      });
      try {
        const diffRes = await replacementMemoryPool.query(
          `SELECT difficulty FROM quizzes
           WHERE (questions::jsonb->>'variant' IS DISTINCT FROM $1)
           ORDER BY created_at DESC
           LIMIT 1`,
          [VISUAL_TEN_QUIZ_VARIANT]
        );
        if (diffRes.rows[0]?.difficulty) {
          replacementDifficulty = normalizeQuizDifficulty(
            diffRes.rows[0].difficulty
          );
        }
      } catch {
        replacementDifficulty = "easy";
      }
    }
    const replacementQuiz = await generateQuizWithOpenAI(
      openai,
      model,
      themeText,
      1,
      replacementMemoryPool
        ? { pool: replacementMemoryPool, mode: QUIZ_MEMORY_MODE.CUSTOM }
        : null,
      false,
      replacementDifficulty
    );
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
  } finally {
    if (replacementMemoryPool) {
      await replacementMemoryPool.end().catch(() => {});
    }
  }

  res.status(200).json({
    valid: false,
    message: "Du har rett, spørsmålet egner seg ikke for skrivesvar.",
    points: applyQuizDifficultyToPoints(5, replacementDifficulty),
    question: replacementQuestion,
  });
});

app.post(
  "/api/quiz/transcribe",
  (req, res, next) => {
    transcribeUpload.single("audio")(req, res, (err) => {
      if (err) {
        const msg =
          err.code === "LIMIT_FILE_SIZE"
            ? "Lydfilen er for stor (maks ca. 25 MB)."
            : err.message || "Kunne ikke ta imot lydfil.";
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer || req.file.buffer.length < 32) {
        res.status(400).json({ error: "Mangler eller for kort lydopptak." });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: "OPENAI_API_KEY is not set" });
        return;
      }

      const mime = String(req.file.mimetype || "");
      let ext = "webm";
      if (mime.includes("mp4") || mime.includes("m4a")) {
        ext = "m4a";
      } else if (mime.includes("mpeg") || mime.includes("mp3")) {
        ext = "mp3";
      } else if (mime.includes("wav")) {
        ext = "wav";
      }

      const tmpPath = path.join(
        os.tmpdir(),
        `gruble-transcribe-${crypto.randomUUID()}.${ext}`
      );

      const openai = new OpenAI({ apiKey });

      await fs.promises.writeFile(tmpPath, req.file.buffer);
      try {
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmpPath),
          model: "whisper-1",
        });
        const text =
          transcription && typeof transcription.text === "string"
            ? transcription.text.trim()
            : "";
        res.status(200).json({ text });
      } finally {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
    } catch (err) {
      const message =
        err && typeof err.message === "string"
          ? err.message
          : "Transkripsjon feilet.";
      res.status(502).json({ error: message });
    }
  }
);

app.listen(port, () => {
  console.log(`Gruble API listening on port ${port}`);
});

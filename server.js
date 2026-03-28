const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const multer = require("multer");
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
const EVALUATE_PROTEST_SYSTEM = readPromptFile("evaluateProtest.txt");

/** Nytt: maksimal lengde og ord for tema ved quizgenerering fra brukerinput. */
const THEME_INPUT_MAX_CHARS = 50;
const THEME_INPUT_MAX_WORDS = 3;

/**
 * Nytt: avvis for langt tema før OpenAI-kall (testgenerering).
 * @returns {string|null} feilmelding på norsk, eller null hvis OK
 */
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
    const result = await pool.query(
      "SELECT * FROM quizzes ORDER BY created_at DESC LIMIT 1"
    );
    if (result.rows.length === 0) {
      return "";
    }
    const quiz = result.rows[0];
    const questions =
      typeof quiz.questions === "string"
        ? JSON.parse(quiz.questions)
        : JSON.parse(JSON.stringify(quiz.questions));
    const q = questions.find((item) => Number(item.id) === Number(questionId));
    if (!q || q.answer === undefined || q.answer === null) {
      return "";
    }
    return String(q.answer).trim();
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

async function maybeBuildThemeLookupSupport(theme) {
  const emptyLookup = {
    vague: false,
    titles: [],
    nameTitles: [],
    personTitles: [],
    hasPersonContext: false,
    context: "",
    split: false,
    splitParts: [],
  };

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

function buildQuizUserPrompt(theme, questionCount, lookup) {
  const themeJson = JSON.stringify(theme);
  let prompt = `Generer ${questionCount} enkle flervalgsoppgaver på norsk om temaet: ${themeJson}.

Spørsmålene må være selvstendige.
Brukeren skal kunne forstå og besvare hvert spørsmål uten artikkel, ingress, tekstutdrag eller annen skjult kontekst.
Ikke inkluder felt som "text", "context", "passage" eller lignende.

Hvert element i "questions" skal ha:
- id: heltall fra 1 og oppover
- question: spørsmålstekst
- options: nøyaktig 4 strenger (ett riktig svar, tre plausibel feil)
- answer: eksakt lik én av strengene i options

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
  } else if (lookup?.vague) {
    prompt += `

Temaet virker kort eller tvetydig, og oppslag ga ikke trygg nok faktastøtte.
Ikke lag spørsmål om konkrete personer, hendelser, verk, TV-serier eller kampanjer.
Bruk bare generelle og dokumenterbare fakta som kan forsvares direkte ut fra temaet.`;
  }

  prompt += `

Returner KUN JSON med denne formen (ingen markdown):
{"theme":...,"questions":[...]}`;

  return prompt;
}

async function generateQuizWithOpenAI(openai, model, theme, questionCount) {
  // Nytt: korte/tvetydige tema får et forsiktig oppslag mot Wikipedia før modellkallet.
  const lookup = await maybeBuildThemeLookupSupport(theme);
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
  const userPrompt = buildQuizUserPrompt(theme, questionCount, lookup);
  console.log(
    `[quiz lookup] promptHasLookupContext=${lookup.context ? "true" : "false"}`
  );

  let lastValidationError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
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
      lastValidationError = validationError;
      continue;
    }

    return {
      ...parsed,
      questions: parsed.questions.map(shuffleQuestionOptions),
    };
  }

  throw new Error(
    `Invalid quiz shape from model: ${lastValidationError || "unknown validation error"}`
  );
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

  const { questionId, answer, mode, attemptNumber, questionOverride } = req.body ?? {};
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

  const answerLooksSpecific =
    answerProfile.words >= 5 ||
    answerProfile.longWords >= 2 ||
    answerProfile.structureMarkers >= 1 ||
    answerProfile.punctuationMarkers >= 1;

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
    if (typeof q.text === "string" && q.text.trim()) {
      return `question ${i} must not include hidden source text`;
    }
    const questionContextError = getQuestionContextValidationError(q.question);
    if (questionContextError) {
      return `question ${i} ${questionContextError}`;
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
    const optionBalanceError = getAnswerOptionBalanceValidationError(q);
    if (optionBalanceError) {
      return `question ${i} ${optionBalanceError}`;
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

  try {
    const questionCount = 5;
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
        "SELECT * FROM quizzes ORDER BY created_at DESC LIMIT 1"
      );

      if (result.rows.length > 0) {
        const quiz = result.rows[0];
        const questions =
          typeof quiz.questions === "string"
            ? JSON.parse(quiz.questions)
            : JSON.parse(JSON.stringify(quiz.questions));

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

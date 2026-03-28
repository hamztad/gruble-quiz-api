/**
 * quizMemory.js — første versjon av spørsmålsminne / duplikatkontroll.
 *
 * Lagrer normaliserte spørsmål i Postgres og sammenligner nye spørsmål mot historikk
 * med enkel normalisering + konservativ tekstlikhet (ingen embeddings).
 *
 * Moduser:
 * - daily: strengere — flere treff regnes som duplikater.
 * - custom: mer tolerant — stort sett eksakt / nesten identisk etter normalisering.
 */

/** Maks antall historiske rader vi henter for sammenligning (ytelse). */
const MEMORY_HISTORY_LIMIT = 1200;

/** Maks tegn i normalisert streng for Levenshtein (unngå tunge kalkulasjoner). */
const LEV_MAX_LEN = 320;

const QUIZ_MEMORY_MODE = {
  DAILY: "daily",
  CUSTOM: "custom",
};

/**
 * Normaliserer spørsmålstekst for sammenligning (duplikatkontroll).
 * Nytt: lowercase, trim, sammenlegging av mellomrom, fjerning av tegnsetting.
 */
function normalizeQuizQuestionText(text) {
  let s = String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  s = s.replace(/[\s\u00a0]+/g, " ").trim();
  s = s.replace(/[?!.,;:—–\-–"'«»()[\]{}¿¡·`´^]+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function normalizeThemeForMemory(theme) {
  return String(theme ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function logMemory(line) {
  console.log(`[quiz memory] ${line}`);
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) {
      prev[j] = curr[j];
    }
  }
  return prev[n];
}

function tokenSetForOverlap(normalized) {
  return normalized
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
}

/**
 * Enkel Jaccard-likhet på ord (kun for tydelig overlapp, konservativ bruk).
 */
function tokenJaccardSimilarity(aNorm, bNorm) {
  const ta = tokenSetForOverlap(aNorm);
  const tb = tokenSetForOverlap(bNorm);
  if (ta.length === 0 || tb.length === 0) {
    return 0;
  }
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) {
      inter += 1;
    }
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Sjekk om to normaliserte spørsmål er «for like» gitt modus.
 * Nytt: kombinasjon av eksakt match, begrenset Levenshtein-ratio og (daily) token-Jaccard.
 */
function normalizedQuestionsTooSimilar(normA, normB, mode) {
  if (!normA || !normB) {
    return false;
  }
  if (normA === normB) {
    return true;
  }

  const short = Math.min(normA.length, normB.length);
  if (short < 12) {
    return normA === normB;
  }

  let a = normA;
  let b = normB;
  if (a.length > LEV_MAX_LEN) {
    a = a.slice(0, LEV_MAX_LEN);
  }
  if (b.length > LEV_MAX_LEN) {
    b = b.slice(0, LEV_MAX_LEN);
  }

  const maxLen = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  const levRatio = 1 - dist / maxLen;

  if (mode === QUIZ_MEMORY_MODE.DAILY) {
    if (levRatio >= 0.87) {
      return true;
    }
    const j = tokenJaccardSimilarity(normA, normB);
    const wordsA = tokenSetForOverlap(normA).length;
    const wordsB = tokenSetForOverlap(normB).length;
    if (wordsA >= 5 && wordsB >= 5 && j >= 0.9) {
      return true;
    }
    return false;
  }

  /* custom: mer tolerant — kun nesten identisk streng */
  if (levRatio >= 0.96) {
    return true;
  }
  return false;
}

function isDuplicateAgainstList(normalized, list, mode) {
  for (let i = 0; i < list.length; i += 1) {
    if (normalizedQuestionsTooSimilar(normalized, list[i], mode)) {
      return true;
    }
  }
  return false;
}

/**
 * Henter siste N rader fra minnetabellen for sammenligning.
 */
async function fetchQuestionMemoryHistory(pool) {
  const r = await pool.query(
    `SELECT question_normalized
     FROM quiz_question_memory
     ORDER BY created_at DESC
     LIMIT $1`,
    [MEMORY_HISTORY_LIMIT]
  );
  return r.rows.map((row) => String(row.question_normalized ?? ""));
}

/**
 * Filtrerer bort spørsmål som matcher historikk eller hverandre (internt i batchen).
 * Returnerer beholdte spørsmål i opprinnelig rekkefølge.
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} questions modellens spørsmålobjekter (med .question)
 * @param {string} theme
 * @param {'daily'|'custom'} mode
 */
async function filterQuizQuestionsAgainstMemory(pool, questions, theme, mode) {
  const m =
    mode === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;

  if (!pool || !Array.isArray(questions) || questions.length === 0) {
    return { questions: questions || [], rejected: 0, rejectedSnippets: [] };
  }

  let history;
  try {
    history = await fetchQuestionMemoryHistory(pool);
  } catch (e) {
    logMemory(
      `historyFetchFailed msg=${JSON.stringify(String(e?.message || e))} — proceeding without history`
    );
    history = [];
  }

  const accepted = [];
  const acceptedNorm = [];
  const rejectedSnippets = [];
  let rejected = 0;

  logMemory(
    `mode=${m} theme=${JSON.stringify(normalizeThemeForMemory(theme))} historyRows=${history.length} checked=${questions.length}`
  );

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const raw = String(q?.question ?? "").trim();
    const norm = normalizeQuizQuestionText(raw);
    if (!norm) {
      rejected += 1;
      rejectedSnippets.push("(tomt etter normalisering)");
      logMemory(`rejectedQuestion=emptyAfterNormalize index=${i}`);
      continue;
    }

    if (isDuplicateAgainstList(norm, acceptedNorm, m)) {
      rejected += 1;
      rejectedSnippets.push(raw.slice(0, 80));
      logMemory(
        `rejectedQuestion=internalDuplicate index=${i} snippet=${JSON.stringify(raw.slice(0, 100))}`
      );
      continue;
    }

    if (isDuplicateAgainstList(norm, history, m)) {
      rejected += 1;
      rejectedSnippets.push(raw.slice(0, 80));
      logMemory(
        `rejectedQuestion=historyDuplicate index=${i} snippet=${JSON.stringify(raw.slice(0, 100))}`
      );
      continue;
    }

    accepted.push(q);
    acceptedNorm.push(norm);
  }

  logMemory(
    `duplicatesFound=${rejected} finalAccepted=${accepted.length} (internal+history)`
  );

  return { questions: accepted, rejected, rejectedSnippets };
}

/**
 * Lagrer aksepterte spørsmål i minnetabellen (kalles etter vellykket quiz-lagring).
 * Bruk samme db-klient som transaksjonen hvis mulig.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} client
 * @param {string} theme
 * @param {object[]} questions
 * @param {'daily'|'custom'} quizSource
 */
async function insertQuizQuestionMemoryRows(client, theme, questions, quizSource) {
  const src =
    quizSource === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;
  const themeNorm = normalizeThemeForMemory(theme);

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const orig = String(q?.question ?? "").trim();
    const norm = normalizeQuizQuestionText(orig);
    if (!norm) {
      continue;
    }
    await client.query(
      `INSERT INTO quiz_question_memory (
        theme_normalized,
        question_original,
        question_normalized,
        quiz_source
      ) VALUES ($1, $2, $3, $4)`,
      [themeNorm, orig, norm, src]
    );
  }
}

module.exports = {
  QUIZ_MEMORY_MODE,
  MEMORY_HISTORY_LIMIT,
  normalizeQuizQuestionText,
  normalizeThemeForMemory,
  filterQuizQuestionsAgainstMemory,
  insertQuizQuestionMemoryRows,
  normalizedQuestionsTooSimilar,
};

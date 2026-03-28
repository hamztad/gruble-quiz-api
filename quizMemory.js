/**
 * quizMemory.js — spørsmålsminne / duplikatkontroll i Postgres.
 *
 * Lagrer hvert brukte spørsmål som egen rad (tema, spørsmål, svar, valgfri fact_key).
 * Sammenligner nye spørsmål mot historikk med normalisering + konservativ tekstlikhet.
 */

/** Maks antall historiske rader for sammenligning. */
const MEMORY_HISTORY_LIMIT = 1200;

/** Maks tegn i normalisert streng for Levenshtein på spørsmål. */
const LEV_MAX_LEN = 320;

const QUIZ_MEMORY_MODE = {
  DAILY: "daily",
  CUSTOM: "custom",
};

/** Logget som avvisningsårsak (samme navn i histogram). */
const MEMORY_REJECT_REASON = {
  FACT_KEY: "fact_key",
  QUESTION_ANSWER: "question_answer",
  QUESTION_TEXT: "question_text",
};

/**
 * Normaliserer spørsmål og svar for sammenligning.
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

const normalizeQuizAnswerText = normalizeQuizQuestionText;

function normalizeThemeForMemory(theme) {
  return String(theme ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/**
 * Normaliserer valgfri fact_key fra modellen til sammenlignbar nøkkel (kun backend).
 * Forventer segmenter adskilt med |, f.eks. norge|hovedstad|oslo
 * @returns {string} tom streng hvis ugyldig / tom
 */
function normalizeFactKey(raw) {
  if (raw == null) {
    return "";
  }
  const fold = String(raw)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a");
  const segments = fold
    .split("|")
    .map((seg) => seg.replace(/[^a-z0-9]+/g, "").trim())
    .filter(Boolean);
  if (segments.length < 2 || segments.length > 6) {
    return "";
  }
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].length < 1 || segments[i].length > 40) {
      return "";
    }
  }
  return segments.join("|");
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
    if (levRatio >= 0.9) {
      return true;
    }
    const j = tokenJaccardSimilarity(normA, normB);
    const wordsA = tokenSetForOverlap(normA).length;
    const wordsB = tokenSetForOverlap(normB).length;
    if (wordsA >= 5 && wordsB >= 5 && j >= 0.92) {
      return true;
    }
    return false;
  }

  if (levRatio >= 0.96) {
    return true;
  }
  return false;
}

/**
 * Fasittekster er korte — konservativ likhet, ofte kun eksakt match på veldig korte strenger.
 */
function normalizedAnswersTooSimilar(normA, normB, mode) {
  if (!normA || !normB) {
    return false;
  }
  if (normA === normB) {
    return true;
  }
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen <= 5) {
    return false;
  }

  const cap = 120;
  let a = normA.length > cap ? normA.slice(0, cap) : normA;
  let b = normB.length > cap ? normB.slice(0, cap) : normB;
  const ml = Math.max(a.length, b.length);
  const dist = levenshteinDistance(a, b);
  const levRatio = 1 - dist / ml;

  if (mode === QUIZ_MEMORY_MODE.DAILY) {
    return levRatio >= 0.9;
  }
  return levRatio >= 0.94;
}

/**
 * @typedef {{ question: string, answer: string, factKey: string }} MemoryRowNorm
 */

/**
 * Første treff vinner (rekkefølge: fact_key → par → spørsmål alene).
 * @param {string} normQ
 * @param {string} normA
 * @param {string} fkNorm
 * @param {MemoryRowNorm[]} rows
 * @param {'daily'|'custom'} mode
 * @returns {{ reason: string, detail: string } | null}
 */
function findMemoryConflict(normQ, normA, fkNorm, rows, mode) {
  if (fkNorm) {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (r.factKey && r.factKey === fkNorm) {
        return { reason: MEMORY_REJECT_REASON.FACT_KEY, detail: "fact_key_match" };
      }
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (normQ === r.question && normA === r.answer) {
      return {
        reason: MEMORY_REJECT_REASON.QUESTION_ANSWER,
        detail: "exact_question_answer_pair",
      };
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (
      normalizedQuestionsTooSimilar(normQ, r.question, mode) &&
      normalizedAnswersTooSimilar(normA, r.answer, mode)
    ) {
      return {
        reason: MEMORY_REJECT_REASON.QUESTION_ANSWER,
        detail: "fuzzy_question_answer_pair",
      };
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (normQ === r.question) {
      return {
        reason: MEMORY_REJECT_REASON.QUESTION_TEXT,
        detail: "exact_question_text",
      };
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (normalizedQuestionsTooSimilar(normQ, r.question, mode)) {
      return {
        reason: MEMORY_REJECT_REASON.QUESTION_TEXT,
        detail: "fuzzy_question_text",
      };
    }
  }

  return null;
}

async function fetchQuizMemoryHistoryRows(pool) {
  const r = await pool.query(
    `SELECT question_normalized,
            COALESCE(answer_normalized, '') AS answer_normalized,
            COALESCE(fact_key_normalized, '') AS fact_key_normalized
     FROM quiz_question_memory
     ORDER BY created_at DESC
     LIMIT $1`,
    [MEMORY_HISTORY_LIMIT]
  );
  return r.rows.map((row) => ({
    question: String(row.question_normalized ?? ""),
    answer: String(row.answer_normalized ?? ""),
    factKey: String(row.fact_key_normalized ?? "").trim(),
  }));
}

/**
 * @param {import('pg').Pool|null} pool
 * @param {object[]} questions modellens spørsmålobjekter (med .question, .answer, valgfri .fact_key)
 * @param {string} theme
 * @param {'daily'|'custom'} mode
 * @param {object[]|null} priorAcceptedQuestions allerede godkjente spørsmål (kun duplikatkontroll mot nye)
 */
async function filterQuizQuestionsAgainstMemory(
  pool,
  questions,
  theme,
  mode,
  priorAcceptedQuestions = null
) {
  const m =
    mode === QUIZ_MEMORY_MODE.DAILY
      ? QUIZ_MEMORY_MODE.DAILY
      : QUIZ_MEMORY_MODE.CUSTOM;

  if (!Array.isArray(questions) || questions.length === 0) {
    return { questions: questions || [], rejected: 0, rejectedSnippets: [] };
  }

  let historyRows = [];
  if (pool && typeof pool.query === "function") {
    try {
      historyRows = await fetchQuizMemoryHistoryRows(pool);
    } catch (e) {
      logMemory(
        `historyFetchFailed msg=${JSON.stringify(String(e?.message || e))} — proceeding without history`
      );
      historyRows = [];
    }
  } else {
    logMemory(
      `theme=${JSON.stringify(normalizeThemeForMemory(theme))} historyRows=0 reason=no_pool_internal_and_prior_only`
    );
  }

  const accepted = [];
  /** @type {MemoryRowNorm[]} */
  const acceptedRows = [];

  if (Array.isArray(priorAcceptedQuestions)) {
    for (let p = 0; p < priorAcceptedQuestions.length; p += 1) {
      const pq = priorAcceptedQuestions[p];
      const pnQ = normalizeQuizQuestionText(pq?.question);
      const pnA = normalizeQuizAnswerText(pq?.answer);
      const pFk = normalizeFactKey(pq?.fact_key);
      if (pnQ && pnA) {
        acceptedRows.push({
          question: pnQ,
          answer: pnA,
          factKey: pFk,
        });
      }
    }
  }

  const priorSeeded = acceptedRows.length;
  const rejectedSnippets = [];
  let rejected = 0;
  const reasonHistogram = {
    [MEMORY_REJECT_REASON.FACT_KEY]: 0,
    [MEMORY_REJECT_REASON.QUESTION_ANSWER]: 0,
    [MEMORY_REJECT_REASON.QUESTION_TEXT]: 0,
  };

  logMemory(
    `mode=${m} theme=${JSON.stringify(normalizeThemeForMemory(theme))} historyRows=${historyRows.length} priorSeeded=${priorSeeded} checked=${questions.length}`
  );

  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const rawQ = String(q?.question ?? "").trim();
    const rawA = String(q?.answer ?? "").trim();
    const normQ = normalizeQuizQuestionText(rawQ);
    const normA = normalizeQuizAnswerText(rawA);
    const fkNorm = normalizeFactKey(q?.fact_key);

    if (!normQ) {
      rejected += 1;
      rejectedSnippets.push("(tomt spørsmål etter normalisering)");
      logMemory(`rejectedReason=empty_after_normalize index=${i}`);
      continue;
    }
    if (!normA) {
      rejected += 1;
      rejectedSnippets.push(rawQ.slice(0, 80));
      logMemory(
        `rejectedReason=empty_answer_after_normalize index=${i} snippet=${JSON.stringify(rawQ.slice(0, 100))}`
      );
      continue;
    }

    const internal = findMemoryConflict(normQ, normA, fkNorm, acceptedRows, m);
    if (internal) {
      rejected += 1;
      reasonHistogram[internal.reason] =
        (reasonHistogram[internal.reason] || 0) + 1;
      rejectedSnippets.push(rawQ.slice(0, 80));
      logMemory(
        `rejectedReason=${internal.reason} scope=internal detail=${internal.detail} index=${i} snippet=${JSON.stringify(rawQ.slice(0, 100))}`
      );
      continue;
    }

    const hist = findMemoryConflict(normQ, normA, fkNorm, historyRows, m);
    if (hist) {
      rejected += 1;
      reasonHistogram[hist.reason] = (reasonHistogram[hist.reason] || 0) + 1;
      rejectedSnippets.push(rawQ.slice(0, 80));
      logMemory(
        `rejectedReason=${hist.reason} scope=history detail=${hist.detail} index=${i} snippet=${JSON.stringify(rawQ.slice(0, 100))}`
      );
      continue;
    }

    accepted.push(q);
    acceptedRows.push({
      question: normQ,
      answer: normA,
      factKey: fkNorm,
    });
  }

  const hParts = [
    `${MEMORY_REJECT_REASON.QUESTION_TEXT}:${reasonHistogram[MEMORY_REJECT_REASON.QUESTION_TEXT]}`,
    `${MEMORY_REJECT_REASON.QUESTION_ANSWER}:${reasonHistogram[MEMORY_REJECT_REASON.QUESTION_ANSWER]}`,
    `${MEMORY_REJECT_REASON.FACT_KEY}:${reasonHistogram[MEMORY_REJECT_REASON.FACT_KEY]}`,
  ];
  logMemory(`duplicatesFound=${rejected} rejectedReason=${hParts.join("|")}`);
  logMemory(
    `finalAccepted=${accepted.length} (internal+history) checked=${questions.length}`
  );

  return { questions: accepted, rejected, rejectedSnippets };
}

/**
 * Lagrer aksepterte spørsmål etter vellykket quiz-lagring.
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
    const origQ = String(q?.question ?? "").trim();
    const normQ = normalizeQuizQuestionText(origQ);
    const origA = String(q?.answer ?? "").trim();
    const normA = normalizeQuizAnswerText(origA);
    const fkNorm = normalizeFactKey(q?.fact_key);
    if (!normQ || !normA) {
      continue;
    }
    await client.query(
      `INSERT INTO quiz_question_memory (
        theme_normalized,
        question_original,
        question_normalized,
        answer_original,
        answer_normalized,
        fact_key_normalized,
        quiz_source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [themeNorm, origQ, normQ, origA, normA, fkNorm || "", src]
    );
  }
}

module.exports = {
  QUIZ_MEMORY_MODE,
  MEMORY_HISTORY_LIMIT,
  MEMORY_REJECT_REASON,
  normalizeQuizQuestionText,
  normalizeQuizAnswerText,
  normalizeFactKey,
  normalizeThemeForMemory,
  filterQuizQuestionsAgainstMemory,
  insertQuizQuestionMemoryRows,
  normalizedQuestionsTooSimilar,
  normalizedAnswersTooSimilar,
};

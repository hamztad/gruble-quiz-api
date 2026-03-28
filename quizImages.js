/**
 * Fase 1: dekorative quiz-bilder (Pixabay + Wikimedia Commons).
 * Ikke knyttet til fasit; modellen og generateQuiz.txt røres ikke.
 */

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const PIXABAY_API = "https://pixabay.com/api/";

const IMAGE_QUERY_STOPWORDS = new Set([
  "hva",
  "hvilket",
  "hvilken",
  "hvor",
  "når",
  "hvem",
  "hvordan",
  "hvis",
  "er",
  "som",
  "det",
  "den",
  "de",
  "en",
  "et",
  "ei",
  "for",
  "og",
  "i",
  "på",
  "til",
  "av",
  "med",
  "mot",
  "om",
  "ved",
  "inn",
  "ut",
  "ikke",
  "bare",
  "også",
  "være",
  "har",
  "hadde",
  "ble",
  "kan",
  "skal",
  "vil",
  "må",
  "år",
]);

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "gruble-quiz-api/0.1 (decorative quiz images)",
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtmlMeta(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function commonsCreditFromExtMetadata(extmetadata) {
  if (!extmetadata || typeof extmetadata !== "object") {
    return "";
  }
  const artist =
    extmetadata.Artist?.value ||
    extmetadata.Credit?.value ||
    extmetadata.Attribution?.value ||
    "";
  const license =
    extmetadata.LicenseShortName?.value ||
    extmetadata.UsageTerms?.value ||
    "";
  const parts = [];
  const a = stripHtmlMeta(artist);
  if (a) {
    parts.push(a);
  }
  if (license) {
    parts.push(String(license).trim());
  }
  parts.push("Wikimedia Commons");
  return parts.join(" — ");
}

/**
 * @typedef {Object} QuizImageCandidate
 * @property {string} url
 * @property {string} title
 * @property {'wikimedia'|'pixabay'} source
 * @property {string} credit
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [pageUrl]
 */

/**
 * Søk Wikimedia Commons (filer) og hent bilde-URL + metadata.
 */
async function searchWikimediaImageCandidates(query, limit = 6) {
  const q = String(query ?? "").trim();
  if (!q || q.length < 2) {
    return [];
  }

  const searchUrl = new URL(COMMONS_API);
  searchUrl.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: q,
    srnamespace: "6",
    srlimit: String(Math.min(15, limit + 5)),
    format: "json",
    origin: "*",
  }).toString();

  const searchPayload = await fetchJsonWithTimeout(searchUrl);
  const results = Array.isArray(searchPayload?.query?.search)
    ? searchPayload.query.search
    : [];

  const titles = results
    .map((row) => String(row?.title ?? "").trim())
    .filter((t) => t && !/\.(svg|webm|ogv|ogg|pdf)$/i.test(t))
    .slice(0, limit);

  if (!titles.length) {
    return [];
  }

  const iiUrl = new URL(COMMONS_API);
  iiUrl.search = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "960",
    format: "json",
    origin: "*",
  }).toString();

  const iiPayload = await fetchJsonWithTimeout(iiUrl);
  const pages = Object.values(iiPayload?.query?.pages ?? {});

  /** @type {QuizImageCandidate[]} */
  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const title = String(page?.title ?? "").trim();
    const ii = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
    if (!ii || !ii.mime || !String(ii.mime).startsWith("image/")) {
      continue;
    }
    const url =
      String(ii.thumburl || ii.url || "").trim() ||
      String(ii.url || "").trim();
    if (!url || !/^https:\/\//i.test(url)) {
      continue;
    }
    const credit = commonsCreditFromExtMetadata(ii.extmetadata);
    if (!credit) {
      continue;
    }
    const wikiTitle = title.replace(/ /g, "_");
    out.push({
      url,
      title: title.replace(/^File:/i, ""),
      source: "wikimedia",
      credit,
      width: typeof ii.thumbwidth === "number" ? ii.thumbwidth : ii.width,
      height: typeof ii.thumbheight === "number" ? ii.thumbheight : ii.height,
      pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(
        wikiTitle
      )}`,
    });
    if (out.length >= limit) {
      break;
    }
  }

  return out;
}

/**
 * Pixabay (krever PIXABAY_API_KEY). Trygt søk: safesearch, foto.
 */
async function searchPixabayImageCandidates(query, limit = 6) {
  const key = process.env.PIXABAY_API_KEY;
  const q = String(query ?? "").trim();
  if (!key || !q || q.length < 2) {
    return [];
  }

  const url = new URL(PIXABAY_API);
  url.search = new URLSearchParams({
    key,
    q,
    image_type: "photo",
    safesearch: "true",
    per_page: String(Math.min(20, limit + 4)),
    lang: "no",
  }).toString();

  const payload = await fetchJsonWithTimeout(url);
  const hits = Array.isArray(payload?.hits) ? payload.hits : [];

  /** @type {QuizImageCandidate[]} */
  const out = [];
  for (let i = 0; i < hits.length && out.length < limit; i += 1) {
    const h = hits[i];
    const urlHit =
      String(h?.largeImageURL || h?.webformatURL || "").trim() ||
      String(h?.previewURL || "").trim();
    if (!urlHit || !/^https:\/\//i.test(urlHit)) {
      continue;
    }
    const user = String(h?.user ?? "").trim() || "ukjent bidragsyter";
    const pageUrl = String(h?.pageURL || "https://pixabay.com").trim();
    out.push({
      url: urlHit,
      title: String(h?.tags || q)
        .split(",")[0]
        .trim()
        .slice(0, 120),
      source: "pixabay",
      credit: `Foto: ${user} / Pixabay`,
      width: h?.imageWidth,
      height: h?.imageHeight,
      pageUrl,
    });
  }

  return out;
}

/**
 * Samler kandidater fra begge kilder (felles format).
 * @param {string} query
 * @returns {Promise<QuizImageCandidate[]>}
 */
async function findImageCandidates(query) {
  const q = String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (!q || q.length < 2) {
    return [];
  }

  const [wiki, pix] = await Promise.all([
    searchWikimediaImageCandidates(q, 8).catch(() => []),
    searchPixabayImageCandidates(q, 8).catch(() => []),
  ]);

  return [...wiki, ...pix];
}

function normalizeForImageMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/** Nøkkelord til relevansscore (samme stoppord som spørsmålssøk). */
function tokenizeForImageScoring(text) {
  const raw = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\d\s]/gu, " ");
  const words = raw
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !IMAGE_QUERY_STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * Nytt: filtrer bort åpenbart generiske filnavn uten semantisk innhold.
 */
function isLikelyGenericImageTitle(title) {
  const stem = String(title ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .trim();
  if (stem.length < 5) {
    return true;
  }
  if (/^(img|dsc|p\d{3,}|dji|gopr|mvi)[\s_-]?\d*$/i.test(stem)) {
    return true;
  }
  if (/^\d+$/.test(stem)) {
    return true;
  }
  return false;
}

/**
 * Nytt: enkel relevansscore tittel mot tema + spørsmål (ingen gjetting).
 * Under minScore → kandidaten brukes ikke.
 */
function scoreImageTitleRelevance(title, theme, questionText) {
  if (isLikelyGenericImageTitle(title)) {
    return -1000;
  }
  const nt = normalizeForImageMatch(title).replace(/\s+/g, " ");
  let score = 0;

  const normTheme = normalizeForImageMatch(theme).replace(/\s+/g, " ").trim();
  if (normTheme.length >= 4 && nt.includes(normTheme)) {
    score += 6;
  }
  const themeToks = tokenizeForImageScoring(theme);
  for (let i = 0; i < themeToks.length; i += 1) {
    if (nt.includes(themeToks[i])) {
      score += 3;
    }
  }
  const qToks = tokenizeForImageScoring(questionText);
  for (let j = 0; j < qToks.length; j += 1) {
    if (nt.includes(qToks[j])) {
      score += 2;
    }
  }
  return score;
}

/**
 * Velg beste gyldige kandidat etter relevansscore (ikke bare første treff).
 * @param {QuizImageCandidate[]} candidates
 * @param {{ theme?: string, questionText?: string, minScore?: number }} context
 */
function pickBestImageCandidate(candidates, context = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }
  const theme = String(context.theme ?? "").trim();
  const questionText = String(context.questionText ?? "").trim();
  const minScore =
    typeof context.minScore === "number" ? context.minScore : 2;

  /** @type {{ c: QuizImageCandidate, score: number }[]} */
  const ranked = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (
      !c ||
      typeof c.url !== "string" ||
      !/^https:\/\//i.test(c.url) ||
      typeof c.credit !== "string" ||
      !c.credit.trim()
    ) {
      continue;
    }
    const score = scoreImageTitleRelevance(
      c.title,
      theme,
      questionText
    );
    if (score < minScore) {
      continue;
    }
    ranked.push({ c, score });
  }
  if (!ranked.length) {
    return null;
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].c;
}

/**
 * Primærsøkeord: tema, ellers første trygge oppslagstittel.
 * @param {string} theme
 * @param {{ nameTitles?: string[], context?: string }} lookup
 */
function buildPrimaryImageSearchQuery(theme, lookup) {
  const t = String(theme ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (t.length >= 2) {
    return t;
  }
  const nt = Array.isArray(lookup?.nameTitles) ? lookup.nameTitles[0] : "";
  if (typeof nt === "string" && nt.trim().length >= 2) {
    return nt.trim().slice(0, 80);
  }
  return "";
}

function extractKeywordsFromQuestion(questionText, maxWords = 4) {
  const raw = String(questionText ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\d\s]/gu, " ");
  const words = raw
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 3 && !IMAGE_QUERY_STOPWORDS.has(w));
  return words.slice(0, maxWords).join(" ").trim();
}

function buildQuestionImageSearchQuery(theme, lookup, questionText) {
  const primary = buildPrimaryImageSearchQuery(theme, lookup);
  const kw = extractKeywordsFromQuestion(questionText, 4);
  if (kw.length >= 4) {
    return kw.slice(0, 120);
  }
  if (primary && kw) {
    return `${primary} ${kw}`.trim().slice(0, 120);
  }
  return primary || kw || "";
}

/**
 * Enkel heuristikk: delt bilde når tema er smalt eller spørsmålene ofte nevner temaord.
 */
function isQuizCohesiveForSharedImage(theme, questions) {
  const t = String(theme ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!t) {
    return false;
  }
  const themeWords = t.split(" ").filter((w) => w.length >= 3);
  if (themeWords.length === 1) {
    return true;
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return false;
  }
  let hits = 0;
  for (let i = 0; i < questions.length; i += 1) {
    const qt = String(questions[i]?.question ?? "").toLowerCase();
    if (themeWords.some((w) => qt.includes(w))) {
      hits += 1;
    }
  }
  return hits >= Math.ceil(questions.length * 0.65);
}

/**
 * @param {string} theme
 * @param {object} lookup resultat fra maybeBuildThemeLookupSupport
 * @param {object[]} questions (med answer — ikke brukt her)
 * @returns {Promise<{ questions: object[], sharedImage: QuizImageCandidate | null }>}
 */
async function attachDecorativeQuizImages(theme, lookup, questions) {
  const log = (line) => console.log(`[quiz image] ${line}`);

  const primaryQuery = buildPrimaryImageSearchQuery(theme, lookup);
  log(`query=${JSON.stringify(primaryQuery || "")}`);

  const cohesive = isQuizCohesiveForSharedImage(theme, questions);

  if (cohesive && primaryQuery) {
    const candidates = await findImageCandidates(primaryQuery);
    const best = pickBestImageCandidate(candidates, {
      theme,
      questionText: "",
    });
    if (best) {
      log(`source=${best.source}`);
      log(`pickedTitle=${JSON.stringify(best.title)}`);
      log("mode=shared");
      const shared = {
        url: best.url,
        title: best.title,
        source: best.source,
        credit: best.credit,
        width: best.width,
        height: best.height,
        pageUrl: best.pageUrl,
      };
      /** Delt bilde kun på quiz-nivå — ikke dupliser på hvert spørsmål i lagring. */
      const withQ = questions.map((q) => {
        const { image, ...rest } = q;
        return rest;
      });
      return { questions: withQ, sharedImage: shared };
    }
    if (candidates.length > 0) {
      log("relevance=no candidate met minScore (shared)");
    }
    log("mode=none (cohesive, no acceptable shared hit)");
    const bare = questions.map((q) => {
      const { image, ...rest } = q;
      return rest;
    });
    return { questions: bare, sharedImage: null };
  }

  log(`mode=per-question cohesive=${cohesive ? "true" : "false"}`);
  /** @type {object[]} */
  const out = [];
  for (let i = 0; i < questions.length; i += 1) {
    const qq = questions[i];
    const qry = buildQuestionImageSearchQuery(
      theme,
      lookup,
      qq?.question ?? ""
    );
    log(`query=${JSON.stringify(qry || "")} questionIndex=${i}`);
    if (!qry) {
      const { image, ...rest } = qq;
      out.push(rest);
      continue;
    }
    const candidates = await findImageCandidates(qry);
    const best = pickBestImageCandidate(candidates, {
      theme,
      questionText: String(qq?.question ?? ""),
    });
    if (best) {
      log(`source=${best.source} questionIndex=${i}`);
      log(`pickedTitle=${JSON.stringify(best.title)}`);
      out.push({
        ...qq,
        image: {
          url: best.url,
          title: best.title,
          source: best.source,
          credit: best.credit,
          width: best.width,
          height: best.height,
          pageUrl: best.pageUrl,
        },
      });
    } else {
      if (candidates.length > 0) {
        log(`relevance=no candidate met minScore questionIndex=${i}`);
      }
      const { image, ...rest } = qq;
      out.push(rest);
    }
  }

  const any = out.some((q) => q && q.image);
  log(any ? "mode=per-question" : "mode=none");
  return { questions: out, sharedImage: null };
}

/**
 * Støtter eldre rader: questions kolonnen er enten et array eller { sharedImage, questions }.
 */
function normalizeQuizQuestionsFromDb(raw) {
  if (Array.isArray(raw)) {
    return { sharedImage: null, questions: raw };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.questions)) {
    return {
      sharedImage:
        raw.sharedImage && typeof raw.sharedImage === "object"
          ? raw.sharedImage
          : null,
      questions: raw.questions,
    };
  }
  return { sharedImage: null, questions: [] };
}

function serializeQuizForStorage(sharedImage, questions) {
  return JSON.stringify({
    sharedImage: sharedImage && typeof sharedImage === "object" ? sharedImage : null,
    questions,
  });
}

module.exports = {
  findImageCandidates,
  attachDecorativeQuizImages,
  normalizeQuizQuestionsFromDb,
  serializeQuizForStorage,
};

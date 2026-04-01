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

async function fetchJsonWithTimeout(url, timeoutMs = 5500) {
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

function logWikimedia(line) {
  console.log(`[quiz image][wikimedia] ${line}`);
}

/**
 * Søk Wikimedia Commons (filer) og hent bilde-URL + metadata.
 */
async function searchWikimediaImageCandidates(query, limit = 6) {
  const q = String(query ?? "").trim();
  if (!q || q.length < 2) {
    logWikimedia(`query=${JSON.stringify(q)} rawResults=0 reason=emptyOrShortQuery`);
    return [];
  }

  logWikimedia(
    `query=${JSON.stringify(q)} api=${COMMONS_API} srnamespace=6 (File:)`
  );

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

  let searchPayload;
  try {
    searchPayload = await fetchJsonWithTimeout(searchUrl);
  } catch (e) {
    logWikimedia(
      `rawResults=0 reason=searchFetchError msg=${JSON.stringify(String(e?.message || e))}`
    );
    return [];
  }

  if (searchPayload?.error) {
    logWikimedia(
      `rawResults=0 reason=apiError code=${searchPayload.error.code ?? "?"} info=${JSON.stringify(String(searchPayload.error.info ?? ""))}`
    );
    return [];
  }

  const results = Array.isArray(searchPayload?.query?.search)
    ? searchPayload.query.search
    : [];

  const rawCount = results.length;
  logWikimedia(`rawResults=${rawCount}`);

  const sampleRaw = results
    .slice(0, 3)
    .map((row) => String(row?.title ?? "").trim())
    .filter(Boolean);
  if (sampleRaw.length) {
    logWikimedia(`sampleRawTitles=${JSON.stringify(sampleRaw)}`);
  }

  const titles = results
    .map((row) => String(row?.title ?? "").trim())
    .filter((t) => t && !/\.(svg|webm|ogv|ogg|pdf)$/i.test(t))
    .slice(0, limit);

  logWikimedia(`afterExtensionFilter=${titles.length}`);

  if (!titles.length) {
    if (rawCount > 0) {
      logWikimedia(
        "filteredResults=0 reason=noTitlesAfterExtensionOrEmptyTitles"
      );
    } else {
      logWikimedia("filteredResults=0 reason=zeroSearchHits");
    }
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

  let iiPayload;
  try {
    iiPayload = await fetchJsonWithTimeout(iiUrl);
  } catch (e) {
    logWikimedia(
      `filteredResults=0 reason=imageinfoFetchError msg=${JSON.stringify(String(e?.message || e))}`
    );
    return [];
  }

  if (iiPayload?.error) {
    logWikimedia(
      `filteredResults=0 reason=imageinfoApiError code=${iiPayload.error.code ?? "?"}`
    );
    return [];
  }

  const pages = Object.values(iiPayload?.query?.pages ?? {});

  /** @type {QuizImageCandidate[]} */
  const out = [];
  let skipNotImage = 0;
  let skipNoHttpsUrl = 0;
  let skipNoCredit = 0;
  let skipMissingImageinfo = 0;

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const title = String(page?.title ?? "").trim();
    const ii = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
    if (!ii) {
      skipMissingImageinfo += 1;
      continue;
    }
    if (!ii.mime || !String(ii.mime).startsWith("image/")) {
      skipNotImage += 1;
      continue;
    }
    const url =
      String(ii.thumburl || ii.url || "").trim() ||
      String(ii.url || "").trim();
    if (!url || !/^https:\/\//i.test(url)) {
      skipNoHttpsUrl += 1;
      continue;
    }
    const credit = commonsCreditFromExtMetadata(ii.extmetadata);
    if (!credit) {
      skipNoCredit += 1;
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

  logWikimedia(
    `filteredResults=${out.length} skipNotImage=${skipNotImage} skipNoHttpsUrl=${skipNoHttpsUrl} skipNoCredit=${skipNoCredit} skipMissingImageinfo=${skipMissingImageinfo}`
  );
  if (out.length === 0 && titles.length > 0) {
    logWikimedia(
      "reason=allCandidatesDroppedInImageinfoLoop (see skip* counts)"
    );
  }

  return out;
}

function logPixabay(line) {
  console.log(`[quiz image][pixabay] ${line}`);
}

/**
 * Pixabay (krever PIXABAY_API_KEY). Trygt søk: safesearch, foto.
 */
async function searchPixabayImageCandidates(query, limit = 6) {
  const key = process.env.PIXABAY_API_KEY;
  const q = String(query ?? "").trim();
  if (!key) {
    logPixabay(
      `query=${JSON.stringify(q)} results=0 reason=no_PIXABAY_API_KEY`
    );
    return [];
  }
  if (!q || q.length < 2) {
    logPixabay(`query=${JSON.stringify(q)} results=0 reason=emptyOrShortQuery`);
    return [];
  }

  logPixabay(`query=${JSON.stringify(q)}`);

  const url = new URL(PIXABAY_API);
  url.search = new URLSearchParams({
    key,
    q,
    image_type: "photo",
    safesearch: "true",
    per_page: String(Math.min(20, limit + 4)),
    lang: "no",
  }).toString();

  let payload;
  try {
    payload = await fetchJsonWithTimeout(url);
  } catch (e) {
    logPixabay(
      `results=0 reason=fetchError msg=${JSON.stringify(String(e?.message || e))}`
    );
    return [];
  }

  const hits = Array.isArray(payload?.hits) ? payload.hits : [];
  logPixabay(`results=${hits.length}`);

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
        .trim()
        .slice(0, 200),
      source: "pixabay",
      credit: `Foto: ${user} / Pixabay`,
      width: h?.imageWidth,
      height: h?.imageHeight,
      pageUrl,
    });
  }

  logPixabay(`acceptedAfterFilter=${out.length}`);
  return out;
}

/**
 * Sikrer felles QuizImageCandidate-form; ugyldige droppes.
 * @param {unknown} c
 * @returns {QuizImageCandidate | null}
 */
function normalizeQuizImageCandidate(c) {
  if (!c || typeof c !== "object") {
    return null;
  }
  const url = String(c.url ?? "").trim();
  if (!url || !/^https:\/\//i.test(url)) {
    return null;
  }
  const source = c.source;
  if (source !== "wikimedia" && source !== "pixabay") {
    return null;
  }
  const credit = String(c.credit ?? "").trim();
  if (!credit) {
    return null;
  }
  return {
    url,
    title: String(c.title ?? "").trim().slice(0, 200),
    source,
    credit,
    width: typeof c.width === "number" ? c.width : undefined,
    height: typeof c.height === "number" ? c.height : undefined,
    pageUrl:
      typeof c.pageUrl === "string" && c.pageUrl.trim()
        ? c.pageUrl.trim()
        : undefined,
  };
}

/**
 * Parallellsøk Wikimedia + Pixabay (eller kun Wikimedia med options.wikimediaOnly).
 * @param {string} query
 * @param {{ wikimediaOnly?: boolean } | null} [options]
 * @returns {Promise<{ wiki: QuizImageCandidate[], pix: QuizImageCandidate[], merged: QuizImageCandidate[] }>}
 */
async function fetchImageCandidatesFromBothSources(query, options = null) {
  const q = String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  if (!q || q.length < 2) {
    logWikimedia(`query="" rawResults=0 reason=skippedShortQueryAtBatch`);
    logPixabay(`query="" results=0 reason=skippedShortQueryAtBatch`);
    return { wiki: [], pix: [], merged: [] };
  }

  const wikimediaOnly =
    options && typeof options === "object" && options.wikimediaOnly === true;

  const [wikiRaw, pixRaw] = await Promise.all([
    searchWikimediaImageCandidates(q, 8).catch((e) => {
      logWikimedia(
        `filteredResults=0 reason=unhandledError msg=${JSON.stringify(String(e?.message || e))}`
      );
      return [];
    }),
    wikimediaOnly
      ? Promise.resolve([])
      : searchPixabayImageCandidates(q, 8).catch((e) => {
          logPixabay(
            `results=0 reason=unhandledError msg=${JSON.stringify(String(e?.message || e))}`
          );
          return [];
        }),
  ]);

  /** @type {QuizImageCandidate[]} */
  const wiki = [];
  for (let i = 0; i < wikiRaw.length; i += 1) {
    const n = normalizeQuizImageCandidate(wikiRaw[i]);
    if (n) {
      wiki.push(n);
    }
  }
  /** @type {QuizImageCandidate[]} */
  const pix = [];
  for (let j = 0; j < pixRaw.length; j += 1) {
    const n = normalizeQuizImageCandidate(pixRaw[j]);
    if (n) {
      pix.push(n);
    }
  }

  const merged = [...wiki, ...pix];
  console.log(
    `[quiz image][merge] query=${JSON.stringify(q)} wikimedia_only=${wikimediaOnly ? "true" : "false"} candidates wiki=${wiki.length} pixabay=${pix.length} merged=${merged.length}`
  );
  return { wiki, pix, merged };
}

/**
 * Lett kildevekting ut fra tema — påvirker bare tie-break og nær scoring, ingen automatisk seier.
 * @param {'wikimedia'|'pixabay'} source
 * @param {string} theme
 * @returns {{ bonus: number, reasons: string[] }}
 */
function getImageSourceBonusForCandidate(source, theme) {
  const t = String(theme ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const words = t.split(" ").filter(Boolean);
  let wikiBonus = 0;
  const wikiReasons = [];
  let pixBonus = 0;
  const pixReasons = [];

  if (words.length >= 2) {
    wikiBonus += 1.5;
    wikiReasons.push("flere ord i tema (+1.5 mot Wikimedia-relevans)");
  }

  if (
    /\b(historie|historisk|geografi|krig|krigen|slott|kirke|katedral|museum|monument|viking|middelalder|århundre|århundrer|fylke|kommune|nasjonal|unesco|storting|regjering|president|statsminister|kong|dronning|keiser|biografi|født|død|person|personer|skuespiller|forfatter|kunstner|musiker|vitenskapsmann|oppfinner|politiker)\b/i.test(
      t
    )
  ) {
    wikiBonus += 1.5;
    wikiReasons.push("sted/historie/person (+1.5 Wikimedia-tilt)");
  }

  wikiBonus = Math.min(wikiBonus, 3);

  if (words.length === 1 && words[0].length >= 3 && words[0].length <= 16) {
    pixBonus += 1.5;
    pixReasons.push("ettords tema (+1.5 Pixabay-tilt)");
  }
  if (words.length === 1 && words[0].length >= 3 && words[0].length <= 8) {
    pixBonus += 0.5;
    pixReasons.push("kort ettords tema (+0.5 Pixabay)");
  }
  if (
    /\b(natur|landskap|solnedgang|stemning|hobby|matlaging|mat\b|baking|blomster|dekorasjon|farger|abstrakt|bakgrunn|tekstur|mønster|sesong|sommer|vinter|vår|høst|sport|trening|velvære|feiring)\b/i.test(
      t
    )
  ) {
    pixBonus += 1.5;
    pixReasons.push("generelt/dekorativt tema (+1.5 Pixabay-tilt)");
  }
  pixBonus = Math.min(pixBonus, 3);

  if (source === "wikimedia") {
    return { bonus: wikiBonus, reasons: wikiReasons };
  }
  if (source === "pixabay") {
    return { bonus: pixBonus, reasons: pixReasons };
  }
  return { bonus: 0, reasons: [] };
}

/**
 * Søk begge kilder parallelt; returnerer normalisert, flettet kandidatliste.
 * @param {string} query
 * @returns {Promise<QuizImageCandidate[]>}
 */
async function findImageCandidates(query) {
  const { merged } = await fetchImageCandidatesFromBothSources(query);
  return merged;
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
 * Foretrekk landskap (bredde ≥ høyde) for å redusere brede «bokser» ved object-fit: contain.
 * Ukjente dimensjoner → nøytralt (0).
 */
function orientationScoreForQuizImage(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 0;
  }
  const ratio = w / h;
  if (ratio >= 1.05) {
    return 4 + Math.min(3, Math.floor((ratio - 1) * 4));
  }
  if (ratio <= 0.95) {
    return -5 - Math.min(4, Math.floor((1 / ratio - 1) * 3));
  }
  return 1;
}

/**
 * Velg beste kandidat på tvers av kilder: tittel-relevans + lett kildebonus.
 * @param {QuizImageCandidate[]} candidates
 * @param {{ theme?: string, questionText?: string, minScore?: number }} context
 * @returns {{ candidate: QuizImageCandidate | null, meta: object | null }}
 */
function pickBestImageCandidateWithScore(candidates, context = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { candidate: null, meta: null };
  }
  const theme = String(context.theme ?? "").trim();
  const questionText = String(context.questionText ?? "").trim();
  const minScore =
    typeof context.minScore === "number" ? context.minScore : 1;

  /** @type {{ c: QuizImageCandidate, base: number, bonus: number, total: number, reasons: string[] }[]} */
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
    const base = scoreImageTitleRelevance(c.title, theme, questionText);
    if (base < minScore) {
      continue;
    }
    const { bonus, reasons } = getImageSourceBonusForCandidate(
      c.source,
      theme
    );
    const orient = orientationScoreForQuizImage(c.width, c.height);
    ranked.push({
      c,
      base,
      bonus,
      orient,
      total: base + bonus + orient,
      reasons,
    });
  }
  if (!ranked.length) {
    return { candidate: null, meta: null };
  }
  ranked.sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total;
    }
    if (b.base !== a.base) {
      return b.base - a.base;
    }
    if (b.orient !== a.orient) {
      return b.orient - a.orient;
    }
    /* Ingen kildefavoritt ved uavgjort — bruk innhold (tittel), ikke source-navn. */
    return String(a.c.title ?? "").localeCompare(String(b.c.title ?? ""), "nb", {
      sensitivity: "base",
    });
  });
  const top = ranked[0];
  const second = ranked[1];
  const margin =
    second != null ? Number((top.total - second.total).toFixed(2)) : null;
  const winnerReasonParts = [
    `kilde=${top.c.source}`,
    `total=${top.total} (relevans=${top.base} + kildebonus=${top.bonus} + orient=${top.orient})`,
  ];
  if (top.reasons.length) {
    winnerReasonParts.push(`kildebonus: ${top.reasons.join(", ")}`);
  }
  if (second != null) {
    winnerReasonParts.push(
      `foran nr.2: ${second.c.source} total=${second.total}${margin != null && margin > 0 ? ` (margin ${margin})` : ""}`
    );
  } else {
    winnerReasonParts.push("ingen annen godkjent kandidat");
  }
  const winnerReason = winnerReasonParts.join(" | ");

  return {
    candidate: top.c,
    meta: {
      baseScore: top.base,
      sourceBonus: top.bonus,
      totalScore: top.total,
      bonusReasons: top.reasons,
      winnerReason,
      runnerUp: second
        ? {
            source: second.c.source,
            totalScore: second.total,
            baseScore: second.base,
            sourceBonus: second.bonus,
            titleSnippet: String(second.c.title ?? "").slice(0, 60),
          }
        : null,
    },
  };
}

/**
 * Bakoverkompatibel: returnerer bare vinner-kandidat.
 * @param {QuizImageCandidate[]} candidates
 * @param {{ theme?: string, questionText?: string, minScore?: number }} context
 */
function pickBestImageCandidate(candidates, context = {}) {
  return pickBestImageCandidateWithScore(candidates, context).candidate;
}

/**
 * Prøv strengere minScore først, deretter 1 og 0 (slik at vi oftere får bilde uten å droppe helt trygge kandidater).
 * @param {QuizImageCandidate[]} candidates
 * @param {{ theme?: string, questionText?: string, minScore?: number }} context
 */
function pickBestImageCandidateWithTiers(candidates, context = {}) {
  const preferred =
    typeof context.minScore === "number" ? context.minScore : 1;
  const tail = preferred > 1 ? [1, 0] : [0];
  const tiers = [preferred, ...tail].filter(
    (v, i, arr) =>
      typeof v === "number" && v >= 0 && arr.indexOf(v) === i
  );
  for (let t = 0; t < tiers.length; t += 1) {
    const res = pickBestImageCandidateWithScore(candidates, {
      ...context,
      minScore: tiers[t],
    });
    if (res.candidate) {
      return res;
    }
  }
  return { candidate: null, meta: null };
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
  return hits >= Math.ceil(questions.length * 0.5);
}

/**
 * @param {string} theme
 * @param {object} lookup resultat fra maybeBuildThemeLookupSupport
 * @param {object[]} questions (med answer — ikke brukt her)
 * @returns {Promise<{ questions: object[], sharedImage: QuizImageCandidate | null }>}
 */
async function attachDecorativeQuizImages(theme, lookup, questions) {
  const log = (line) => console.log(`[quiz image] ${line}`);

  log(
    `attachDecorativeQuizImages called questionCount=${Array.isArray(questions) ? questions.length : 0}`
  );

  const primaryQuery = buildPrimaryImageSearchQuery(theme, lookup);
  log(`query=${JSON.stringify(primaryQuery || "")}`);

  const cohesive = isQuizCohesiveForSharedImage(theme, questions);
  log(`cohesiveForSharedImage=${cohesive ? "true" : "false"}`);
  const sharedQuestionContext = Array.isArray(questions)
    ? questions
        .map((q) => String(q?.question ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 500)
    : "";

  if (cohesive && primaryQuery) {
    const { wiki, pix, merged } =
      await fetchImageCandidatesFromBothSources(primaryQuery);
    const { candidate: best, meta: pickMeta } =
      pickBestImageCandidateWithTiers(merged, {
        theme,
        questionText: sharedQuestionContext,
        minScore: 1,
      });
    const candidatesCount = merged.length;
    log(
      `candidates wiki=${wiki.length} pixabay=${pix.length} merged=${candidatesCount}`
    );
    log(`chosenSource=${best ? best.source : "none"}`);
    if (best && pickMeta) {
      log(
        `picked scores base=${pickMeta.baseScore} sourceBonus=${pickMeta.sourceBonus} total=${pickMeta.totalScore} reasons=${JSON.stringify(pickMeta.bonusReasons.join("; ") || "ingen kildebonus")}`
      );
      log(`winner=${JSON.stringify(pickMeta.winnerReason)}`);
      if (pickMeta.runnerUp) {
        log(
          `runnerUp source=${pickMeta.runnerUp.source} total=${pickMeta.runnerUp.totalScore} base=${pickMeta.runnerUp.baseScore} bonus=${pickMeta.runnerUp.sourceBonus} title=${JSON.stringify(pickMeta.runnerUp.titleSnippet)}`
        );
      }
    }
    if (best) {
      log(`pickedTitle=${JSON.stringify(best.title)}`);
      log("sharedImage assigned=true");
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
    if (candidatesCount > 0) {
      log(
        `relevance=no candidate met minScore (shared) questionContextChars=${sharedQuestionContext.length} minScore=1`
      );
    }
    log("sharedImage assigned=false");
    log("mode=shared-fallback-to-per-question");
  }

  log(`mode=per-question cohesive=${cohesive ? "true" : "false"}`);
  const perQuestionResults = await Promise.all(
    questions.map(async (qq, i) => {
      const qry = buildQuestionImageSearchQuery(
        theme,
        lookup,
        qq?.question ?? ""
      );
      log(`query=${JSON.stringify(qry || "")} questionIndex=${i}`);
      if (!qry) {
        const { image, ...rest } = qq;
        return { index: i, row: rest, candidatesCount: 0, pickMeta: null };
      }
      const { wiki, pix, merged } =
        await fetchImageCandidatesFromBothSources(qry);
      const { candidate: best, meta: pickMeta } =
        pickBestImageCandidateWithTiers(merged, {
          theme,
          questionText: String(qq?.question ?? ""),
        });
      const candidatesCount = merged.length;
      log(
        `candidates wiki=${wiki.length} pixabay=${pix.length} merged=${candidatesCount} questionIndex=${i}`
      );
      log(`chosenSource=${best ? best.source : "none"} questionIndex=${i}`);
      if (best && pickMeta) {
        log(
          `picked scores base=${pickMeta.baseScore} sourceBonus=${pickMeta.sourceBonus} total=${pickMeta.totalScore} reasons=${JSON.stringify(pickMeta.bonusReasons.join("; ") || "ingen kildebonus")} questionIndex=${i}`
        );
        log(`winner=${JSON.stringify(pickMeta.winnerReason)} questionIndex=${i}`);
        if (pickMeta.runnerUp) {
          log(
            `runnerUp source=${pickMeta.runnerUp.source} total=${pickMeta.runnerUp.totalScore} base=${pickMeta.runnerUp.baseScore} bonus=${pickMeta.runnerUp.sourceBonus} title=${JSON.stringify(pickMeta.runnerUp.titleSnippet)} questionIndex=${i}`
          );
        }
      }
      if (best) {
        log(`pickedTitle=${JSON.stringify(best.title)}`);
        return {
          index: i,
          row: {
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
          },
          candidatesCount,
          pickMeta,
        };
      }
      if (candidatesCount > 0) {
        log(`relevance=no candidate met minScore questionIndex=${i}`);
      }
      const { image, ...rest } = qq;
      return { index: i, row: rest, candidatesCount, pickMeta: null };
    })
  );

  perQuestionResults.sort((a, b) => a.index - b.index);
  const out = perQuestionResults.map((r) => r.row);

  const withImg = out.filter((q) => q && q.image).length;
  log(`questionImage assigned count=${withImg}`);
  const any = withImg > 0;
  log(any ? "mode=per-question" : "mode=none");
  log("sharedImage assigned=false");
  return { questions: out, sharedImage: null };
}

/**
 * Velg ett delt illustrasjonsbilde (Commons/Pixabay) uten per-spørsmålsrunde.
 * Brukes av visual-10-varianten; grunnmotorens attachDecorativeQuizImages er uendret.
 */
/**
 * @param {string} theme
 * @param {object} lookup
 * @param {string} [questionContextText]
 * @param {{ wikimediaOnly?: boolean } | null} [options] — kun Commons (for metadata-basert spørsmål 10).
 */
async function pickSharedDecorativeImage(
  theme,
  lookup,
  questionContextText = "",
  options = null
) {
  const primaryQuery = buildPrimaryImageSearchQuery(theme, lookup);
  const q = String(primaryQuery ?? "").trim();
  if (!q || q.length < 2) {
    return null;
  }
  const ctx = String(questionContextText ?? "")
    .trim()
    .slice(0, 500);
  const { merged } = await fetchImageCandidatesFromBothSources(q, options);
  if (!merged.length) {
    return null;
  }
  const { candidate } = pickBestImageCandidateWithTiers(merged, {
    theme,
    questionText: ctx,
    minScore: 1,
  });
  if (!candidate) {
    return null;
  }
  return {
    url: candidate.url,
    title: candidate.title,
    source: candidate.source,
    credit: candidate.credit,
    width: candidate.width,
    height: candidate.height,
    pageUrl: candidate.pageUrl,
  };
}

/**
 * Støtter eldre rader: questions kolonnen er enten et array eller { sharedImage, questions }.
 */
function normalizeQuizQuestionsFromDb(raw) {
  const variant =
    raw && typeof raw === "object" && typeof raw.variant === "string"
      ? raw.variant.trim()
      : null;
  if (Array.isArray(raw)) {
    return { sharedImage: null, questions: raw, variant: null };
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.questions)) {
    return {
      sharedImage:
        raw.sharedImage && typeof raw.sharedImage === "object"
          ? raw.sharedImage
          : null,
      questions: raw.questions,
      variant,
    };
  }
  return { sharedImage: null, questions: [], variant: null };
}

function serializeQuizForStorage(sharedImage, questions, extra = null) {
  const base = {
    sharedImage: sharedImage && typeof sharedImage === "object" ? sharedImage : null,
    questions,
  };
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    return JSON.stringify({ ...base, ...extra });
  }
  return JSON.stringify(base);
}

module.exports = {
  findImageCandidates,
  attachDecorativeQuizImages,
  pickSharedDecorativeImage,
  normalizeQuizQuestionsFromDb,
  serializeQuizForStorage,
};

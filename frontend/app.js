const API_BASE = "https://gruble-quiz-api.onrender.com";

const VOICE_SVG_MIC = `<svg class="voice-mic-btn__svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6.2 6.72V21h2v-3.28c3.48-.49 6.2-3.31 6.2-6.72h-1.7z"/></svg>`;

const VOICE_SVG_STOP = `<svg class="voice-mic-btn__svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6V6z"/></svg>`;

const MAX_PROTEST_USER_MESSAGES = 5;

/**
 * @typedef {Object} ProtestMessageSegment
 * @property {'user'|'assistant'|'system'} kind
 * @property {string} innerHtml
 */

/**
 * @typedef {Object} ProtestStateFinalized
 * @property {'finalized'} status
 */

/**
 * @typedef {Object} ProtestStateActive
 * @property {'active'} status
 * @property {'form'|'chat'} phase
 * @property {string|null} protestType valgt type etter første vellykkede sending
 * @property {number} userMessageCount antall brukermeldinger sendt i tråden
 * @property {ProtestMessageSegment[]} messages trådinnhold (kun i minnet til siden lastes på nytt)
 */

/** @type {Record<string, ProtestStateFinalized | ProtestStateActive>} */
const state = {
  theme: "",
  questions: [],
  currentIndex: 0,
  totalScore: 0,
  byId: {},
  protestStateByQuestionId: {},
};

const app = document.getElementById("app");

/** Inline spinnere for ventetilstand (generering, innsending, sjekk). */
function loadingSpinnerMarkup() {
  return '<span class="loading-spinner" role="status" aria-label="Laster"></span>';
}

function loadingInlineRow(text) {
  return `<div class="loading-inline">${loadingSpinnerMarkup()}<span>${text}</span></div>`;
}

let protestTargetQuestion = null;
let protestSubmitInFlight = false;

/** Gjeldende aktiv protest (peker inn i state.protestStateByQuestionId når status === 'active') */
let protestSession = null;

function shuffleArray(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function shuffleQuizOptions(questions) {
  return questions.map((q) => {
    if (!q || !Array.isArray(q.options)) {
      return q;
    }
    return { ...q, options: shuffleArray(q.options) };
  });
}

function getQuestionState(questionId) {
  const key = String(questionId);
  if (!state.byId[key]) {
    state.byId[key] = {
      answerMode: null,
      removedOptions: [],
      answered: false,
      lastFeedback: null,
      submittedAnswer: null,
      checkingQuestion: false,
      mcSubmitting: false,
      writtenSubmitting: false,
      infoMessage: "",
      infoClass: "hint",
      underRevision: false,
      removedFromSession: false,
    };
  }
  return state.byId[key];
}

function protestRemovesQuestionFromSession(status) {
  const s = String(status ?? "").toLowerCase();
  return s === "approved" || s === "partial";
}

function applyProtestRevisionSuccess(questionId) {
  const qs = getQuestionState(questionId);
  qs.underRevision = true;
  qs.removedFromSession = true;
  qs.answered = true;
  state.protestStateByQuestionId[String(questionId)] = { status: "finalized" };
  protestSession = null;
}

function normalizeAnswerText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fjerner deltakers svar fra starten av vurderingstekst når det allerede vises over streken.
 * Håndterer f.eks. «Du svarte: <svar>.» før selve vurderingen.
 */
function stripAnswerPrefixFromFeedback(answer, feedback) {
  const answerRaw = String(answer ?? "").trim();
  const original = String(feedback ?? "").trim();
  if (!answerRaw || !original) {
    return original;
  }

  const answerNorm = normalizeAnswerText(answerRaw);
  const answerLead = new RegExp(
    "^" + escapeRegExp(answerRaw) + "\\s*[.!?:,;\\-–—]*\\s*",
    "i"
  );

  let s = original;
  const metaPrefix =
    /^(du\s+svarte|du\s+skrev|ditt\s+svar|her\s+(?:er|var)\s+ditt\s+svar)\s*:\s*/i;
  const meta = s.match(metaPrefix);
  if (meta) {
    s = s.slice(meta[0].length).trim();
  }
  s = s.replace(/^[«"'"„]+/, "").trim();

  const afterAnswer = s
    .replace(answerLead, "")
    .trim()
    .replace(/^[«"'"„]+/, "")
    .trim();
  if (afterAnswer.length > 0 && afterAnswer.length < s.length) {
    return afterAnswer;
  }

  if (normalizeAnswerText(s).startsWith(answerNorm) && s.length >= answerRaw.length) {
    let stripped = s.slice(answerRaw.length).trim();
    stripped = stripped.replace(/^[\s:;,\-.!?")\]]+/, "").trim();
    if (stripped.length > 0) {
      return stripped;
    }
  }

  if (normalizeAnswerText(original).startsWith(answerNorm)) {
    let stripped = original.slice(answerRaw.length).trim();
    stripped = stripped.replace(/^[\s:;,\-.!?")\]]+/, "").trim();
    if (stripped.length > 0) {
      return stripped;
    }
  }

  return original;
}

function showProtestRevisionOutcomeInModal(protestPointsAwarded) {
  document.getElementById("protest-finalized-view")?.classList.add("protest-block--hidden");
  document.getElementById("protest-active-view")?.classList.add("protest-block--hidden");
  document.getElementById("protest-revision-view")?.classList.remove("protest-block--hidden");
  const ptsEl = document.getElementById("protest-revision-points");
  if (ptsEl) {
    const n = Number(protestPointsAwarded);
    const display = Number.isFinite(n) ? n : 0;
    ptsEl.textContent =
      display === 1
        ? "Du får 1 poeng for denne protesten."
        : `Du får ${display} poeng for denne protesten.`;
  }
}

function advanceToNextPlayableQuestion() {
  let next = state.currentIndex + 1;
  while (next < state.questions.length) {
    const q = state.questions[next];
    if (!getQuestionState(q.id).underRevision) {
      state.currentIndex = next;
      render();
      return;
    }
    next += 1;
  }
  render();
}

async function loadQuiz() {
  app.innerHTML = loadingInlineRow("Laster quiz…");
  try {
    const response = await fetch(`${API_BASE}/api/quiz/today`);
    if (!response.ok) {
      app.innerHTML = "<p>Kunne ikke laste quiz.</p>";
      return false;
    }
    const data = await response.json();

    state.theme = data.theme || "";
    const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
    state.questions = shuffleQuizOptions(rawQuestions);
    state.currentIndex = 0;
    state.totalScore = 0;
    state.byId = {};
    state.protestStateByQuestionId = {};
    protestSession = null;

    render();
    return true;
  } catch (error) {
    app.innerHTML = "<p>Kunne ikke laste quiz.</p>";
    return false;
  }
}

async function generateNewQuiz() {
  const btn = document.getElementById("generate-quiz-button");
  const statusEl = document.getElementById("generate-status");
  const themeInput = document.getElementById("generate-theme-input");
  const raw = (themeInput?.value ?? "").trim();
  const theme = raw || "Diverse";

  if (!btn || !statusEl) {
    return;
  }

  if (raw) {
    if (raw.length > 50) {
      statusEl.textContent = "Feilet: Tema er for langt (maks 50 tegn).";
      return;
    }
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length > 3) {
      statusEl.textContent = "Feilet: Tema kan ha maks 3 ord.";
      return;
    }
  }

  btn.disabled = true;
  statusEl.innerHTML = `${loadingSpinnerMarkup()}<span> Genererer quiz…</span>`;
  statusEl.classList.add("generate-status--loading");

  try {
    const res = await fetch(`${API_BASE}/api/internal/generate-test-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        typeof body.error === "string"
          ? body.error
          : res.statusText || "Forespørsel feilet";
      throw new Error(msg);
    }

    statusEl.classList.remove("generate-status--loading");
    statusEl.innerHTML = `${loadingSpinnerMarkup()}<span> Laster oppdatert quiz…</span>`;
    statusEl.classList.add("generate-status--loading");
    const loaded = await loadQuiz();
    statusEl.classList.remove("generate-status--loading");
    statusEl.textContent = loaded
      ? ""
      : "Quiz ble lagret, men kunne ikke hente dagens quiz.";
  } catch (err) {
    const msg =
      err && typeof err.message === "string" ? err.message : "Ukjent feil";
    statusEl.classList.remove("generate-status--loading");
    statusEl.textContent = "Feilet: " + msg;
  } finally {
    btn.disabled = false;
  }
}

function render() {
  if (!state.questions.length) {
    app.innerHTML = "<p>Ingen quiz tilgjengelig.</p>";
    return;
  }

  const question = state.questions[state.currentIndex];
  const qs = getQuestionState(question.id);
  const isLast = state.currentIndex === state.questions.length - 1;
  const revisionMode = Boolean(qs.underRevision);

  let answerBlock = "";
  let resultText = "";
  let resultClass = "result";

  if (revisionMode) {
    answerBlock = "";
    resultClass = "result hint";
    resultText = "";
  } else if (qs.answered && qs.lastFeedback && qs.lastFeedback.networkError) {
    resultClass = "result wrong";
    resultText =
      qs.answerMode === "mc" ? "" : "Kunne ikke sende inn svar.";
  } else if (qs.answered && qs.lastFeedback) {
    resultClass += qs.lastFeedback.correct ? " correct" : " wrong";
    const pts = qs.lastFeedback.points;
    if (qs.answerMode === "written" || qs.answerMode === "mc") {
      resultText = "";
    } else {
      resultText = qs.lastFeedback.correct
        ? `Riktig svar. Poeng for spørsmålet: ${pts}`
        : `Feil svar. Poeng for spørsmålet: ${pts}`;
    }
  } else if (!qs.answerMode) {
    resultText = "Velg om du vil skrive svar eller få alternativer.";
    answerBlock = `
      <div class="mode-choice">
        <button type="button" id="mode-written">Skriv svar</button>
        <button type="button" id="mode-mc">Få alternativer</button>
      </div>
    `;
  } else if (qs.answerMode === "mc") {
    if (qs.mcSubmitting) {
      resultClass = "result hint";
      resultText = "";
    }
    const available = question.options.filter(
      (opt) => !qs.removedOptions.includes(opt)
    );
    const lastWrongMc =
      !qs.answered &&
      qs.lastFeedback &&
      typeof qs.lastFeedback.selectedAnswer === "string" &&
      qs.lastFeedback.selectedAnswer &&
      !qs.lastFeedback.correct &&
      !qs.lastFeedback.networkError;
    if (lastWrongMc) {
      resultClass = "result wrong";
      resultText = "";
    } else if (qs.removedOptions.length > 0 && !qs.answered) {
      resultClass = "result hint";
      resultText =
        "Feil alternativ er fjernet. Prøv igjen. (3 / 2 / 1 / 0 poeng ved riktig svar.)";
    } else {
      resultText =
        "Velg et svaralternativ. Første riktige gir 3 poeng, deretter 2, 1 og 0.";
    }
    const optLocked = qs.answered || qs.mcSubmitting;
    answerBlock = `
      <div class="options">
        ${question.options
          .map((option) => {
            const removed = qs.removedOptions.includes(option);
            return `
              <button
                type="button"
                class="option-button ${removed ? "option-removed" : ""}"
                data-answer="${escapeHtml(option)}"
                ${removed || optLocked ? "disabled" : ""}
              >
                ${escapeHtml(option)}
              </button>
            `;
          })
          .join("")}
      </div>
      <p class="muted">Synlige valg igjen: ${available.length}</p>
    `;
  } else if (qs.answerMode === "written") {
    if (qs.writtenSubmitting || qs.checkingQuestion) {
      resultClass = "result hint";
      resultText = "";
    } else {
      resultText = "Skriv inn svar og trykk Send inn.";
    }
    const formBusy = qs.writtenSubmitting || qs.checkingQuestion;
    const writtenTaText =
      qs.writtenSubmitting && typeof qs.pendingWrittenDisplay === "string"
        ? qs.pendingWrittenDisplay
        : typeof qs.writtenComposeSnapshot === "string"
          ? qs.writtenComposeSnapshot
          : "";
    answerBlock = `
      <div class="write-box">
        <textarea id="written-answer" placeholder="Skriv svaret ditt her"${
          formBusy ? " readonly" : ""
        }>${escapeHtml(writtenTaText)}</textarea>
        <div class="write-actions">
          <button type="button" class="primary" id="written-submit"${
            formBusy ? ' data-form-lock="1"' : ""
          }>Send inn</button>
          <button
            type="button"
            class="ghost voice-mic-btn voice-mic-btn--round"
            data-voice-target="written-answer"
            data-voice-status="written-voice-status"
            aria-label="Start taleopptak"
            ${formBusy ? "disabled" : ""}
          ><span class="voice-mic-btn__inner">${VOICE_SVG_MIC}</span></button>
          <span class="voice-status" id="written-voice-status" aria-live="polite"></span>
          <button type="button" class="ghost" id="check-written-suitability"${
            formBusy ? " disabled" : ""
          }>
            Passer ikke for skrivesvar
          </button>
        </div>
      </div>
    `;
  }

  if (!qs.answered && !qs.checkingQuestion && qs.infoMessage) {
    resultClass = `result ${qs.infoClass || "hint"}`;
    resultText = qs.infoMessage;
  }

  let resultContent;
  if (qs.writtenSubmitting) {
    resultContent = loadingInlineRow("Sender inn svar…");
  } else if (qs.mcSubmitting) {
    resultContent = loadingInlineRow("Registrerer svar…");
  } else if (qs.checkingQuestion) {
    resultContent = loadingInlineRow("Sjekker spørsmålet…");
  } else if (revisionMode) {
    resultContent =
      '<p class="revision-placeholder">Dette spørsmålet revideres.</p>';
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.answerMode === "mc" &&
    qs.lastFeedback.networkError
  ) {
    const sel =
      qs.lastFeedback.selectedAnswer != null
        ? String(qs.lastFeedback.selectedAnswer)
        : "";
    resultContent = `
      <div class="feedback-mc feedback-choice-block">
        <p class="feedback-user-heading"><strong>Ditt valg:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(sel)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        <p class="feedback-verdict">Kunne ikke sende inn svar.</p>
      </div>
    `;
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.answerMode === "mc" &&
    !qs.lastFeedback.networkError
  ) {
    const sel =
      qs.lastFeedback.selectedAnswer != null
        ? String(qs.lastFeedback.selectedAnswer)
        : "";
    const ptsRaw = qs.lastFeedback.points;
    const ptsNum = Number(ptsRaw);
    const ptsDisplay = Number.isFinite(ptsNum) ? ptsNum : 0;
    const verdict = qs.lastFeedback.correct
      ? `<p class="feedback-verdict-points"><strong>Riktig svar.</strong> Poeng for spørsmålet: ${escapeHtml(
          String(ptsDisplay)
        )}</p>`
      : `<p class="feedback-verdict-points"><strong>Feil svar.</strong> Poeng for spørsmålet: ${escapeHtml(
          String(ptsDisplay)
        )}</p>`;
    resultContent = `
      <div class="feedback-mc feedback-choice-block">
        <p class="feedback-user-heading"><strong>Ditt valg:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(sel)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        ${verdict}
      </div>
    `;
  } else if (
    !qs.answered &&
    qs.answerMode === "mc" &&
    qs.lastFeedback &&
    typeof qs.lastFeedback.selectedAnswer === "string" &&
    qs.lastFeedback.selectedAnswer &&
    !qs.lastFeedback.correct &&
    !qs.lastFeedback.networkError
  ) {
    const sel = String(qs.lastFeedback.selectedAnswer);
    resultContent = `
      <div class="feedback-mc feedback-choice-block">
        <p class="feedback-user-heading"><strong>Ditt valg:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(sel)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        <p class="feedback-verdict-points">Feil svar. Alternativet er fjernet. Prøv igjen. (3 / 2 / 1 / 0 poeng ved riktig svar.)</p>
      </div>
    `;
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.answerMode === "written" &&
    !qs.lastFeedback.networkError
  ) {
    const feedback =
      typeof qs.lastFeedback.feedback === "string" ? qs.lastFeedback.feedback : "";
    const ptsRaw = qs.lastFeedback.points;
    const ptsNum = Number(ptsRaw);
    const ptsDisplay = Number.isFinite(ptsNum) ? ptsNum : 0;
    const quote =
      qs.submittedAnswer != null ? String(qs.submittedAnswer) : "";
    const feedbackTrim = feedback.trim();
    const feedbackBody = stripAnswerPrefixFromFeedback(quote, feedbackTrim);
    const trivialFeedback =
      !feedbackBody || /^ingen forklaring\.?$/i.test(feedbackBody);
    const evalDistinct =
      !trivialFeedback &&
      normalizeAnswerText(feedbackBody) !== normalizeAnswerText(quote);
    const evalSection = evalDistinct
      ? `<p class="feedback-eval-heading"><strong>Vurdering</strong></p>
        <p class="feedback-eval-text">${escapeHtml(feedbackBody)}</p>`
      : "";
    resultContent = `
      <div class="feedback-written">
        <p class="feedback-user-heading"><strong>Ditt svar:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(quote)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        ${evalSection}
        <p class="feedback-verdict-points"><strong>Poeng:</strong> ${escapeHtml(
          String(ptsDisplay)
        )} poeng</p>
      </div>
    `;
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.lastFeedback.networkError &&
    qs.answerMode === "written"
  ) {
    const quote =
      qs.submittedAnswer != null ? String(qs.submittedAnswer) : "";
    resultContent = `
      <div class="feedback-written">
        <p class="feedback-user-heading"><strong>Ditt svar:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(quote)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        <p class="feedback-verdict">Kunne ikke sende inn svar.</p>
      </div>
    `;
  } else {
    resultContent = escapeHtml(resultText);
  }

  app.innerHTML = `
    <div class="toolbar">
      <span class="score-pill">Totalscore: ${state.totalScore} poeng</span>
      <div class="toolbar-actions">
        <button type="button" class="ghost" id="prev-button" ${
          state.currentIndex === 0 ? "disabled" : ""
        }>Forrige</button>
        ${
          revisionMode
            ? ""
            : '<button type="button" class="ghost" id="protest-open-button">Protester</button>'
        }
        <button type="button" class="ghost" id="restart-button">Start på nytt</button>
      </div>
    </div>
    <p><strong>Tema:</strong> ${escapeHtml(state.theme)}</p>
    <span class="question-number">Spørsmål ${state.currentIndex + 1} av ${
    state.questions.length
  }</span>
    ${
      revisionMode
        ? '<h2 class="revision-heading">Dette spørsmålet revideres.</h2>'
        : `<h2>${escapeHtml(question.question)}</h2>`
    }
    ${answerBlock}
    <div id="result" class="${resultClass}">
      ${resultContent}
    </div>
    <div class="footer">
      <span class="muted">Naviger når du er klar.</span>
      <button type="button" id="next-button" class="primary" ${
        qs.answered || revisionMode ? "" : "disabled"
      }>
        ${isLast && qs.answered ? "Ferdig" : "Neste"}
      </button>
    </div>
  `;

  const protestOpenButton = document.getElementById("protest-open-button");
  if (protestOpenButton) {
    protestOpenButton.addEventListener("click", () => openProtestModal(question));
  }

  const restartButton = document.getElementById("restart-button");
  if (restartButton) {
    restartButton.addEventListener("click", loadQuiz);
  }

  const prevButton = document.getElementById("prev-button");
  if (prevButton) {
    prevButton.addEventListener("click", () => {
      if (state.currentIndex > 0) {
        state.currentIndex -= 1;
        render();
      }
    });
  }

  const nextButton = document.getElementById("next-button");
  if (nextButton) {
    nextButton.addEventListener("click", () => {
      if (!qs.answered && !revisionMode) {
        return;
      }
      if (isLast) {
        app.innerHTML = `
          <div class="toolbar">
            <span class="score-pill">Totalscore: ${state.totalScore} poeng</span>
            <button type="button" class="ghost" id="restart-end">Start på nytt</button>
          </div>
          <p><strong>Tema:</strong> ${escapeHtml(state.theme)}</p>
          <h2>Quizen er ferdig</h2>
          <p>Du endte med <strong>${state.totalScore}</strong> poeng totalt.</p>
          <p class="muted">Takk for testen.</p>
        `;
        const restartEndButton = document.getElementById("restart-end");
        if (restartEndButton) {
          restartEndButton.addEventListener("click", loadQuiz);
        }
        return;
      }
      state.currentIndex += 1;
      while (
        state.currentIndex < state.questions.length &&
        getQuestionState(state.questions[state.currentIndex].id).underRevision
      ) {
        state.currentIndex += 1;
      }
      if (state.currentIndex >= state.questions.length) {
        state.currentIndex = state.questions.length - 1;
      }
      render();
    });
  }

  if (!qs.answered && !qs.answerMode) {
    const modeWrittenButton = document.getElementById("mode-written");
    if (modeWrittenButton) {
      modeWrittenButton.addEventListener("click", () => {
        qs.answerMode = "written";
        qs.lastFeedback = null;
        render();
      });
    }

    const modeMcButton = document.getElementById("mode-mc");
    if (modeMcButton) {
      modeMcButton.addEventListener("click", () => {
        qs.answerMode = "mc";
        qs.removedOptions = [];
        qs.lastFeedback = null;
        render();
      });
    }
  }

  if (!qs.answered && qs.answerMode === "mc") {
    document.querySelectorAll(".option-button:not(:disabled)").forEach((button) => {
      button.addEventListener("click", () =>
        submitMultipleChoice(question, button.dataset.answer, qs)
      );
    });
  }

  if (!qs.answered && qs.answerMode === "written") {
    const writtenSubmitButton = document.getElementById("written-submit");
    if (writtenSubmitButton) {
      writtenSubmitButton.addEventListener("click", () => {
        const text = document.getElementById("written-answer")?.value ?? "";
        submitWritten(question, text, qs);
      });
    }

    const checkWrittenSuitabilityButton = document.getElementById(
      "check-written-suitability"
    );
    if (checkWrittenSuitabilityButton) {
      checkWrittenSuitabilityButton.addEventListener("click", () => {
        checkQuestionSuitability(question, qs);
      });
    }
  }

  applyWrittenAnswerSubmitVoiceLock();
}

function getQuestionOverride(question) {
  if (
    question &&
    typeof question === "object" &&
    typeof question.answer === "string" &&
    Array.isArray(question.options)
  ) {
    return {
      id: question.id,
      question: question.question,
      options: question.options,
      answer: question.answer,
    };
  }
  return undefined;
}

async function submitMultipleChoice(question, answer, qs) {
  if (qs.mcSubmitting) {
    return;
  }
  const questionId = question.id;
  const attemptNumber = qs.removedOptions.length + 1;
  qs.mcSubmitting = true;
  render();
  try {
    const response = await fetch(`${API_BASE}/api/quiz/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        questionId,
        answer,
        mode: "mc",
        attemptNumber,
        questionOverride: getQuestionOverride(question),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      qs.answered = true;
      qs.lastFeedback = { networkError: true, selectedAnswer: answer };
      return;
    }

    if (result.correct) {
      qs.answered = true;
      qs.submittedAnswer = answer;
      qs.lastFeedback = {
        correct: true,
        points: result.points,
        selectedAnswer: answer,
      };
      state.totalScore += Number(result.points) || 0;
    } else {
      if (!qs.removedOptions.includes(answer)) {
        qs.removedOptions.push(answer);
      }
      qs.lastFeedback = {
        correct: false,
        points: 0,
        selectedAnswer: answer,
      };
    }
  } catch (error) {
    qs.answered = true;
    qs.lastFeedback = { networkError: true, selectedAnswer: answer };
  } finally {
    qs.mcSubmitting = false;
    render();
  }
}

async function checkQuestionSuitability(question, qs) {
  const ta = document.getElementById("written-answer");
  qs.writtenComposeSnapshot =
    ta && typeof ta.value === "string" ? ta.value : "";
  qs.checkingQuestion = true;
  qs.infoMessage = "";
  render();

  try {
    const response = await fetch(`${API_BASE}/api/quiz/check-question`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: question.question,
        questionId: question.id,
        theme: state.theme,
      }),
    });

    const result = await response.json();
    qs.checkingQuestion = false;
    qs.writtenComposeSnapshot = undefined;

    if (!response.ok) {
      qs.infoClass = "wrong";
      qs.infoMessage =
        typeof result.error === "string"
          ? result.error
          : "Kunne ikke sjekke spørsmålet.";
      render();
      return;
    }

    if (result.valid) {
      qs.infoClass = "hint";
      qs.infoMessage =
        typeof result.message === "string"
          ? result.message
          : "Dette spørsmålet kan besvares skriftlig.";
      render();
      return;
    }

    const replacement = result.question;
    if (!replacement || typeof replacement.question !== "string") {
      qs.infoClass = "wrong";
      qs.infoMessage = "Fikk ikke et nytt spørsmål tilbake.";
      render();
      return;
    }

    const currentQuestionId = String(question.id);
    const replacementQuestionId = String(replacement.id ?? question.id);
    state.totalScore += Number(result.points) || 0;
    state.questions[state.currentIndex] = replacement;
    if (replacementQuestionId !== currentQuestionId) {
      delete state.byId[currentQuestionId];
    }
    state.byId[replacementQuestionId] = {
      answerMode: "written",
      removedOptions: [],
      answered: false,
      lastFeedback: null,
      submittedAnswer: null,
      checkingQuestion: false,
      infoMessage: `${result.message} Du fikk ${
        Number(result.points) || 0
      } poeng. Her er et nytt spørsmål.`,
      infoClass: "correct",
    };
    render();
  } catch (error) {
    qs.checkingQuestion = false;
    qs.writtenComposeSnapshot = undefined;
    qs.infoClass = "wrong";
    qs.infoMessage = "Kunne ikke sjekke spørsmålet.";
    render();
  }
}

async function submitWritten(question, answer, qs) {
  if (voiceTranscribingTargetId === "written-answer") {
    return;
  }
  if (isVoiceRecordingForFieldId("written-answer")) {
    return;
  }
  if (qs.writtenSubmitting) {
    return;
  }
  const questionId = question.id;
  const trimmed = String(answer ?? "").trim();
  qs.submittedAnswer = trimmed;
  qs.pendingWrittenDisplay = trimmed;
  qs.writtenSubmitting = true;
  render();
  try {
    const response = await fetch(`${API_BASE}/api/quiz/answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        questionId,
        answer,
        mode: "written",
        questionOverride: getQuestionOverride(question),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      qs.answered = true;
      qs.lastFeedback = { networkError: true };
      return;
    }

    qs.answered = true;
    qs.lastFeedback = {
      correct: Boolean(result.correct),
      points: result.points,
      feedback: typeof result.feedback === "string" ? result.feedback : "",
    };
    state.totalScore += Number(result.points) || 0;
  } catch (error) {
    qs.answered = true;
    qs.lastFeedback = { networkError: true };
  } finally {
    qs.writtenSubmitting = false;
    qs.pendingWrittenDisplay = undefined;
    render();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VOICE_MAX_MS = 60000;
const VOICE_MIN_BYTES = 100;

let voiceRecorder = null;
let voiceChunks = [];
let voiceAutoStopTimer = null;
let voiceCountdownInterval = null;
let voiceActiveCtx = null;
/** id på feltet som får transkribert tekst (f.eks. written-answer); null når ikke aktiv */
let voiceTranscribingTargetId = null;

function isVoiceRecordingForFieldId(fieldId) {
  return Boolean(
    fieldId &&
      voiceActiveCtx &&
      voiceActiveCtx.field &&
      voiceActiveCtx.field.id === fieldId &&
      voiceRecorder &&
      voiceRecorder.state === "recording"
  );
}

function clearVoiceCountdown() {
  if (voiceCountdownInterval) {
    clearInterval(voiceCountdownInterval);
    voiceCountdownInterval = null;
  }
}

function applyWrittenAnswerSubmitVoiceLock() {
  const btn = document.getElementById("written-submit");
  if (!btn) {
    return;
  }
  const formLocked = btn.dataset.formLock === "1";
  const voiceLocked =
    voiceTranscribingTargetId === "written-answer" ||
    isVoiceRecordingForFieldId("written-answer");
  btn.disabled = formLocked || voiceLocked;
}

function setVoiceButtonAppearance(button, recording) {
  if (!button) {
    return;
  }
  const inner = button.querySelector(".voice-mic-btn__inner");
  if (inner) {
    inner.innerHTML = recording ? VOICE_SVG_STOP : VOICE_SVG_MIC;
  }
  button.setAttribute(
    "aria-label",
    recording ? "Stopp opptak" : "Start taleopptak"
  );
  button.classList.toggle("voice-mic-btn--recording", Boolean(recording));
}

function setVoiceStatus(el, text, isError) {
  if (!el) {
    return;
  }
  el.textContent = text || "";
  el.classList.toggle("voice-status--error", Boolean(isError));
  if (!text) {
    el.classList.remove("voice-status--recording");
  }
}

async function uploadTranscription(blob) {
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `recording.${ext}`);
  const res = await fetch(`${API_BASE}/api/quiz/transcribe`, {
    method: "POST",
    body: fd,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const msg =
      typeof data.error === "string" && data.error.trim()
        ? data.error
        : "Transkripsjon feilet.";
    throw new Error(msg);
  }
  return typeof data.text === "string" ? data.text : "";
}

function pickRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (MediaRecorder.isTypeSupported(candidates[i])) {
      return candidates[i];
    }
  }
  return "";
}

async function toggleVoiceRecording(button) {
  const targetId = button.getAttribute("data-voice-target");
  const statusId = button.getAttribute("data-voice-status");
  const field = targetId ? document.getElementById(targetId) : null;
  const statusEl = statusId ? document.getElementById(statusId) : null;

  if (!field || (field.tagName !== "TEXTAREA" && field.tagName !== "INPUT")) {
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    setVoiceStatus(statusEl, "Opptak støttes ikke i denne nettleseren.", true);
    return;
  }

  if (voiceRecorder && voiceRecorder.state === "recording") {
    if (!voiceActiveCtx || voiceActiveCtx.button !== button) {
      setVoiceStatus(statusEl, "Stopp pågående opptak først.", true);
      return;
    }
    voiceRecorder.stop();
    return;
  }

  setVoiceStatus(statusEl, "", false);
  clearVoiceCountdown();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setVoiceStatus(statusEl, "Kunne ikke bruke mikrofon.", true);
    return;
  }

  const mimeType = pickRecorderMimeType();
  const mr = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);

  const ctx = { button, statusEl, field, stream, mr };
  voiceActiveCtx = ctx;
  voiceChunks = [];
  voiceRecorder = mr;

  mr.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) {
      voiceChunks.push(e.data);
    }
  });

  mr.addEventListener("stop", async () => {
    ctx.stream.getTracks().forEach((t) => t.stop());
    clearVoiceCountdown();
    if (voiceAutoStopTimer) {
      clearTimeout(voiceAutoStopTimer);
      voiceAutoStopTimer = null;
    }
    setVoiceButtonAppearance(ctx.button, false);
    if (ctx.statusEl) {
      ctx.statusEl.classList.remove("voice-status--recording");
    }
    voiceRecorder = null;
    voiceActiveCtx = null;

    const blob = new Blob(voiceChunks, {
      type: ctx.mr.mimeType || "audio/webm",
    });
    voiceChunks = [];

    if (blob.size < VOICE_MIN_BYTES) {
      setVoiceStatus(ctx.statusEl, "Ingen lyd fanget. Prøv igjen.", true);
      applyWrittenAnswerSubmitVoiceLock();
      applyProtestComposerLock();
      return;
    }

    voiceTranscribingTargetId = ctx.field.id || null;
    setVoiceStatus(ctx.statusEl, "Behandler…");
    ctx.button.disabled = true;
    applyWrittenAnswerSubmitVoiceLock();
    applyProtestComposerLock();

    try {
      const text = await uploadTranscription(blob);
      const cur = String(ctx.field.value || "").trim();
      const incoming = String(text || "").trim();
      ctx.field.value =
        cur && incoming ? `${cur} ${incoming}` : incoming || cur;
      setVoiceStatus(ctx.statusEl, "");
    } catch (err) {
      const msg =
        err && typeof err.message === "string" ? err.message : "Feil.";
      setVoiceStatus(ctx.statusEl, msg, true);
    } finally {
      ctx.button.disabled = false;
      voiceTranscribingTargetId = null;
      applyWrittenAnswerSubmitVoiceLock();
      applyProtestComposerLock();
    }
  });

  clearVoiceCountdown();
  const recordStartMs = Date.now();
  voiceCountdownInterval = setInterval(() => {
    const left = Math.max(
      0,
      Math.ceil((VOICE_MAX_MS - (Date.now() - recordStartMs)) / 1000)
    );
    if (ctx.statusEl) {
      ctx.statusEl.textContent =
        left > 0 ? `Opptak · ${left} s` : "Stopper…";
      ctx.statusEl.classList.remove("voice-status--error");
      ctx.statusEl.classList.add("voice-status--recording");
    }
  }, 250);

  mr.start(200);
  setVoiceButtonAppearance(ctx.button, true);
  applyWrittenAnswerSubmitVoiceLock();
  applyProtestComposerLock();
  if (ctx.statusEl) {
    ctx.statusEl.classList.remove("voice-status--error");
    ctx.statusEl.classList.add("voice-status--recording");
    ctx.statusEl.textContent = "Opptak · 60 s";
  }
  voiceAutoStopTimer = setTimeout(() => {
    if (voiceRecorder && voiceRecorder.state === "recording") {
      voiceRecorder.stop();
    }
  }, VOICE_MAX_MS);
}

function initVoiceInputDelegation() {
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-voice-target]");
    if (!btn || btn.disabled) {
      return;
    }
    ev.preventDefault();
    void toggleVoiceRecording(btn);
  });
}

function protestStatusLabel(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "approved") {
    return "Godkjent";
  }
  if (s === "partial") {
    return "Delvis godkjent";
  }
  return "Avvist";
}

function clearProtestThread() {
  const thread = document.getElementById("protest-thread");
  if (thread) {
    thread.innerHTML = "";
  }
}

function appendProtestThread(kind, innerHtml) {
  const thread = document.getElementById("protest-thread");
  if (!thread) {
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = `protest-chat__msg protest-chat__msg--${kind}`;
  wrap.innerHTML = innerHtml;
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

function appendProtestThreadPersist(kind, innerHtml) {
  appendProtestThread(kind, innerHtml);
  if (protestSession) {
    protestSession.messages.push({ kind, innerHtml });
  }
}

function rebuildProtestThreadFromSession() {
  clearProtestThread();
  if (!protestSession?.messages?.length) {
    return;
  }
  for (let i = 0; i < protestSession.messages.length; i += 1) {
    const seg = protestSession.messages[i];
    appendProtestThread(seg.kind, seg.innerHtml);
  }
}

function popLastProtestUserSegment() {
  if (!protestSession?.messages?.length) {
    return;
  }
  const last = protestSession.messages[protestSession.messages.length - 1];
  if (last.kind !== "user") {
    return;
  }
  protestSession.messages.pop();
  rebuildProtestThreadFromSession();
}

function addProtestPendingBubble() {
  const thread = document.getElementById("protest-thread");
  if (!thread) {
    return;
  }
  const existing = document.getElementById("protest-pending-assistant");
  if (existing) {
    existing.remove();
  }
  const wrap = document.createElement("div");
  wrap.id = "protest-pending-assistant";
  wrap.className =
    "protest-chat__msg protest-chat__msg--assistant protest-chat__msg--pending";
  wrap.innerHTML =
    '<p class="protest-chat__typing"><span class="protest-chat__spinner" aria-hidden="true"></span> Vurderer…</p>';
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

function removeProtestPendingBubble() {
  document.getElementById("protest-pending-assistant")?.remove();
}

function updateProtestPhaseUI() {
  const session = protestSession;
  const formPhase = document.getElementById("protest-form-phase");
  const chatPhase = document.getElementById("protest-chat-phase");
  const limitMsg = document.getElementById("protest-thread-limit-msg");
  const isChat = session?.phase === "chat";
  if (formPhase) {
    formPhase.classList.toggle("protest-block--hidden", isChat);
  }
  if (chatPhase) {
    chatPhase.classList.toggle("protest-block--hidden", !isChat);
  }
  if (limitMsg) {
    const showLimit =
      isChat &&
      session &&
      session.userMessageCount >= MAX_PROTEST_USER_MESSAGES;
    limitMsg.classList.toggle("protest-block--hidden", !showLimit);
  }
}

function applyProtestComposerLock() {
  const busy = protestSubmitInFlight;
  const session = protestSession;
  const atLimit =
    session && session.userMessageCount >= MAX_PROTEST_USER_MESSAGES;

  const formBlocked = session?.phase === "form" && busy;
  const chatBlocked = session?.phase === "chat" && (busy || atLimit);

  const msg = document.getElementById("protest-message");
  const typeEl = document.getElementById("protest-type");
  const formMic = document.getElementById("protest-voice-button");
  const formSubmit = document.getElementById("protest-submit");
  const follow = document.getElementById("protest-followup-input");
  const followMic = document.getElementById("protest-followup-voice-button");
  const chatSend = document.getElementById("protest-chat-send");
  const endBtn = document.getElementById("protest-end");

  const inFormPhase = session?.phase === "form";
  const inChatPhase = session?.phase === "chat";

  if (msg) {
    msg.readOnly = formBlocked || inChatPhase;
  }
  if (typeEl) {
    typeEl.disabled = formBlocked || inChatPhase;
  }
  if (formMic) {
    formMic.disabled = formBlocked || inChatPhase;
  }
  if (formSubmit) {
    const voiceBlocksFormSend =
      voiceTranscribingTargetId === "protest-message" ||
      isVoiceRecordingForFieldId("protest-message");
    formSubmit.disabled =
      formBlocked || inChatPhase || (inFormPhase && voiceBlocksFormSend);
    if (inFormPhase) {
      formSubmit.textContent = busy ? "Vurderer…" : "Send";
    }
  }

  if (follow) {
    follow.readOnly = chatBlocked || !inChatPhase;
  }
  if (followMic) {
    followMic.disabled = chatBlocked || !inChatPhase;
  }
  if (chatSend) {
    const voiceBlocksChatSend =
      voiceTranscribingTargetId === "protest-followup-input" ||
      isVoiceRecordingForFieldId("protest-followup-input");
    chatSend.disabled =
      chatBlocked ||
      !inChatPhase ||
      (inChatPhase && voiceBlocksChatSend);
    chatSend.textContent = busy ? "Vurderer…" : "Send";
  }
  if (endBtn) {
    endBtn.disabled = busy || !inChatPhase;
  }
}

function setProtestModalVisible(visible) {
  const modal = document.getElementById("protest-modal");
  if (!modal) {
    return;
  }
  if (visible) {
    modal.classList.remove("protest-modal--hidden");
    modal.setAttribute("aria-hidden", "false");
  } else {
    modal.classList.add("protest-modal--hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

function syncProtestSessionForQuestion(question) {
  const qid = String(question.id);
  const existing = state.protestStateByQuestionId[qid];
  if (!existing || existing.status !== "active") {
    state.protestStateByQuestionId[qid] = {
      status: "active",
      phase: "form",
      protestType: null,
      userMessageCount: 0,
      messages: [],
    };
  }
  protestSession = /** @type {ProtestStateActive} */ (
    state.protestStateByQuestionId[qid]
  );
}

function openProtestModal(question) {
  document.getElementById("protest-revision-view")?.classList.add("protest-block--hidden");

  protestTargetQuestion = question;
  protestSubmitInFlight = false;

  const qid = String(question.id);
  const finalizedView = document.getElementById("protest-finalized-view");
  const activeView = document.getElementById("protest-active-view");

  if (state.protestStateByQuestionId[qid]?.status === "finalized") {
    const pq = getQuestionState(question.id);
    const finText = document.getElementById("protest-finalized-text");
    if (finText) {
      finText.textContent = pq.underRevision
        ? "Protesten er registrert. Spørsmålet tas ut av denne økten og sendes til revisjon."
        : "Protest for dette spørsmålet er avsluttet. Du kan ikke sende ny protest her.";
    }
    if (finalizedView) {
      finalizedView.classList.remove("protest-block--hidden");
    }
    if (activeView) {
      activeView.classList.add("protest-block--hidden");
    }
    protestSession = null;
    setProtestModalVisible(true);
    applyProtestComposerLock();
    return;
  }

  if (finalizedView) {
    finalizedView.classList.add("protest-block--hidden");
  }
  if (activeView) {
    activeView.classList.remove("protest-block--hidden");
  }

  syncProtestSessionForQuestion(question);

  const fresh =
    protestSession.phase === "form" &&
    protestSession.userMessageCount === 0 &&
    protestSession.messages.length === 0;

  rebuildProtestThreadFromSession();

  const msgEl = document.getElementById("protest-message");
  const typeEl = document.getElementById("protest-type");
  const followEl = document.getElementById("protest-followup-input");
  if (fresh) {
    if (msgEl) {
      msgEl.value = "";
    }
    if (typeEl) {
      typeEl.selectedIndex = 0;
    }
  }
  if (followEl) {
    followEl.value = "";
  }

  const formSubmit = document.getElementById("protest-submit");
  const chatSend = document.getElementById("protest-chat-send");
  if (formSubmit) {
    formSubmit.textContent = "Send";
  }
  if (chatSend) {
    chatSend.textContent = "Send";
  }

  updateProtestPhaseUI();
  applyProtestComposerLock();
  setProtestModalVisible(true);

  if (protestSession.phase === "form") {
    msgEl?.focus();
  } else {
    followEl?.focus();
  }
}

function closeProtestModal() {
  protestTargetQuestion = null;
  protestSubmitInFlight = false;
  protestSession = null;
  const formSubmit = document.getElementById("protest-submit");
  const chatSend = document.getElementById("protest-chat-send");
  if (formSubmit) {
    formSubmit.textContent = "Send";
  }
  if (chatSend) {
    chatSend.textContent = "Send";
  }
  document.getElementById("protest-finalized-view")?.classList.add("protest-block--hidden");
  document.getElementById("protest-revision-view")?.classList.add("protest-block--hidden");
  setProtestModalVisible(false);
}

function finalizeProtestSession() {
  if (!protestTargetQuestion) {
    closeProtestModal();
    return;
  }
  const qid = String(protestTargetQuestion.id);
  state.protestStateByQuestionId[qid] = { status: "finalized" };
  closeProtestModal();
}

async function sendProtestRequest(userMessage, protestType) {
  const options = Array.isArray(protestTargetQuestion.options)
    ? protestTargetQuestion.options
    : [];
  const response = await fetch(`${API_BASE}/api/quiz/protest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questionId: protestTargetQuestion.id,
      theme: state.theme,
      question: protestTargetQuestion.question,
      options,
      protestType,
      userMessage,
    }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = { error: "Ugyldig JSON fra serveren." };
  }
  return { response, data };
}

async function submitProtestForm() {
  const msgEl = document.getElementById("protest-message");
  const typeEl = document.getElementById("protest-type");

  if (!protestTargetQuestion || !protestSession) {
    return;
  }

  const options = Array.isArray(protestTargetQuestion.options)
    ? protestTargetQuestion.options
    : [];
  if (options.length < 2) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml(
        "Dette spørsmålet mangler alternativer som kreves for protest."
      )}</p>`
    );
    return;
  }

  const userMessage = (msgEl?.value ?? "").trim();
  if (!userMessage) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml("Skriv en kort begrunnelse.")}</p>`
    );
    return;
  }

  const protestType = (typeEl?.value ?? "").trim();
  if (!protestType) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml("Velg protesttype.")}</p>`
    );
    return;
  }

  protestSubmitInFlight = true;
  applyProtestComposerLock();

  const userHtml =
    `<div class="protest-chat__meta">${escapeHtml(protestType)}</div>` +
    `<div class="protest-chat__body">${escapeHtml(userMessage)}</div>`;
  appendProtestThreadPersist("user", userHtml);

  if (msgEl) {
    msgEl.value = "";
  }

  addProtestPendingBubble();

  let res;
  try {
    res = await sendProtestRequest(userMessage, protestType);
  } catch {
    removeProtestPendingBubble();
    popLastProtestUserSegment();
    appendProtestThread(
      "system",
      `<p>${escapeHtml(
        "Nettverksfeil. Sjekk tilkoblingen og prøv igjen."
      )}</p>`
    );
    if (msgEl) {
      msgEl.value = userMessage;
    }
    protestSubmitInFlight = false;
    applyProtestComposerLock();
    return;
  }

  removeProtestPendingBubble();

  if (!res.response.ok) {
    const errText =
      typeof res.data.error === "string" && res.data.error.trim()
        ? res.data.error
        : "Forespørselen feilet.";
    popLastProtestUserSegment();
    appendProtestThread(
      "system",
      `<p>${escapeHtml(errText)}</p>`
    );
    if (msgEl) {
      msgEl.value = userMessage;
    }
    protestSubmitInFlight = false;
    applyProtestComposerLock();
    return;
  }

  const status =
    typeof res.data.status === "string" ? res.data.status : "rejected";
  const points = Number(res.data.points);
  const ptsDisplay = Number.isFinite(points) ? points : 0;
  const feedback =
    typeof res.data.feedback === "string"
      ? res.data.feedback
      : "Ingen forklaring.";

  state.totalScore += ptsDisplay;

  if (protestRemovesQuestionFromSession(status)) {
    applyProtestRevisionSuccess(protestTargetQuestion.id);
    protestSubmitInFlight = false;
    render();
    showProtestRevisionOutcomeInModal(ptsDisplay);
    applyProtestComposerLock();
    return;
  }

  render();

  const assistantHtml =
    `<div class="protest-chat__meta">Vurdering</div>` +
    `<div class="protest-chat__body">` +
    `<p><strong>Status:</strong> ${escapeHtml(
      protestStatusLabel(status)
    )}</p>` +
    `<p><strong>Poeng:</strong> ${escapeHtml(String(ptsDisplay))}</p>` +
    `<p><strong>Forklaring:</strong> ${escapeHtml(feedback)}</p>` +
    `</div>`;
  appendProtestThreadPersist("assistant", assistantHtml);

  protestSession.protestType = protestType;
  protestSession.phase = "chat";
  protestSession.userMessageCount = 1;

  protestSubmitInFlight = false;
  updateProtestPhaseUI();
  applyProtestComposerLock();
  document.getElementById("protest-followup-input")?.focus();
}

async function submitProtestFollowup() {
  const followEl = document.getElementById("protest-followup-input");

  if (!protestTargetQuestion || !protestSession) {
    return;
  }

  if (protestSession.userMessageCount >= MAX_PROTEST_USER_MESSAGES) {
    return;
  }

  const options = Array.isArray(protestTargetQuestion.options)
    ? protestTargetQuestion.options
    : [];
  if (options.length < 2) {
    return;
  }

  const protestType = protestSession.protestType;
  if (!protestType) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml("Mangler protesttype. Start på nytt.")}</p>`
    );
    return;
  }

  const userMessage = (followEl?.value ?? "").trim();
  if (!userMessage) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml("Skriv en melding.")}</p>`
    );
    return;
  }

  protestSubmitInFlight = true;
  applyProtestComposerLock();

  appendProtestThreadPersist(
    "user",
    `<div class="protest-chat__body">${escapeHtml(userMessage)}</div>`
  );

  if (followEl) {
    followEl.value = "";
  }

  addProtestPendingBubble();

  let res;
  try {
    res = await sendProtestRequest(userMessage, protestType);
  } catch {
    removeProtestPendingBubble();
    popLastProtestUserSegment();
    appendProtestThread(
      "system",
      `<p>${escapeHtml(
        "Nettverksfeil. Sjekk tilkoblingen og prøv igjen."
      )}</p>`
    );
    if (followEl) {
      followEl.value = userMessage;
    }
    protestSubmitInFlight = false;
    applyProtestComposerLock();
    return;
  }

  removeProtestPendingBubble();

  if (!res.response.ok) {
    const errText =
      typeof res.data.error === "string" && res.data.error.trim()
        ? res.data.error
        : "Forespørselen feilet.";
    popLastProtestUserSegment();
    appendProtestThread(
      "system",
      `<p>${escapeHtml(errText)}</p>`
    );
    if (followEl) {
      followEl.value = userMessage;
    }
    protestSubmitInFlight = false;
    applyProtestComposerLock();
    return;
  }

  const status =
    typeof res.data.status === "string" ? res.data.status : "rejected";
  const points = Number(res.data.points);
  const ptsDisplay = Number.isFinite(points) ? points : 0;
  const feedback =
    typeof res.data.feedback === "string"
      ? res.data.feedback
      : "Ingen forklaring.";

  state.totalScore += ptsDisplay;

  if (protestRemovesQuestionFromSession(status)) {
    applyProtestRevisionSuccess(protestTargetQuestion.id);
    protestSubmitInFlight = false;
    render();
    showProtestRevisionOutcomeInModal(ptsDisplay);
    applyProtestComposerLock();
    return;
  }

  render();

  appendProtestThreadPersist(
    "assistant",
    `<div class="protest-chat__meta">Vurdering</div>` +
      `<div class="protest-chat__body">` +
      `<p><strong>Status:</strong> ${escapeHtml(
        protestStatusLabel(status)
      )}</p>` +
      `<p><strong>Poeng:</strong> ${escapeHtml(String(ptsDisplay))}</p>` +
      `<p><strong>Forklaring:</strong> ${escapeHtml(feedback)}</p>` +
      `</div>`
  );

  protestSession.userMessageCount += 1;

  protestSubmitInFlight = false;
  updateProtestPhaseUI();
  applyProtestComposerLock();
  if (protestSession.userMessageCount < MAX_PROTEST_USER_MESSAGES) {
    followEl?.focus();
  }
}

async function submitProtest() {
  if (protestSubmitInFlight) {
    return;
  }

  if (
    protestSession?.phase === "form" &&
    (voiceTranscribingTargetId === "protest-message" ||
      isVoiceRecordingForFieldId("protest-message"))
  ) {
    return;
  }
  if (
    protestSession?.phase === "chat" &&
    (voiceTranscribingTargetId === "protest-followup-input" ||
      isVoiceRecordingForFieldId("protest-followup-input"))
  ) {
    return;
  }

  if (!protestTargetQuestion || !protestSession) {
    appendProtestThread(
      "system",
      `<p>${escapeHtml(
        "Kunne ikke knytte protesten til et spørsmål. Lukk og prøv igjen."
      )}</p>`
    );
    return;
  }

  if (protestSession.phase === "chat") {
    await submitProtestFollowup();
    return;
  }
  await submitProtestForm();
}

function initProtestModal() {
  const backdrop = document.getElementById("protest-modal-backdrop");
  const closeBtn = document.getElementById("protest-modal-close");
  const cancelBtn = document.getElementById("protest-cancel");
  [backdrop, closeBtn, cancelBtn].forEach((el) => {
    if (el) {
      el.addEventListener("click", () => closeProtestModal());
    }
  });
  const submitBtn = document.getElementById("protest-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", () => {
      void submitProtest();
    });
  }
  const chatSend = document.getElementById("protest-chat-send");
  if (chatSend) {
    chatSend.addEventListener("click", () => {
      void submitProtest();
    });
  }
  const endBtn = document.getElementById("protest-end");
  if (endBtn) {
    endBtn.addEventListener("click", () => finalizeProtestSession());
  }
  const finalizedOk = document.getElementById("protest-finalized-ok");
  if (finalizedOk) {
    finalizedOk.addEventListener("click", () => closeProtestModal());
  }

  const revisionNext = document.getElementById("protest-revision-next");
  if (revisionNext) {
    revisionNext.addEventListener("click", () => {
      closeProtestModal();
      advanceToNextPlayableQuestion();
    });
  }

  const followInput = document.getElementById("protest-followup-input");
  if (followInput) {
    followInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void submitProtest();
      }
    });
  }
}

const generateQuizButton = document.getElementById("generate-quiz-button");
if (generateQuizButton) {
  generateQuizButton.addEventListener("click", () => {
    generateNewQuiz();
  });
}

initProtestModal();
initVoiceInputDelegation();
loadQuiz();

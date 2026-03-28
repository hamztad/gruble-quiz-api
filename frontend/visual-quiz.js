/**
 * Bilde-quiz (visual-10) — presentasjon. Standard app.js er uendret.
 */
const API_BASE = "https://gruble-quiz-api.onrender.com";
const QUIZ_VARIANT = "visual-10";
const QUESTION_COUNT = 10;

const state = {
  theme: "",
  difficulty: "normal",
  variant: "",
  sharedImage: null,
  questions: [],
  currentIndex: 0,
  totalScore: 0,
  byId: {},
};

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function difficultyLabel(d) {
  const x = String(d ?? "normal").toLowerCase();
  if (x === "easy") return "Lett";
  if (x === "hard") return "Vanskelig";
  return "Normal";
}

function getQs(questionId) {
  const key = String(questionId);
  if (!state.byId[key]) {
    state.byId[key] = {
      removedOptions: [],
      answered: false,
      lastFeedback: null,
      mcSubmitting: false,
    };
  }
  return state.byId[key];
}

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

function isValidVisualQuizPayload(data) {
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  if ((data?.variant || QUIZ_VARIANT) !== QUIZ_VARIANT) {
    return false;
  }
  if (questions.length !== QUESTION_COUNT) {
    return false;
  }
  const lastQuestion = questions[questions.length - 1];
  if (!lastQuestion || lastQuestion.imageQuestion !== true) {
    return false;
  }
  return true;
}

function totalSteps() {
  return Math.max(state.questions.length, 1);
}

function progressPercent(idx) {
  const n = totalSteps();
  return Math.round(((idx + 1) / n) * 100);
}

function buildStepDots(currentIdx) {
  const n = totalSteps();
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const stepNum = i + 1;
    const isFinale = i === n - 1;
    const classes = ["vq-step"];
    if (isFinale) {
      classes.push("vq-step--finale");
    }
    if (i < currentIdx) {
      classes.push("vq-step--done");
    } else if (i === currentIdx) {
      classes.push("vq-step--current");
    }
    parts.push(
      `<li class="${classes.join(" ")}" title="Spørsmål ${stepNum}" aria-current="${
        i === currentIdx ? "step" : "false"
      }">${stepNum}</li>`
    );
  }
  return `<ol class="vq-steps" aria-label="Fremdrift">${parts.join("")}</ol>`;
}

async function loadVisualQuiz() {
  const el = document.getElementById("visual-app");
  el.innerHTML =
    "<p class=\"empty-state\"><span class=\"vq-spinner\" aria-hidden=\"true\"></span> Laster quiz…</p>";
  try {
    const response = await fetch(`${API_BASE}/api/quiz/visual-today`);
    if (!response.ok) {
      el.innerHTML =
        "<p class=\"empty-state\">Ingen lagret bilde-quiz ennå. Trykk «Start ny quiz» over.</p>";
      return false;
    }
    const data = await response.json();
    if (!isValidVisualQuizPayload(data)) {
      el.innerHTML =
        "<p class=\"empty-state\">Fant ingen gyldig bilde-quiz med 10 spørsmål. Start en ny runde.</p>";
      return false;
    }
    state.theme = data.theme || "";
    state.difficulty = data.difficulty || "normal";
    state.variant = data.variant || QUIZ_VARIANT;
    state.sharedImage =
      data.sharedImage &&
      typeof data.sharedImage === "object" &&
      typeof data.sharedImage.url === "string"
        ? data.sharedImage
        : null;
    const raw = Array.isArray(data.questions) ? data.questions : [];
    state.questions = shuffleQuizOptions(raw);
    state.currentIndex = 0;
    state.totalScore = 0;
    state.byId = {};
    render();
    return true;
  } catch {
    el.innerHTML =
      "<p class=\"empty-state\">Kunne ikke koble til API. Sjekk nettverk eller API_BASE i scriptet.</p>";
    return false;
  }
}

async function submitMc(question, answer, qs) {
  if (qs.mcSubmitting) {
    return;
  }
  const attemptNumber = qs.removedOptions.length + 1;
  qs.mcSubmitting = true;
  render();
  try {
    const response = await fetch(`${API_BASE}/api/quiz/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: question.id,
        answer,
        mode: "mc",
        attemptNumber,
        quizVariant: QUIZ_VARIANT,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      qs.answered = true;
      qs.lastFeedback = { networkError: true };
      return;
    }
    if (result.correct) {
      qs.answered = true;
      qs.lastFeedback = { correct: true, points: result.points };
      state.totalScore += Number(result.points) || 0;
    } else {
      if (!qs.removedOptions.includes(answer)) {
        qs.removedOptions.push(answer);
      }
      qs.lastFeedback = { correct: false, points: 0 };
    }
  } catch {
    qs.answered = true;
    qs.lastFeedback = { networkError: true };
  } finally {
    qs.mcSubmitting = false;
    render();
  }
}

function render() {
  const el = document.getElementById("visual-app");
  if (!state.questions.length) {
    el.innerHTML =
      "<p class=\"empty-state\">Ingen spørsmål lastet. Bruk knappene over.</p>";
    return;
  }
  if (state.questions.length !== QUESTION_COUNT) {
    el.innerHTML =
      "<p class=\"empty-state\">Denne bilde-quizen er ugyldig. Start en ny 10-spørsmålsrunde.</p>";
    return;
  }

  const q = state.questions[state.currentIndex];
  const qs = getQs(q.id);
  const idx = state.currentIndex;
  const n = state.questions.length;
  const isLast = idx === n - 1;
  const isFinaleQuestion = q.imageQuestion === true || idx === n - 1;
  const img = state.sharedImage;

  const imageBlock =
    img && img.url
      ? `<figure class="vq-image-frame">
           <img src="${escapeHtml(img.url)}" alt="${escapeHtml(
             img.title || "Illustrasjon til quizen"
           )}" loading="lazy" />
           <figcaption>${escapeHtml(img.credit || "")}</figcaption>
         </figure>`
      : `<p class="vq-image-missing">Ingen delt bilde i denne quizen.</p>`;

  const finaleHintClass =
    isFinaleQuestion ? "vq-hint-finale vq-hint-finale--active" : "vq-hint-finale";
  const finaleHintText = isFinaleQuestion
    ? "Siste spørsmål — dette handler om bildet over."
    : "Underveis: samme bilde hele veien. Til slutt kommer et eget spørsmål om bildet.";

  let optionsHtml = "";
  if (!qs.answered) {
    const busy = qs.mcSubmitting;
    const busyNote = busy
      ? '<p class="vq-submitting" role="status"><span class="vq-spinner" aria-hidden="true"></span> Sender svar…</p>'
      : "";
    optionsHtml = `${busyNote}<div class="vq-options">
      ${q.options
        .map((opt) => {
          const removed = qs.removedOptions.includes(opt);
          return `<button type="button" class="vq-option ${
            removed ? "vq-option--removed" : ""
          }" data-answer="${escapeHtml(opt)}" ${
            removed || busy ? "disabled" : ""
          }">${escapeHtml(opt)}</button>`;
        })
        .join("")}
    </div>`;
  }

  let feedbackHtml = "";
  if (qs.lastFeedback) {
    if (qs.lastFeedback.networkError) {
      feedbackHtml =
        '<p class="vq-feedback vq-feedback--bad">Nettverksfeil ved innsending.</p>';
    } else if (qs.lastFeedback.correct) {
      feedbackHtml = `<p class="vq-feedback vq-feedback--ok">Riktig — +${escapeHtml(
        String(qs.lastFeedback.points ?? 0)
      )} poeng</p>`;
    } else {
      feedbackHtml =
        '<p class="vq-feedback vq-feedback--bad">Ikke riktig — velg et annet alternativ.</p>';
    }
  }

  const kickerClass = isFinaleQuestion
    ? "vq-question-kicker vq-question-kicker--finale"
    : "vq-question-kicker";
  const kickerText = isFinaleQuestion ? "Bilde-spørsmål" : "Flervalgsoppgave";

  el.innerHTML = `
    <section class="vq-play">
      <header class="vq-play__header">
        <div class="vq-pills">
          <span class="vq-pill">${escapeHtml(state.theme)}</span>
          <span class="vq-pill">${QUESTION_COUNT} spørsmål</span>
          <span class="vq-pill vq-pill--score">${state.totalScore} poeng</span>
        </div>
        <button type="button" class="vq-btn-ghost" id="visual-reload">Start på nytt</button>
      </header>

      <div class="vq-progress-block">
        <div class="vq-progress-label">
          <span>Spørsmål <strong>${idx + 1}</strong> av ${n}</span>
          <span>${progressPercent(idx)} %</span>
        </div>
        <div class="vq-progress-bar-wrap" aria-hidden="true">
          <div class="vq-progress-bar" style="width:${progressPercent(idx)}%"></div>
        </div>
        ${buildStepDots(idx)}
      </div>

      <p class="${finaleHintClass}" role="status">${escapeHtml(finaleHintText)}</p>

      <div class="vq-image-wrap">${imageBlock}</div>

      <div class="vq-question-block">
        <span class="${kickerClass}">${escapeHtml(kickerText)}</span>
        <h2 class="vq-question-title">${escapeHtml(q.question)}</h2>
        ${feedbackHtml}
        ${optionsHtml}
        <footer class="vq-footer">
          <p class="vq-footer-hint">${
            qs.answered
              ? isLast
                ? "Trykk «Se resultat» for å avslutte."
                : "Gå videre til neste spørsmål."
              : "Velg det svaret du mener er riktig."
          }</p>
          <button type="button" class="vq-btn-next" id="visual-next" ${
            qs.answered ? "" : "disabled"
          }>${isLast && qs.answered ? "Se resultat" : "Neste spørsmål"}</button>
        </footer>
      </div>
    </section>
  `;

  document.getElementById("visual-reload")?.addEventListener("click", () => {
    state.questions = [];
    state.currentIndex = 0;
    el.innerHTML =
      "<p class=\"empty-state\">Velg «Start ny quiz» eller «Last siste bilde-quiz».</p>";
    document.getElementById("visual-generate-status").textContent = "";
  });

  if (!qs.answered && !qs.mcSubmitting) {
    el.querySelectorAll(".vq-option:not(:disabled)").forEach((btn) => {
      btn.addEventListener("click", () =>
        submitMc(q, btn.getAttribute("data-answer"), qs)
      );
    });
  }

  document.getElementById("visual-next")?.addEventListener("click", () => {
    if (!qs.answered) {
      return;
    }
    if (isLast) {
      el.innerHTML = `
        <section class="vq-play">
          <div class="vq-end">
            <div class="vq-end__icon" aria-hidden="true">✓</div>
            <h2 class="vq-end__title">Quizen er ferdig</h2>
            <p class="vq-end__score">Du endte med <strong>${state.totalScore}</strong> poeng totalt.</p>
            <div class="vq-end__actions">
              <button type="button" class="vq-btn-primary" id="visual-play-again">Ny runde</button>
              <button type="button" class="vq-btn-ghost" id="visual-reload-end">Bare last inn på nytt</button>
            </div>
          </div>
        </section>
      `;
      document
        .getElementById("visual-play-again")
        ?.addEventListener("click", () => {
          document.getElementById("visual-generate-button")?.click();
        });
      document
        .getElementById("visual-reload-end")
        ?.addEventListener("click", loadVisualQuiz);
      return;
    }
    state.currentIndex += 1;
    render();
  });
}

async function generateVisualQuiz() {
  const btn = document.getElementById("visual-generate-button");
  const statusEl = document.getElementById("visual-generate-status");

  btn.disabled = true;
  statusEl.innerHTML = '<span class="vq-spinner" aria-hidden="true"></span> Genererer quiz…';
  try {
    const res = await fetch(`${API_BASE}/api/internal/generate-visual-10-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof body.error === "string" ? body.error : res.statusText
      );
    }
    statusEl.textContent = "Laster inn quiz…";
    await loadVisualQuiz();
    statusEl.textContent = "";
  } catch (e) {
    statusEl.textContent =
      "Feilet: " + (e && e.message ? e.message : "ukjent");
  } finally {
    btn.disabled = false;
  }
}

function initVisualQuizPage() {
  const generateButton = document.getElementById("visual-generate-button");
  const loadButton = document.getElementById("visual-load-button");

  if (!generateButton || !loadButton) {
    console.error("[visual-quiz] Missing required controls during init");
    return;
  }

  generateButton.addEventListener("click", generateVisualQuiz);
  loadButton.addEventListener("click", () => {
    const statusEl = document.getElementById("visual-generate-status");
    statusEl.textContent = "";
    loadVisualQuiz();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVisualQuizPage);
} else {
  initVisualQuizPage();
}

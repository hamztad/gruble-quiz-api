/**
 * Prototype: bilde-10-quiz (egen presentasjon, egen API-flyt).
 * Standard frontend (app.js / index.html) brukes uendret.
 */
const API_BASE = "https://gruble-quiz-api.onrender.com";
const QUIZ_VARIANT = "visual-10";

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

async function loadVisualQuiz() {
  const el = document.getElementById("visual-app");
  el.innerHTML = "<p class=\"muted\">Laster bilde-quiz…</p>";
  try {
    const response = await fetch(`${API_BASE}/api/quiz/visual-today`);
    if (!response.ok) {
      el.innerHTML =
        "<p class=\"muted\">Ingen lagret bilde-quiz. Generer en først.</p>";
      return false;
    }
    const data = await response.json();
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
    el.innerHTML = "<p>Kunne ikke laste bilde-quiz.</p>";
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
      "<p class=\"muted\">Ingen spørsmål. Bruk «Generer bilde-quiz» over.</p>";
    return;
  }

  const q = state.questions[state.currentIndex];
  const qs = getQs(q.id);
  const isLast = state.currentIndex === state.questions.length - 1;
  const img = state.sharedImage;
  const imageTag =
    img && img.url
      ? `<figure class="visual-quiz-figure">
           <img src="${escapeHtml(img.url)}" alt="${escapeHtml(
             img.title || "Illustrasjon"
           )}" />
           <figcaption>${escapeHtml(img.credit || "")}</figcaption>
         </figure>`
      : "<p class=\"muted\">(Mangler delt bilde i denne quizen)</p>";

  const imageHint =
    q.imageQuestion === true
      ? "<p class=\"visual-quiz-meta\"><strong>Spørsmål om bildet</strong> (nr. 10)</p>"
      : "";

  let optionsHtml = "";
  if (!qs.answered) {
    const busy = qs.mcSubmitting;
    optionsHtml = `<div class="options">
      ${q.options
        .map((opt) => {
          const removed = qs.removedOptions.includes(opt);
          return `<button type="button" class="option-button ${
            removed ? "option-removed" : ""
          }" data-answer="${escapeHtml(opt)}" ${
            removed || busy ? "disabled" : ""
          }>${escapeHtml(opt)}</button>`;
        })
        .join("")}
    </div>`;
  }

  let feedbackHtml = "";
  if (qs.lastFeedback) {
    if (qs.lastFeedback.networkError) {
      feedbackHtml =
        "<p class=\"result wrong\">Nettverksfeil ved innsending.</p>";
    } else if (qs.lastFeedback.correct) {
      feedbackHtml = `<p class="result correct">Riktig. +${escapeHtml(
        String(qs.lastFeedback.points ?? 0)
      )} poeng</p>`;
    } else {
      feedbackHtml =
        "<p class=\"result wrong\">Feil — prøv et annet alternativ.</p>";
    }
  }

  el.innerHTML = `
    <div class="toolbar">
      <span class="score-pill">Total: ${state.totalScore} poeng</span>
      <button type="button" class="ghost" id="visual-reload">Last på nytt</button>
    </div>
    <p><strong>Tema:</strong> ${escapeHtml(state.theme)} · <strong>Vanskegrad:</strong> ${escapeHtml(
      state.difficulty
    )}</p>
    ${imageTag}
    <span class="question-number">Spørsmål ${state.currentIndex + 1} av ${
      state.questions.length
    }</span>
    ${imageHint}
    <h2>${escapeHtml(q.question)}</h2>
    ${optionsHtml}
    <div class="footer">
      <span class="muted">Velg svar for å gå videre.</span>
      <button type="button" id="visual-next" class="primary" ${
        qs.answered ? "" : "disabled"
      }>${isLast && qs.answered ? "Ferdig" : "Neste"}</button>
    </div>
    ${feedbackHtml}
  `;

  document.getElementById("visual-reload")?.addEventListener("click", loadVisualQuiz);

  if (!qs.answered && !qs.mcSubmitting) {
    el.querySelectorAll(".option-button:not(:disabled)").forEach((btn) => {
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
        <div class="toolbar">
          <span class="score-pill">Total: ${state.totalScore} poeng</span>
          <button type="button" class="ghost" id="visual-reload-end">Last på nytt</button>
        </div>
        <h2>Ferdig</h2>
        <p>Du endte med <strong>${state.totalScore}</strong> poeng.</p>
        <p class="muted">Variant: ${escapeHtml(state.variant || QUIZ_VARIANT)}</p>
      `;
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
  const themeInput = document.getElementById("visual-theme-input");
  const theme = (themeInput?.value ?? "").trim() || "Diverse";
  const subjectMode = Boolean(document.getElementById("visual-subject-mode")?.checked);
  const diffEl = document.getElementById("visual-difficulty");
  const dr = String(diffEl?.value ?? "normal").toLowerCase();
  const difficulty =
    dr === "easy" || dr === "hard" ? dr : "normal";

  btn.disabled = true;
  statusEl.textContent = "Genererer…";
  try {
    const res = await fetch(`${API_BASE}/api/internal/generate-visual-10-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme, subjectMode, difficulty }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof body.error === "string" ? body.error : res.statusText
      );
    }
    statusEl.textContent = "Laster inn…";
    await loadVisualQuiz();
    statusEl.textContent = "";
  } catch (e) {
    statusEl.textContent =
      "Feilet: " + (e && e.message ? e.message : "ukjent");
  } finally {
    btn.disabled = false;
  }
}

document
  .getElementById("visual-generate-button")
  ?.addEventListener("click", generateVisualQuiz);

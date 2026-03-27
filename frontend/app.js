const API_BASE = "https://gruble-quiz-api.onrender.com";

const state = {
  theme: "",
  questions: [],
  currentIndex: 0,
  totalScore: 0,
  byId: {},
};

const app = document.getElementById("app");

function getQuestionState(questionId) {
  const key = String(questionId);
  if (!state.byId[key]) {
    state.byId[key] = {
      answerMode: null,
      removedOptions: [],
      answered: false,
      lastFeedback: null,
      checkingQuestion: false,
      infoMessage: "",
      infoClass: "hint",
    };
  }
  return state.byId[key];
}

async function loadQuiz() {
  try {
    const response = await fetch(`${API_BASE}/api/quiz/today`);
    if (!response.ok) {
      app.innerHTML = "<p>Kunne ikke laste quiz.</p>";
      return false;
    }
    const data = await response.json();

    state.theme = data.theme || "";
    state.questions = Array.isArray(data.questions) ? data.questions : [];
    state.currentIndex = 0;
    state.totalScore = 0;
    state.byId = {};

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

  btn.disabled = true;
  statusEl.textContent = "Genererer quiz...";

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
          : res.statusText || "Foresporsel feilet";
      throw new Error(msg);
    }

    statusEl.textContent = "Laster oppdatert quiz...";
    const loaded = await loadQuiz();
    statusEl.textContent = loaded
      ? ""
      : "Quiz ble lagret, men kunne ikke hente dagens quiz.";
  } catch (err) {
    const msg =
      err && typeof err.message === "string" ? err.message : "Ukjent feil";
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

  let answerBlock = "";
  let resultText = "";
  let resultClass = "result";

  if (qs.checkingQuestion) {
    resultClass = "result hint";
    resultText = "Sjekker sporsmalet...";
  } else if (qs.answered && qs.lastFeedback && qs.lastFeedback.networkError) {
    resultClass = "result wrong";
    resultText = "Kunne ikke sende inn svar.";
  } else if (qs.answered && qs.lastFeedback) {
    resultClass += qs.lastFeedback.correct ? " correct" : " wrong";
    const pts = qs.lastFeedback.points;
    if (qs.answerMode === "written" && qs.lastFeedback.feedback) {
      resultText = `${qs.lastFeedback.feedback} (Poeng: ${pts})`;
    } else {
      resultText = qs.lastFeedback.correct
        ? `Riktig svar. Poeng for sporsmalet: ${pts}`
        : `Feil svar. Poeng for sporsmalet: ${pts}`;
    }
  } else if (!qs.answerMode) {
    resultText = "Velg om du vil skrive svar eller fa alternativer.";
    answerBlock = `
      <div class="mode-choice">
        <button type="button" id="mode-written">Skriv svar</button>
        <button type="button" id="mode-mc">Fa alternativer</button>
      </div>
    `;
  } else if (qs.answerMode === "mc") {
    const available = question.options.filter(
      (opt) => !qs.removedOptions.includes(opt)
    );
    if (qs.removedOptions.length > 0 && !qs.answered) {
      resultClass = "result hint";
      resultText =
        "Feil alternativ er fjernet. Prov igjen. (3 / 2 / 1 / 0 poeng ved riktig svar.)";
    } else {
      resultText =
        "Velg et svaralternativ. Forste riktige gir 3 poeng, deretter 2, 1 og 0.";
    }
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
                ${removed || qs.answered ? "disabled" : ""}
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
    resultText = "Skriv inn svar og trykk Send inn.";
    answerBlock = `
      <div class="write-box">
        <textarea id="written-answer" placeholder="Skriv svaret ditt her"></textarea>
        <div class="write-actions">
          <button type="button" class="primary" id="written-submit">Send inn</button>
          <button type="button" class="ghost" id="check-written-suitability">
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

  app.innerHTML = `
    <div class="toolbar">
      <span class="score-pill">Totalscore: ${state.totalScore} poeng</span>
      <div class="toolbar-actions">
        <button type="button" class="ghost" id="prev-button" ${
          state.currentIndex === 0 ? "disabled" : ""
        }>Forrige</button>
        <button type="button" class="ghost" id="restart-button">Start pa nytt</button>
      </div>
    </div>
    <p><strong>Tema:</strong> ${escapeHtml(state.theme)}</p>
    <span class="question-number">Sporsmal ${state.currentIndex + 1} av ${
    state.questions.length
  }</span>
    <h2>${escapeHtml(question.question)}</h2>
    ${answerBlock}
    <div id="result" class="${resultClass}">
      ${escapeHtml(resultText)}
    </div>
    <div class="footer">
      <span class="muted">Naviger nar du er klar.</span>
      <button type="button" id="next-button" class="primary" ${
        qs.answered ? "" : "disabled"
      }>
        ${isLast && qs.answered ? "Ferdig" : "Neste"}
      </button>
    </div>
  `;

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
      if (!qs.answered) {
        return;
      }
      if (isLast) {
        app.innerHTML = `
          <div class="toolbar">
            <span class="score-pill">Totalscore: ${state.totalScore} poeng</span>
            <button type="button" class="ghost" id="restart-end">Start pa nytt</button>
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
  const questionId = question.id;
  const attemptNumber = qs.removedOptions.length + 1;
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
      qs.lastFeedback = { networkError: true };
      render();
      return;
    }

    if (result.correct) {
      qs.answered = true;
      qs.lastFeedback = {
        correct: true,
        points: result.points,
      };
      state.totalScore += Number(result.points) || 0;
    } else {
      if (!qs.removedOptions.includes(answer)) {
        qs.removedOptions.push(answer);
      }
      qs.lastFeedback = { correct: false, points: 0 };
    }
    render();
  } catch (error) {
    qs.answered = true;
    qs.lastFeedback = { networkError: true };
    render();
  }
}

async function checkQuestionSuitability(question, qs) {
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

    if (!response.ok) {
      qs.infoClass = "wrong";
      qs.infoMessage =
        typeof result.error === "string"
          ? result.error
          : "Kunne ikke sjekke sporsmalet.";
      render();
      return;
    }

    if (result.valid) {
      qs.infoClass = "hint";
      qs.infoMessage =
        typeof result.message === "string"
          ? result.message
          : "Dette sporsmalet kan besvares skriftlig.";
      render();
      return;
    }

    const replacement = result.question;
    if (!replacement || typeof replacement.question !== "string") {
      qs.infoClass = "wrong";
      qs.infoMessage = "Fikk ikke et nytt sporsmal tilbake.";
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
      checkingQuestion: false,
      infoMessage: `${result.message} Du fikk ${
        Number(result.points) || 0
      } poeng. Her er et nytt sporsmal.`,
      infoClass: "correct",
    };
    render();
  } catch (error) {
    qs.checkingQuestion = false;
    qs.infoClass = "wrong";
    qs.infoMessage = "Kunne ikke sjekke sporsmalet.";
    render();
  }
}

async function submitWritten(question, answer, qs) {
  const questionId = question.id;
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
      render();
      return;
    }

    qs.answered = true;
    qs.lastFeedback = {
      correct: Boolean(result.correct),
      points: result.points,
      feedback: typeof result.feedback === "string" ? result.feedback : "",
    };
    state.totalScore += Number(result.points) || 0;
    render();
  } catch (error) {
    qs.answered = true;
    qs.lastFeedback = { networkError: true };
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

const generateQuizButton = document.getElementById("generate-quiz-button");
if (generateQuizButton) {
  generateQuizButton.addEventListener("click", () => {
    generateNewQuiz();
  });
}

loadQuiz();

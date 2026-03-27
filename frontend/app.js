const API_BASE = "https://gruble-quiz-api.onrender.com";

const state = {
  theme: "",
  questions: [],
  currentIndex: 0,
  totalScore: 0,
  byId: {},
};

const app = document.getElementById("app");

let protestTargetQuestion = null;

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
    const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
    state.questions = shuffleQuizOptions(rawQuestions);
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
  statusEl.textContent = "Genererer quiz…";

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

    statusEl.textContent = "Laster oppdatert quiz…";
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
    resultText = "Sjekker spørsmålet…";
  } else if (qs.answered && qs.lastFeedback && qs.lastFeedback.networkError) {
    resultClass = "result wrong";
    resultText = "Kunne ikke sende inn svar.";
  } else if (qs.answered && qs.lastFeedback) {
    resultClass += qs.lastFeedback.correct ? " correct" : " wrong";
    const pts = qs.lastFeedback.points;
    if (qs.answerMode === "written") {
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
    const available = question.options.filter(
      (opt) => !qs.removedOptions.includes(opt)
    );
    if (qs.removedOptions.length > 0 && !qs.answered) {
      resultClass = "result hint";
      resultText =
        "Feil alternativ er fjernet. Prøv igjen. (3 / 2 / 1 / 0 poeng ved riktig svar.)";
    } else {
      resultText =
        "Velg et svaralternativ. Første riktige gir 3 poeng, deretter 2, 1 og 0.";
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
          <button
            type="button"
            class="ghost voice-mic-btn"
            data-voice-target="written-answer"
            data-voice-status="written-voice-status"
            aria-label="Tale inn svar"
          >
            Tale
          </button>
          <span class="voice-status" id="written-voice-status" aria-live="polite"></span>
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

  let resultContent;
  if (
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
    const feedbackPart = feedback
      ? `${escapeHtml(feedback)} `
      : "";
    resultContent = `
      <div class="feedback-written">
        <p class="feedback-user-heading"><strong>Ditt svar:</strong></p>
        <p class="feedback-user-quote"><em>&quot;${escapeHtml(quote)}&quot;</em></p>
        <div class="feedback-divider" aria-hidden="true"></div>
        <p class="feedback-verdict">Vurdering og poeng: ${feedbackPart}<strong>${escapeHtml(
      String(ptsDisplay)
    )} poeng</strong></p>
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
        <button type="button" class="ghost" id="protest-open-button">Protester</button>
        <button type="button" class="ghost" id="restart-button">Start på nytt</button>
      </div>
    </div>
    <p><strong>Tema:</strong> ${escapeHtml(state.theme)}</p>
    <span class="question-number">Spørsmål ${state.currentIndex + 1} av ${
    state.questions.length
  }</span>
    <h2>${escapeHtml(question.question)}</h2>
    ${answerBlock}
    <div id="result" class="${resultClass}">
      ${resultContent}
    </div>
    <div class="footer">
      <span class="muted">Naviger når du er klar.</span>
      <button type="button" id="next-button" class="primary" ${
        qs.answered ? "" : "disabled"
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
      if (!qs.answered) {
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
    qs.infoClass = "wrong";
    qs.infoMessage = "Kunne ikke sjekke spørsmålet.";
    render();
  }
}

async function submitWritten(question, answer, qs) {
  const questionId = question.id;
  qs.submittedAnswer = String(answer ?? "").trim();
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

const VOICE_MAX_MS = 60000;
const VOICE_MIN_BYTES = 100;

let voiceRecorder = null;
let voiceChunks = [];
let voiceAutoStopTimer = null;
let voiceActiveCtx = null;

function setVoiceStatus(el, text, isError) {
  if (!el) {
    return;
  }
  el.textContent = text || "";
  el.classList.toggle("voice-status--error", Boolean(isError));
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
    if (voiceAutoStopTimer) {
      clearTimeout(voiceAutoStopTimer);
      voiceAutoStopTimer = null;
    }
    ctx.button.classList.remove("voice-mic-btn--recording");
    voiceRecorder = null;
    voiceActiveCtx = null;

    const blob = new Blob(voiceChunks, {
      type: ctx.mr.mimeType || "audio/webm",
    });
    voiceChunks = [];

    if (blob.size < VOICE_MIN_BYTES) {
      setVoiceStatus(ctx.statusEl, "Ingen lyd fanget. Prøv igjen.", true);
      return;
    }

    setVoiceStatus(ctx.statusEl, "Behandler...");
    ctx.button.disabled = true;

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
    }
  });

  mr.start(200);
  ctx.button.classList.add("voice-mic-btn--recording");
  setVoiceStatus(ctx.statusEl, "Lytter...");
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

function setProtestOutput(html, variant) {
  const el = document.getElementById("protest-output");
  if (!el) {
    return;
  }
  el.className =
    "protest-output" + (variant ? ` protest-output--${variant}` : "");
  el.innerHTML = html;
}

function openProtestModal(question) {
  protestTargetQuestion = question;
  const msg = document.getElementById("protest-message");
  const typeEl = document.getElementById("protest-type");
  const submitBtn = document.getElementById("protest-submit");
  if (msg) {
    msg.value = "";
  }
  if (typeEl) {
    typeEl.selectedIndex = 0;
  }
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send inn";
  }
  setProtestOutput("", "");
  setProtestModalVisible(true);
  if (msg) {
    msg.focus();
  }
}

function closeProtestModal() {
  protestTargetQuestion = null;
  const submitBtn = document.getElementById("protest-submit");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send inn";
  }
  setProtestModalVisible(false);
}

async function submitProtest() {
  const submitBtn = document.getElementById("protest-submit");
  const typeEl = document.getElementById("protest-type");
  const msgEl = document.getElementById("protest-message");

  if (!protestTargetQuestion) {
    setProtestOutput(
      "<p>Kunne ikke knytte protesten til et spørsmål. Lukk og prøv igjen.</p>",
      "error"
    );
    return;
  }

  const options = Array.isArray(protestTargetQuestion.options)
    ? protestTargetQuestion.options
    : [];
  if (options.length < 2) {
    setProtestOutput(
      "<p>Dette spørsmålet mangler alternativer som kreves for protest.</p>",
      "error"
    );
    return;
  }

  const userMessage = (msgEl?.value ?? "").trim();
  if (!userMessage) {
    setProtestOutput("<p>Skriv en kort begrunnelse.</p>", "error");
    return;
  }

  const protestType = (typeEl?.value ?? "").trim();
  if (!protestType) {
    setProtestOutput("<p>Velg protesttype.</p>", "error");
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Vurderer…";
  }
  setProtestOutput("<p>Vurderer protesten…</p>", "loading");

  let response;
  let data = {};
  try {
    response = await fetch(`${API_BASE}/api/quiz/protest`, {
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
    try {
      data = await response.json();
    } catch {
      data = { error: "Ugyldig JSON fra serveren." };
    }
  } catch {
    setProtestOutput(
      "<p>Nettverksfeil. Sjekk tilkoblingen og prøv igjen.</p>",
      "error"
    );
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send inn";
    }
    return;
  }

  if (!response.ok) {
    const errText =
      typeof data.error === "string" && data.error.trim()
        ? data.error
        : "Forespørselen feilet.";
    setProtestOutput(`<p>${escapeHtml(errText)}</p>`, "error");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send inn";
    }
    return;
  }

  const status = typeof data.status === "string" ? data.status : "rejected";
  const points = Number(data.points);
  const ptsDisplay = Number.isFinite(points) ? points : 0;
  const feedback =
    typeof data.feedback === "string" ? data.feedback : "Ingen forklaring.";

  state.totalScore += ptsDisplay;
  render();

  setProtestOutput(
    `<p><strong>Status:</strong> ${escapeHtml(
      protestStatusLabel(status)
    )}</p>` +
      `<p><strong>Poeng:</strong> ${escapeHtml(String(ptsDisplay))}</p>` +
      `<p><strong>Forklaring:</strong> ${escapeHtml(feedback)}</p>`,
    "ok"
  );

  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send inn";
  }
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
      submitProtest();
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

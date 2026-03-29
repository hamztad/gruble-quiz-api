/**
 * Bilde-quiz (visual-10) — samme API- og svarflyt som hovedquizen (app.js).
 */
const API_BASE = "https://gruble-quiz-api.onrender.com";
const QUIZ_VARIANT = "visual-10";
const QUESTION_COUNT = 10;
const MAX_PROTEST_USER_MESSAGES = 5;

const VOICE_SVG_MIC = `<svg class="voice-mic-btn__svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6.2 6.72V21h2v-3.28c3.48-.49 6.2-3.31 6.2-6.72h-1.7z"/></svg>`;
const VOICE_SVG_STOP = `<svg class="voice-mic-btn__svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6V6z"/></svg>`;

const state = {
  theme: "",
  difficulty: "normal",
  variant: "",
  sharedImage: null,
  questions: [],
  currentIndex: 0,
  totalScore: 0,
  byId: {},
  protestStateByQuestionId: {},
};

let protestTargetQuestion = null;
let protestSubmitInFlight = false;
let protestSession = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      answerMode: null,
      removedOptions: [],
      answered: false,
      lastFeedback: null,
      submittedAnswer: null,
      mcSubmitting: false,
      writtenSubmitting: false,
      pendingWrittenDisplay: undefined,
      writtenComposeSnapshot: undefined,
      infoMessage: "",
      infoClass: "hint",
      underRevision: false,
      removedFromSession: false,
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

function loadingInlineRow(text) {
  return `<div class="loading-inline" role="status"><span class="vq-spinner" aria-hidden="true"></span><span class="sr-only">${escapeHtml(
    text
  )}</span></div>`;
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

function protestRemovesQuestionFromSession(status) {
  const s = String(status ?? "").toLowerCase();
  return s === "approved" || s === "partial";
}

function applyProtestRevisionSuccess(questionId) {
  const qs = getQs(questionId);
  qs.underRevision = true;
  qs.removedFromSession = true;
  qs.answered = true;
  state.protestStateByQuestionId[String(questionId)] = { status: "finalized" };
  protestSession = null;
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

function advanceToNextPlayableQuestionVisual() {
  let next = state.currentIndex + 1;
  while (next < state.questions.length) {
    const q = state.questions[next];
    if (!getQs(q.id).underRevision) {
      state.currentIndex = next;
      render();
      return;
    }
    next += 1;
  }
  render();
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId,
        answer,
        mode: "mc",
        attemptNumber,
        questionOverride: getQuestionOverride(question),
        quizVariant: QUIZ_VARIANT,
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
  } catch {
    qs.answered = true;
    qs.lastFeedback = { networkError: true, selectedAnswer: answer };
  } finally {
    qs.mcSubmitting = false;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId,
        answer,
        mode: "written",
        questionOverride: getQuestionOverride(question),
        quizVariant: QUIZ_VARIANT,
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
  } catch {
    qs.answered = true;
    qs.lastFeedback = { networkError: true };
  } finally {
    qs.writtenSubmitting = false;
    qs.pendingWrittenDisplay = undefined;
    render();
  }
}

async function loadVisualQuiz() {
  const el = document.getElementById("visual-app");
  el.innerHTML =
    "<p class=\"empty-state\"><span class=\"vq-spinner\" aria-hidden=\"true\"></span> Laster…</p>";
  try {
    const response = await fetch(`${API_BASE}/api/quiz/visual-today`);
    if (!response.ok) {
      el.innerHTML =
        "<p class=\"empty-state\">Ingen lagret runde. Trykk Start.</p>";
      return false;
    }
    const data = await response.json();
    if (!isValidVisualQuizPayload(data)) {
      el.innerHTML =
        "<p class=\"empty-state\">Ugyldig runde. Start på nytt.</p>";
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
    state.protestStateByQuestionId = {};
    protestSession = null;
    protestTargetQuestion = null;
    render();
    return true;
  } catch {
    el.innerHTML =
      "<p class=\"empty-state\">Nettverksfeil. Prøv igjen.</p>";
    return false;
  }
}

function render() {
  const el = document.getElementById("visual-app");
  if (!state.questions.length) {
    el.innerHTML =
      "<p class=\"empty-state\">Ingen runde lastet.</p>";
    return;
  }
  if (state.questions.length !== QUESTION_COUNT) {
    el.innerHTML =
      "<p class=\"empty-state\">Ugyldig runde.</p>";
    return;
  }

  const question = state.questions[state.currentIndex];
  const qs = getQs(question.id);
  const idx = state.currentIndex;
  const n = state.questions.length;
  const isLast = idx === n - 1;
  const img = state.sharedImage;
  const revisionMode = Boolean(qs.underRevision);

  const creditLine = String(img?.credit ?? "").trim();
  const captionInner = creditLine
    ? escapeHtml(creditLine)
    : '<span class="vq-image-credit__fallback">Kilde ikke oppgitt</span>';
  const imageBlock =
    img && img.url
      ? `<figure class="vq-image-frame">
           <img src="${escapeHtml(img.url)}" alt="${escapeHtml(
             img.title || "Illustrasjon til quizen"
           )}" loading="lazy" />
           <figcaption class="vq-image-credit">${captionInner}</figcaption>
         </figure>`
      : `<p class="vq-image-missing">Mangler bilde.</p>`;

  let answerBlock = "";
  let resultText = "";
  let resultClass = "result";

  if (revisionMode) {
    answerBlock = "";
    resultClass = "result hint";
    resultText = "";
  } else if (qs.answered && qs.lastFeedback && qs.lastFeedback.networkError) {
    resultClass = "result wrong";
    resultText = qs.answerMode === "mc" ? "" : "Kunne ikke sende.";
  } else if (qs.answered && qs.lastFeedback) {
    resultClass += qs.lastFeedback.correct ? " correct" : " wrong";
    if (!(qs.answerMode === "written" || qs.answerMode === "mc")) {
      const pts = qs.lastFeedback.points;
      resultText = qs.lastFeedback.correct
        ? `Riktig · ${pts} poeng`
        : `Feil · ${pts} poeng`;
    } else {
      resultText = "";
    }
  } else if (!qs.answerMode) {
    resultText = "";
    answerBlock = `
      <div class="mode-choice">
        <button type="button" class="primary" id="mode-written">Skriv svar</button>
        <button type="button" class="ghost" id="mode-mc">Alternativer</button>
      </div>
    `;
  } else if (qs.answerMode === "mc") {
    if (qs.mcSubmitting) {
      resultClass = "result hint";
      resultText = "";
    }
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
      resultText = "";
    } else {
      resultText = "";
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
    `;
  } else if (qs.answerMode === "written") {
    if (qs.writtenSubmitting) {
      resultClass = "result hint";
      resultText = "";
    } else {
      resultText = "";
    }
    const formBusy = qs.writtenSubmitting;
    const writtenTaText =
      qs.writtenSubmitting && typeof qs.pendingWrittenDisplay === "string"
        ? qs.pendingWrittenDisplay
        : typeof qs.writtenComposeSnapshot === "string"
          ? qs.writtenComposeSnapshot
          : "";
    answerBlock = `
      <div class="write-box">
        <textarea id="written-answer" placeholder="Svar"${
          formBusy ? " readonly" : ""
        }>${escapeHtml(writtenTaText)}</textarea>
        <div class="write-actions">
          <button type="button" class="primary" id="written-submit"${
            formBusy ? ' data-form-lock="1"' : ""
          }>Send</button>
          <button
            type="button"
            class="ghost voice-mic-btn voice-mic-btn--round"
            data-voice-target="written-answer"
            data-voice-status="written-voice-status"
            aria-label="Start taleopptak"
            ${formBusy ? "disabled" : ""}
          ><span class="voice-mic-btn__inner">${VOICE_SVG_MIC}</span></button>
          <span class="voice-status" id="written-voice-status" aria-live="polite"></span>
        </div>
      </div>
    `;
  }

  if (!qs.answered && qs.infoMessage) {
    resultClass = `result ${qs.infoClass || "hint"}`;
    resultText = qs.infoMessage;
  }

  let resultContent;
  if (qs.writtenSubmitting) {
    resultContent = loadingInlineRow("Sender svar");
  } else if (qs.mcSubmitting) {
    resultContent = loadingInlineRow("Registrerer svar");
  } else if (revisionMode) {
    resultContent =
      '<p class="revision-placeholder vq-feedback-minimal vq-feedback-minimal--neutral">Revideres.</p>';
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.answerMode === "mc" &&
    qs.lastFeedback.networkError
  ) {
    resultContent = `<p class="vq-feedback-minimal vq-feedback-minimal--bad">Kunne ikke sende.</p>`;
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.answerMode === "mc" &&
    !qs.lastFeedback.networkError
  ) {
    const ptsRaw = qs.lastFeedback.points;
    const ptsNum = Number(ptsRaw);
    const ptsDisplay = Number.isFinite(ptsNum) ? ptsNum : 0;
    const mcClass = qs.lastFeedback.correct
      ? "vq-feedback-minimal--ok"
      : "vq-feedback-minimal--bad";
    const mcLine = qs.lastFeedback.correct
      ? `Riktig. <span class="vq-feedback-pts">${escapeHtml(String(ptsDisplay))} poeng</span>`
      : `Feil. <span class="vq-feedback-pts">${escapeHtml(String(ptsDisplay))} poeng</span>`;
    resultContent = `<p class="vq-feedback-minimal ${mcClass}">${mcLine}</p>`;
  } else if (
    !qs.answered &&
    qs.answerMode === "mc" &&
    qs.lastFeedback &&
    typeof qs.lastFeedback.selectedAnswer === "string" &&
    qs.lastFeedback.selectedAnswer &&
    !qs.lastFeedback.correct &&
    !qs.lastFeedback.networkError
  ) {
    resultContent = `<p class="vq-feedback-minimal vq-feedback-minimal--bad">Feil. Prøv igjen.</p>`;
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
    const writtenOk = Boolean(qs.lastFeedback.correct);
    const wClass = writtenOk ? "vq-feedback-minimal--ok" : "vq-feedback-minimal--bad";
    const wLine = writtenOk
      ? `Riktig. <span class="vq-feedback-pts">${escapeHtml(String(ptsDisplay))} poeng</span>`
      : `Feil. <span class="vq-feedback-pts">${escapeHtml(String(ptsDisplay))} poeng</span>`;
    resultContent = `
      <div class="vq-feedback-written-stack">
        <p class="vq-feedback-minimal ${wClass}">${wLine}</p>
        ${evalSection}
      </div>
    `;
  } else if (
    qs.answered &&
    qs.lastFeedback &&
    qs.lastFeedback.networkError &&
    qs.answerMode === "written"
  ) {
    resultContent = `<p class="vq-feedback-minimal vq-feedback-minimal--bad">Kunne ikke sende.</p>`;
  } else {
    resultContent = escapeHtml(resultText);
  }

  const protestBtn = revisionMode
    ? ""
    : '<button type="button" class="ghost" id="protest-open-button">Protester</button>';

  el.innerHTML = `
    <section class="vq-play">
      <header class="vq-play__header">
        <div class="vq-pills">
          <span class="vq-pill vq-pill--score">${state.totalScore} poeng</span>
        </div>
        <div class="vq-play__header-actions">
          ${protestBtn}
          <button type="button" class="vq-btn-ghost" id="visual-reload">Nytt</button>
        </div>
      </header>

      <div class="vq-progress-block">
        <div class="vq-progress-label">
          <span><strong>${idx + 1}</strong> / ${n}</span>
        </div>
        <div class="vq-progress-bar-wrap" aria-hidden="true">
          <div class="vq-progress-bar" style="width:${progressPercent(idx)}%"></div>
        </div>
        ${buildStepDots(idx)}
      </div>

      <div class="vq-image-wrap">${imageBlock}</div>

      <div class="vq-question-block">
        ${
          revisionMode
            ? '<h2 class="vq-question-title revision-heading">Revideres.</h2>'
            : `<h2 class="vq-question-title">${escapeHtml(question.question)}</h2>`
        }
        ${answerBlock}
        <div id="result" class="${resultClass}">${resultContent}</div>
        <footer class="vq-footer">
          <button type="button" class="vq-btn-next" id="visual-next" ${
            qs.answered || revisionMode ? "" : "disabled"
          }>${isLast && qs.answered ? "Resultat" : "Neste"}</button>
        </footer>
      </div>
    </section>
  `;

  document.getElementById("visual-reload")?.addEventListener("click", () => {
    state.questions = [];
    state.currentIndex = 0;
    state.protestStateByQuestionId = {};
    protestSession = null;
    protestTargetQuestion = null;
    el.innerHTML =
      "<p class=\"empty-state\">Trykk Start eller Last lagret.</p>";
    document.getElementById("visual-generate-status").textContent = "";
  });

  document.getElementById("protest-open-button")?.addEventListener("click", () => {
    openProtestModal(question);
  });

  if (!qs.answered && !qs.answerMode) {
    document.getElementById("mode-written")?.addEventListener("click", () => {
      qs.answerMode = "written";
      qs.writtenComposeSnapshot = "";
      qs.lastFeedback = null;
      render();
    });
    document.getElementById("mode-mc")?.addEventListener("click", () => {
      qs.answerMode = "mc";
      qs.removedOptions = [];
      qs.lastFeedback = null;
      render();
    });
  }

  if (!qs.answered && qs.answerMode === "mc") {
    el.querySelectorAll(".option-button:not(:disabled)").forEach((button) => {
      button.addEventListener("click", () =>
        submitMultipleChoice(question, button.dataset.answer, qs)
      );
    });
  }

  if (!qs.answered && qs.answerMode === "written") {
    const ta = document.getElementById("written-answer");
    if (ta) {
      ta.addEventListener("input", () => {
        qs.writtenComposeSnapshot = ta.value;
      });
    }
    document.getElementById("written-submit")?.addEventListener("click", () => {
      const text = document.getElementById("written-answer")?.value ?? "";
      submitWritten(question, text, qs);
    });
  }

  document.getElementById("visual-next")?.addEventListener("click", () => {
    if (!qs.answered && !revisionMode) {
      return;
    }
    if (isLast) {
      el.innerHTML = `
        <section class="vq-play">
          <div class="vq-end">
            <div class="vq-end__icon" aria-hidden="true">✓</div>
            <h2 class="vq-end__title">Ferdig</h2>
            <p class="vq-end__score"><strong>${state.totalScore}</strong> poeng</p>
            <div class="vq-end__actions">
              <button type="button" class="vq-btn-primary" id="visual-play-again">Ny runde</button>
              <button type="button" class="vq-btn-ghost" id="visual-reload-end">Last på nytt</button>
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
    while (
      state.currentIndex < state.questions.length &&
      getQs(state.questions[state.currentIndex].id).underRevision
    ) {
      state.currentIndex += 1;
    }
    if (state.currentIndex >= state.questions.length) {
      state.currentIndex = state.questions.length - 1;
    }
    render();
  });

  applyWrittenAnswerSubmitVoiceLock();
}

async function generateVisualQuiz() {
  const btn = document.getElementById("visual-generate-button");
  const statusEl = document.getElementById("visual-generate-status");

  btn.disabled = true;
  statusEl.innerHTML = '<span class="vq-spinner" aria-hidden="true"></span> Venter…';
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
    statusEl.textContent = "";
    await loadVisualQuiz();
    statusEl.textContent = "";
  } catch (e) {
    statusEl.textContent =
      "Feilet: " + (e && e.message ? e.message : "ukjent");
  } finally {
    btn.disabled = false;
  }
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
    const pq = getQs(question.id);
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
      advanceToNextPlayableQuestionVisual();
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
function initVisualQuizPage() {
  initProtestModal();
  initVoiceInputDelegation();

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

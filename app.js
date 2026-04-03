const modeButtonElements = document.querySelectorAll(".mode-button");
const recordButton = document.getElementById("recordButton");
const retryButton = document.getElementById("retryButton");
const clearButton = document.getElementById("clearButton");
const speakButton = document.getElementById("speakButton");
const promptChip = document.getElementById("promptChip");
const statusText = document.getElementById("statusText");
const transcriptOutput = document.getElementById("transcriptOutput");
const livePreview = document.getElementById("livePreview");
const voiceStatus = document.getElementById("voiceStatus");
const deviceTip = document.getElementById("deviceTip");
const wave = document.getElementById("wave");
const historyList = document.getElementById("historyList");
const historyEmptyState = document.getElementById("historyEmptyState");
const clearHistoryButton = document.getElementById("clearHistoryButton");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const USER_AGENT = navigator.userAgent || "";
const IS_IOS =
  /iPad|iPhone|iPod/.test(USER_AGENT) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(USER_AGENT);
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(USER_AGENT) || navigator.maxTouchPoints > 1;
const HISTORY_STORAGE_KEY = "malrang-speech-history-v1";
const HISTORY_LIMIT = 40;
const IS_GITHUB_PAGES = window.location.hostname.endsWith("github.io");

const modeCopy = {
  word: {
    prompt: "예시: 토끼, 바나나, 무지개",
    readyStatus: "준비됐어요. 버튼을 누르고 한 단어를 말한 뒤 한 번 더 눌러 마쳐주세요.",
    guide: "단어 한 개를 천천히 말해보세요."
  },
  sentence: {
    prompt: "예시: 오늘은 비가 와요, 저는 노란 우산이 좋아요",
    readyStatus: "준비됐어요. 버튼을 누르고 짧은 문장을 말한 뒤 한 번 더 눌러 마쳐주세요.",
    guide: "짧은 문장을 천천히 말해보세요."
  }
};

let currentMode = "word";
let currentTranscript = "";
let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let playbackAudio = null;
let playbackUrl = null;
let isRecording = false;
let isTranscribing = false;
let isGeneratingSpeech = false;
let restartAfterStop = false;
let discardOnStop = false;
let browserRecognition = null;
let browserInterimTranscript = "";
let browserRecognizedText = "";
let browserVoices = [];
let selectedBrowserVoice = null;
let speechHistory = [];

const serverConfig = {
  hasOpenAIKey: false,
  sttModel: "",
  ttsModel: "",
  ttsVoice: "",
  voiceLabel: ""
};

function setMode(mode) {
  if (isRecording || isTranscribing) {
    return;
  }

  currentMode = mode;
  modeButtonElements.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  promptChip.textContent = modeCopy[mode].prompt;

  if (!currentTranscript && !isRecording) {
    statusText.textContent = modeCopy[mode].readyStatus;
    livePreview.textContent = modeCopy[mode].guide;
  }
}

function normalizeTranscript(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function renderTranscript(text) {
  currentTranscript = text;
  transcriptOutput.textContent = text || "여기에 들은 말이 나타나요.";
  transcriptOutput.classList.toggle("empty", !text);
  transcriptOutput.classList.toggle("ready", Boolean(text));
}

function loadSpeechHistory() {
  try {
    const savedHistory = window.localStorage.getItem(HISTORY_STORAGE_KEY);

    if (!savedHistory) {
      speechHistory = [];
      renderSpeechHistory();
      return;
    }

    const parsedHistory = JSON.parse(savedHistory);
    speechHistory = Array.isArray(parsedHistory) ? parsedHistory.slice(0, HISTORY_LIMIT) : [];
  } catch (error) {
    speechHistory = [];
  }

  renderSpeechHistory();
}

function saveSpeechHistory() {
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(speechHistory));
}

function renderSpeechHistory() {
  historyList.innerHTML = "";
  historyEmptyState.hidden = speechHistory.length > 0;

  speechHistory.forEach((entry) => {
    const listItem = document.createElement("li");
    listItem.className = "history-card";

    const badgeClassName = entry.mode === "sentence" ? "history-badge sentence" : "history-badge";
    listItem.innerHTML = `
      <div class="history-meta">
        <span class="${badgeClassName}">${entry.mode === "sentence" ? "문장 놀이" : "단어 놀이"}</span>
        <span class="history-time">${formatHistoryTime(entry.createdAt)}</span>
        <span class="history-source">${entry.sourceLabel}</span>
      </div>
      <p class="history-text">${escapeHtml(entry.text)}</p>
    `;

    historyList.append(listItem);
  });
}

function addSpeechHistoryEntry(text, source) {
  const normalizedText = normalizeTranscript(text);

  if (!normalizedText) {
    return;
  }

  const nextEntry = {
    id: globalThis.crypto?.randomUUID?.() || `history-${Date.now()}`,
    text: normalizedText,
    mode: currentMode,
    source,
    sourceLabel: source === "ai" ? "AI 기록" : "기본 기록",
    createdAt: new Date().toISOString()
  };

  speechHistory = [nextEntry, ...speechHistory].slice(0, HISTORY_LIMIT);
  saveSpeechHistory();
  renderSpeechHistory();
}

function clearSpeechHistory() {
  speechHistory = [];
  window.localStorage.removeItem(HISTORY_STORAGE_KEY);
  renderSpeechHistory();
}

function formatHistoryTime(isoString) {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(isoString));
  } catch (error) {
    return isoString;
  }
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function updateRecordingState(recording) {
  isRecording = recording;
  recordButton.classList.toggle("listening", recording);
  recordButton.setAttribute("aria-pressed", String(recording));
  recordButton.querySelector(".record-text").textContent = recording ? "듣기 끝" : "말 시작";
  wave.classList.toggle("is-active", recording);
  updateControlAvailability();
}

function updateDeviceTip() {
  if (!deviceTip) {
    return;
  }

  if (!IS_MOBILE) {
    deviceTip.textContent = "컴퓨터와 휴대폰에서 모두 열 수 있어요. 휴대폰은 마이크 권한 허용이 먼저예요.";
    return;
  }

  if (serverConfig.hasOpenAIKey) {
    deviceTip.textContent = IS_IOS
      ? "아이폰에서는 마이크 권한을 허용하면 사용할 수 있어요. 더 안정적인 건 서버형 AI 모드예요."
      : "안드로이드 휴대폰에서는 마이크 권한을 허용하면 바로 사용할 수 있어요.";
    return;
  }

  if (SpeechRecognition) {
    deviceTip.textContent = IS_ANDROID
      ? "무료 모드는 안드로이드 Chrome이나 Edge에서 가장 잘 동작해요."
      : "무료 모드는 휴대폰 브라우저 지원 차이가 커요. 안 되면 서버형 AI 모드가 더 안정적이에요.";
    return;
  }

  deviceTip.textContent = IS_IOS
    ? "아이폰 무료 모드는 기본 음성인식 지원이 제한될 수 있어요. 휴대폰에서 안정적으로 쓰려면 서버형 AI 배포가 좋아요."
    : "이 휴대폰 브라우저는 무료 기본 음성인식을 지원하지 않을 수 있어요. Chrome이나 Edge를 추천해요.";
}

function updateControlAvailability() {
  const canRecord = serverConfig.hasOpenAIKey || Boolean(SpeechRecognition);
  const canSpeak = serverConfig.hasOpenAIKey || Boolean(window.speechSynthesis);
  const blocked = isTranscribing;

  recordButton.disabled = blocked || !canRecord;
  retryButton.disabled = blocked || !canRecord;
  clearButton.disabled = isTranscribing;
  speakButton.disabled = !currentTranscript || blocked || isGeneratingSpeech || isRecording || !canSpeak;
}

function stopPlayback() {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  if (playbackAudio) {
    playbackAudio.pause();
    playbackAudio.src = "";
    playbackAudio = null;
  }

  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = null;
  }

  isGeneratingSpeech = false;
  updateControlAvailability();
}

function getPreferredMimeType() {
  if (!window.MediaRecorder) {
    return "";
  }

  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function getFileExtension(mimeType) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  return "webm";
}

function chooseBestKoreanVoice(voices) {
  if (!voices.length) {
    return null;
  }

  return voices
    .map((voice) => ({
      voice,
      score: scoreVoice(voice)
    }))
    .sort((first, second) => second.score - first.score)[0]?.voice || null;
}

function scoreVoice(voice) {
  const name = voice.name.toLowerCase();
  const lang = voice.lang.toLowerCase();
  let score = 0;

  if (lang === "ko-kr") {
    score += 50;
  } else if (lang.startsWith("ko")) {
    score += 30;
  }

  if (voice.default) {
    score += 8;
  }

  if (voice.localService) {
    score += 6;
  }

  if (/google|microsoft|apple|samsung/.test(name)) {
    score += 8;
  }

  if (/yuna|sora|sunhi|seoyeon|minji|narae|jihyun|ara/.test(name)) {
    score += 16;
  }

  if (/compact|novelty/.test(name)) {
    score -= 10;
  }

  return score;
}

function loadBrowserVoices() {
  if (!window.speechSynthesis) {
    return;
  }

  browserVoices = window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith("ko"));

  selectedBrowserVoice = chooseBestKoreanVoice(browserVoices);

  if (!serverConfig.hasOpenAIKey) {
    voiceStatus.textContent = selectedBrowserVoice
      ? `기본 목소리: ${selectedBrowserVoice.name} · AI 키를 넣으면 더 자연스러운 음성으로 바뀌어요.`
      : "기본 모드: AI 키가 없어서 브라우저 기본 음성으로 동작해요.";
  }
}

function prepareSpeechChunks(text) {
  const normalized = normalizeTranscript(text);

  if (!normalized) {
    return [];
  }

  const punctuated =
    currentMode === "sentence" && !/[.!?]$/.test(normalized)
      ? `${normalized}.`
      : normalized;

  const sentenceChunks =
    punctuated.match(/[^,.!?]+[,.!?]?/g)?.map((chunk) => chunk.trim()).filter(Boolean) || [];

  return sentenceChunks.flatMap((chunk) => splitLongChunk(chunk));
}

function splitLongChunk(chunk) {
  const plainLength = chunk.replace(/\s/g, "").length;

  if (plainLength <= 18) {
    return [chunk];
  }

  const trailingPunctuation = /[,.!?]$/.test(chunk) ? chunk[chunk.length - 1] : "";
  const baseText = trailingPunctuation ? chunk.slice(0, -1).trim() : chunk;
  const words = baseText.split(" ").filter(Boolean);

  if (words.length <= 1) {
    const pieces = [];

    for (let index = 0; index < baseText.length; index += 12) {
      pieces.push(baseText.slice(index, index + 12));
    }

    if (trailingPunctuation && pieces.length) {
      pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}${trailingPunctuation}`;
    }

    return pieces;
  }

  const pieces = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.replace(/\s/g, "").length <= 16) {
      current = candidate;
      return;
    }

    if (current) {
      pieces.push(current);
    }

    current = word;
  });

  if (current) {
    pieces.push(current);
  }

  if (trailingPunctuation && pieces.length) {
    pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}${trailingPunctuation}`;
  }

  return pieces;
}

async function loadServerConfig() {
  if (IS_GITHUB_PAGES) {
    loadBrowserVoices();
    voiceStatus.textContent = selectedBrowserVoice
      ? `GitHub Pages 무료 모드 · 기본 목소리: ${selectedBrowserVoice.name}`
      : "GitHub Pages 무료 모드 · 브라우저 기본 음성으로 동작해요.";
    statusText.textContent = SpeechRecognition
      ? "무료 GitHub Pages 모드예요. 마이크를 눌러 바로 테스트할 수 있어요."
      : "이 브라우저는 기본 음성인식을 지원하지 않아요. Chrome이나 Edge를 추천해요.";
    livePreview.textContent = SpeechRecognition
      ? "AI 서버 없이도 기본 음성인식과 기록장 기능을 쓸 수 있어요."
      : "GitHub Pages에서는 AI 서버 없이 동작하므로 지원 브라우저가 필요해요.";
    updateDeviceTip();
    updateControlAvailability();
    return;
  }

  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();

    serverConfig.hasOpenAIKey = Boolean(data.hasOpenAIKey);
    serverConfig.sttModel = data.sttModel || "";
    serverConfig.ttsModel = data.ttsModel || "";
    serverConfig.ttsVoice = data.ttsVoice || "";
    serverConfig.voiceLabel = data.voiceLabel || "";

    if (serverConfig.hasOpenAIKey) {
      voiceStatus.textContent = `AI 목소리: ${serverConfig.voiceLabel}`;
      statusText.textContent = modeCopy[currentMode].readyStatus;
      livePreview.textContent = modeCopy[currentMode].guide;
    } else {
      loadBrowserVoices();
      voiceStatus.textContent = selectedBrowserVoice
        ? `기본 목소리: ${selectedBrowserVoice.name} · AI 키를 넣으면 더 자연스러운 음성으로 바뀌어요.`
        : "기본 모드: AI 키가 없어서 브라우저 기본 음성으로 동작해요.";
      statusText.textContent = SpeechRecognition
        ? "AI 키는 없지만 브라우저 기본 모드로 바로 테스트할 수 있어요. 마이크를 눌러보세요."
        : "서버 설정이 아직 없고 브라우저 기본 음성인식도 지원되지 않아요. `.env`에 OPENAI_API_KEY를 넣어주세요.";
      livePreview.textContent = SpeechRecognition
        ? "지금은 기본 모드예요. 더 자연스러운 음성을 원하면 `.env`를 추가하면 돼요."
        : "Chrome이나 Edge에서 열거나 `.env`에 OPENAI_API_KEY를 추가해주세요.";
    }
  } catch (error) {
    loadBrowserVoices();
    voiceStatus.textContent = "AI 목소리: 서버 연결을 확인하지 못했어요.";
    statusText.textContent = SpeechRecognition
      ? "앱 서버 연결은 안 되지만 브라우저 기본 모드로는 사용할 수 있어요."
      : "앱 서버에 연결할 수 없어요. `node server.js`로 실행 중인지 확인해주세요.";
    livePreview.textContent = SpeechRecognition
      ? "기본 모드로는 마이크를 바로 눌러 테스트할 수 있어요."
      : "서버가 켜지면 다시 새로고침해보세요.";
  }

  updateDeviceTip();
  updateControlAvailability();
}

async function startRecording() {
  if (isTranscribing) {
    return;
  }

  if (!serverConfig.hasOpenAIKey) {
    startBrowserRecognition();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    statusText.textContent = "이 브라우저는 녹음을 지원하지 않아요. Chrome이나 Edge를 추천해요.";
    livePreview.textContent = "녹음 가능한 브라우저에서 다시 시도해주세요.";
    return;
  }

  if (isRecording) {
    stopRecording();
    return;
  }

  stopPlayback();

  try {
    const preferredMimeType = getPreferredMimeType();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    recordedChunks = [];
    discardOnStop = false;
    restartAfterStop = false;

    mediaRecorder = preferredMimeType
      ? new MediaRecorder(mediaStream, { mimeType: preferredMimeType })
      : new MediaRecorder(mediaStream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", handleRecorderStop);
    mediaRecorder.start();
    updateRecordingState(true);
    statusText.textContent = "듣고 있어요. 말을 마치면 큰 버튼을 한 번 더 눌러주세요.";
    livePreview.textContent = "유치원생이 또박또박 말하면 더 잘 알아들어요.";
  } catch (error) {
    cleanupMediaStream();
    statusText.textContent = "마이크 권한이 필요해요. 브라우저에서 마이크를 허용해주세요.";
    livePreview.textContent = "권한을 허용한 뒤 다시 시도하면 돼요.";
  }
}

function startBrowserRecognition() {
  if (!SpeechRecognition) {
    statusText.textContent = "이 브라우저는 기본 음성인식을 지원하지 않아요. Chrome이나 Edge를 추천해요.";
    livePreview.textContent = "또는 `.env`에 OPENAI_API_KEY를 넣고 AI 모드로 실행해주세요.";
    return;
  }

  if (isRecording) {
    stopRecording();
    return;
  }

  stopPlayback();
  browserInterimTranscript = "";
  browserRecognizedText = "";
  discardOnStop = false;
  restartAfterStop = false;

  const recognition = new SpeechRecognition();
  browserRecognition = recognition;
  recognition.lang = "ko-KR";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onresult = (event) => {
    const finalChunks = [];
    let interim = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript;

      if (event.results[index].isFinal) {
        finalChunks.push(transcript);
      } else {
        interim += transcript;
      }
    }

    const nextFinalText = normalizeTranscript(finalChunks.join(" "));
    const nextInterim = normalizeTranscript(interim);

    if (nextFinalText) {
      browserRecognizedText = nextFinalText;
      renderTranscript(nextFinalText);
      livePreview.textContent = "기본 모드로 들은 문장을 화면에 적었어요.";
    }

    if (nextInterim) {
      browserInterimTranscript = nextInterim;
      livePreview.textContent = `듣는 중: ${nextInterim}`;
    }
  };

  recognition.onerror = (event) => {
    browserRecognition = null;
    updateRecordingState(false);
    discardOnStop = false;
    restartAfterStop = false;

    const errorMessageMap = {
      "no-speech": "소리가 잘 안 들렸어요. 조금 더 크게 말해볼까요?",
      "audio-capture": "마이크를 사용할 수 없어요. 기기 설정을 확인해주세요.",
      "not-allowed": "마이크 권한이 없어요. 브라우저 권한을 허용해주세요."
    };

    statusText.textContent =
      errorMessageMap[event.error] || "기본 음성인식 중 문제가 생겼어요. 다시 한 번 시도해볼까요?";
    livePreview.textContent = modeCopy[currentMode].guide;
  };

  recognition.onend = async () => {
    browserRecognition = null;
    updateRecordingState(false);

    const shouldDiscard = discardOnStop;
    const shouldRestart = restartAfterStop;
    discardOnStop = false;
    restartAfterStop = false;

    if (shouldRestart) {
      await startRecording();
      return;
    }

    if (shouldDiscard) {
      statusText.textContent = modeCopy[currentMode].readyStatus;
      livePreview.textContent = modeCopy[currentMode].guide;
      browserRecognizedText = "";
      browserInterimTranscript = "";
      return;
    }

    const finalizedText = browserRecognizedText || browserInterimTranscript;

    if (finalizedText) {
      renderTranscript(finalizedText);
      addSpeechHistoryEntry(finalizedText, "browser");
      statusText.textContent = "기본 모드로 인식을 마쳤어요. 소리 버튼으로 다시 들어볼 수 있어요.";
      livePreview.textContent = "브라우저 기본 모드 결과예요.";
      browserRecognizedText = "";
      browserInterimTranscript = "";
      return;
    }

    statusText.textContent = currentTranscript
      ? "기본 모드 인식이 끝났어요. 필요하면 소리 버튼을 눌러 다시 들을 수 있어요."
      : "아직 들은 말이 없어요. 한 번 더 천천히 말해보세요.";

    if (!currentTranscript) {
      livePreview.textContent = modeCopy[currentMode].guide;
    }
  };

  recognition.start();
  updateRecordingState(true);
  statusText.textContent = "기본 모드로 듣고 있어요. 말을 마치면 큰 버튼을 한 번 더 눌러주세요.";
  livePreview.textContent = "AI 키가 없어도 지금은 테스트할 수 있어요.";
}

function stopRecording({ discard = false, restart = false } = {}) {
  discardOnStop = discard;
  restartAfterStop = restart;

  if (browserRecognition) {
    browserRecognition.stop();
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    return;
  }

  cleanupMediaStream();
  updateRecordingState(false);
}

function cleanupMediaStream() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  mediaRecorder = null;
}

async function handleRecorderStop() {
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const audioBlob = new Blob(recordedChunks, { type: mimeType });
  const shouldDiscard = discardOnStop;
  const shouldRestart = restartAfterStop;

  discardOnStop = false;
  restartAfterStop = false;
  recordedChunks = [];
  cleanupMediaStream();
  updateRecordingState(false);

  if (shouldRestart) {
    await startRecording();
    return;
  }

  if (shouldDiscard) {
    statusText.textContent = modeCopy[currentMode].readyStatus;
    livePreview.textContent = modeCopy[currentMode].guide;
    return;
  }

  if (!audioBlob.size) {
    statusText.textContent = "녹음된 소리가 없어요. 조금 더 크게 다시 말해볼까요?";
    livePreview.textContent = modeCopy[currentMode].guide;
    return;
  }

  await transcribeAudio(audioBlob, mimeType);
}

async function transcribeAudio(audioBlob, mimeType) {
  isTranscribing = true;
  updateControlAvailability();
  statusText.textContent = "방금 말한 소리를 AI가 듣고 있어요.";
  livePreview.textContent = "한글로 바꾸는 중이에요.";

  try {
    const extension = getFileExtension(mimeType);
    const formData = new FormData();
    formData.append("audio", audioBlob, `kid-voice.${extension}`);
    formData.append("mode", currentMode);

    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "전사에 실패했어요.");
    }

    const nextText = normalizeTranscript(data.text || "");

    if (!nextText) {
      renderTranscript("");
      statusText.textContent = "무슨 말인지 잘 안 들렸어요. 조금 더 천천히 다시 말해볼까요?";
      livePreview.textContent = modeCopy[currentMode].guide;
      return;
    }

    renderTranscript(nextText);
    addSpeechHistoryEntry(nextText, "ai");
    statusText.textContent = "AI가 말을 이해했어요. 이제 옆의 소리 버튼으로 자연스럽게 다시 들을 수 있어요.";
    livePreview.textContent = `인식 모델: ${data.model}`;
  } catch (error) {
    renderTranscript("");
    statusText.textContent = error.message || "전사 중에 문제가 생겼어요.";
    livePreview.textContent = "잠시 후 다시 시도해주세요.";
  } finally {
    isTranscribing = false;
    updateControlAvailability();
  }
}

async function speakTranscript() {
  if (!currentTranscript || isGeneratingSpeech) {
    return;
  }

  if (!serverConfig.hasOpenAIKey) {
    speakTranscriptWithBrowser();
    return;
  }

  stopPlayback();
  isGeneratingSpeech = true;
  updateControlAvailability();
  statusText.textContent = "자연스러운 AI 목소리를 준비하고 있어요.";
  livePreview.textContent = serverConfig.voiceLabel
    ? `사용 중인 음성: ${serverConfig.voiceLabel}`
    : "AI 음성을 준비 중이에요.";

  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: currentTranscript,
        mode: currentMode
      })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "읽어주기에 실패했어요.");
    }

    const audioBlob = await response.blob();
    playbackUrl = URL.createObjectURL(audioBlob);
    playbackAudio = new Audio(playbackUrl);
    playbackAudio.preload = "auto";
    playbackAudio.addEventListener("ended", () => {
      stopPlayback();
      statusText.textContent = "AI 목소리로 다시 읽어줬어요. 필요하면 한 번 더 들을 수 있어요.";
      livePreview.textContent = "듣기가 끝났어요.";
    });
    playbackAudio.addEventListener("error", () => {
      stopPlayback();
      statusText.textContent = "오디오를 재생하지 못했어요. 다시 눌러볼까요?";
      livePreview.textContent = "네트워크나 브라우저 재생 상태를 확인해주세요.";
    });

    await playbackAudio.play();
    statusText.textContent = "AI가 더 자연스러운 한국어 목소리로 읽어주고 있어요.";
  } catch (error) {
    stopPlayback();
    statusText.textContent = error.message || "읽어주기 중에 문제가 생겼어요.";
    livePreview.textContent = "잠시 후 다시 시도해주세요.";
  } finally {
    isGeneratingSpeech = false;
    updateControlAvailability();
  }
}

function speakTranscriptWithBrowser() {
  if (!window.speechSynthesis) {
    statusText.textContent = "이 브라우저는 기본 읽어주기를 지원하지 않아요.";
    livePreview.textContent = "AI 키를 넣으면 서버형 읽어주기를 사용할 수 있어요.";
    return;
  }

  loadBrowserVoices();
  const speechChunks = prepareSpeechChunks(currentTranscript);

  if (!speechChunks.length) {
    return;
  }

  stopPlayback();
  isGeneratingSpeech = true;
  updateControlAvailability();

  speechChunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = selectedBrowserVoice?.lang || "ko-KR";
    utterance.pitch = currentMode === "word" ? 1.0 : 0.96;
    utterance.rate = currentMode === "word" ? 0.9 : 0.96;

    if (selectedBrowserVoice) {
      utterance.voice = selectedBrowserVoice;
    }

    if (index === 0) {
      utterance.onstart = () => {
        statusText.textContent = "기본 목소리로 읽어주고 있어요. AI 키를 넣으면 더 자연스러운 목소리로 바뀌어요.";
        livePreview.textContent = selectedBrowserVoice
          ? `현재 기본 음성: ${selectedBrowserVoice.name}`
          : "브라우저 기본 목소리로 읽는 중이에요.";
      };
    }

    if (index === speechChunks.length - 1) {
      utterance.onend = () => {
        isGeneratingSpeech = false;
        updateControlAvailability();
        statusText.textContent = "기본 목소리로 읽어줬어요.";
        livePreview.textContent = "더 자연스러운 목소리는 `.env`를 설정하면 사용할 수 있어요.";
      };
      utterance.onerror = () => {
        isGeneratingSpeech = false;
        updateControlAvailability();
        statusText.textContent = "기본 읽어주기 재생에 실패했어요.";
        livePreview.textContent = "브라우저 오디오 설정을 확인해주세요.";
      };
    }

    window.speechSynthesis.speak(utterance);
  });
}

function clearTranscript() {
  stopPlayback();
  renderTranscript("");

  if (isRecording) {
    stopRecording({ discard: true, restart: false });
  }

  statusText.textContent = modeCopy[currentMode].readyStatus;
  livePreview.textContent = modeCopy[currentMode].guide;
  updateControlAvailability();
}

modeButtonElements.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

recordButton.addEventListener("click", () => {
  startRecording();
});

retryButton.addEventListener("click", () => {
  renderTranscript("");
  stopPlayback();

  if (isRecording) {
    statusText.textContent = "방금 녹음을 지우고 새로 시작할게요.";
    livePreview.textContent = "다시 듣는 중이에요.";
    stopRecording({ discard: true, restart: true });
    return;
  }

  startRecording();
});

clearButton.addEventListener("click", clearTranscript);
speakButton.addEventListener("click", speakTranscript);
clearHistoryButton.addEventListener("click", clearSpeechHistory);

setMode(currentMode);
renderTranscript("");
loadBrowserVoices();
loadSpeechHistory();
if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener("voiceschanged", loadBrowserVoices);
}
updateControlAvailability();
loadServerConfig();

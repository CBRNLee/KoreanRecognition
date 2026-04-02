const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const rootDir = __dirname;
loadEnvFile(path.join(rootDir, ".env"));

const config = {
  port: Number(process.env.PORT || 4173),
  apiKey: process.env.OPENAI_API_KEY || "",
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  sttModel: process.env.OPENAI_STT_MODEL || "gpt-4o-transcribe",
  ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  ttsVoice: process.env.OPENAI_TTS_VOICE || "sage"
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const wordPrompt =
  "유치원생이 말한 한국어 단어를 자연스러운 한글 표기로 전사하세요. 불필요한 설명 없이 말한 핵심 단어만 적고, 색깔, 동물, 과일, 장난감, 인사말, 교실 사물을 우선적으로 잘 알아들으세요.";

const sentencePrompt =
  "유치원생이 말한 짧은 한국어 문장을 자연스러운 한글 문장으로 전사하세요. 교실에서 많이 쓰는 표현, 짧은 자기소개, 날씨, 감정, 좋아하는 것 말하기를 잘 알아듣고, 의미가 유지되도록 띄어쓰기와 조사만 부드럽게 정리하세요.";

const ttsInstructions =
  "한국어 유치원생에게 말을 걸어주듯 따뜻하고 자연스럽게 읽어주세요. 지나치게 기계적이거나 과장되지 않게, 또박또박하면서도 부드럽게 읽고 짧은 휴지를 자연스럽게 넣어주세요.";

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, {
        hasOpenAIKey: Boolean(config.apiKey),
        sttModel: config.sttModel,
        ttsModel: config.ttsModel,
        ttsVoice: config.ttsVoice,
        voiceLabel: `OpenAI ${config.ttsModel} · ${config.ttsVoice}`
      });
    }

    if (requestUrl.pathname === "/api/transcribe" && req.method === "POST") {
      return handleTranscription(req, res);
    }

    if (requestUrl.pathname === "/api/speak" && req.method === "POST") {
      return handleSpeech(req, res);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return serveStaticFile(requestUrl.pathname, req.method === "HEAD", res);
    }

    return sendJson(res, 405, { error: "허용되지 않는 요청 방식이에요." });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "서버에서 예상치 못한 문제가 생겼어요." });
  }
});

server.listen(config.port, () => {
  console.log(`말랑말랑 한글 친구 서버가 http://localhost:${config.port} 에서 실행 중입니다.`);
});

async function handleTranscription(req, res) {
  if (!config.apiKey) {
    return sendJson(res, 503, {
      error: "OPENAI_API_KEY가 없어서 AI 음성인식을 사용할 수 없어요."
    });
  }

  const webRequest = toWebRequest(req);
  const formData = await webRequest.formData();
  const audioFile = formData.get("audio");
  const rawMode = String(formData.get("mode") || "word");
  const mode = rawMode === "sentence" ? "sentence" : "word";

  if (!audioFile || typeof audioFile.arrayBuffer !== "function") {
    return sendJson(res, 400, { error: "녹음 파일을 찾지 못했어요." });
  }

  const openaiFormData = new FormData();
  openaiFormData.append("file", audioFile, audioFile.name || "kid-voice.webm");
  openaiFormData.append("model", config.sttModel);
  openaiFormData.append("language", "ko");
  openaiFormData.append("prompt", mode === "word" ? wordPrompt : sentencePrompt);

  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: openaiFormData
  });

  if (!response.ok) {
    return forwardOpenAIError(response, res, "음성인식 요청이 실패했어요.");
  }

  const data = await response.json();
  const text = normalizeTranscript(data.text || "");
  return sendJson(res, 200, {
    text,
    model: config.sttModel
  });
}

async function handleSpeech(req, res) {
  if (!config.apiKey) {
    return sendJson(res, 503, {
      error: "OPENAI_API_KEY가 없어서 AI 읽어주기를 사용할 수 없어요."
    });
  }

  const webRequest = toWebRequest(req);
  const body = await webRequest.json();
  const text = normalizeTranscript(String(body.text || ""));
  const mode = body.mode === "sentence" ? "sentence" : "word";

  if (!text) {
    return sendJson(res, 400, { error: "읽어줄 문장이 비어 있어요." });
  }

  const payload = {
    model: config.ttsModel,
    voice: config.ttsVoice,
    input: text.slice(0, 4096),
    response_format: "mp3",
    speed: mode === "word" ? 0.92 : 0.97
  };

  if (config.ttsModel === "gpt-4o-mini-tts") {
    payload.instructions = ttsInstructions;
  }

  const response = await fetch(`${config.baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return forwardOpenAIError(response, res, "AI 읽어주기 요청이 실패했어요.");
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Content-Length": audioBuffer.byteLength,
    "Cache-Control": "no-store"
  });
  res.end(audioBuffer);
}

async function serveStaticFile(urlPathname, isHeadRequest, res) {
  const safePath = sanitizePath(urlPathname);
  const filePath = safePath ? path.join(rootDir, safePath) : path.join(rootDir, "index.html");

  try {
    const stat = await fsp.stat(filePath);

    if (stat.isDirectory()) {
      return serveStaticFile(path.join(urlPathname, "index.html"), isHeadRequest, res);
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[extension] || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
    };

    res.writeHead(200, headers);

    if (isHeadRequest) {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    sendJson(res, 404, { error: "요청한 파일을 찾지 못했어요." });
  }
}

function sanitizePath(urlPathname) {
  if (urlPathname === "/" || urlPathname === "") {
    return "";
  }

  const decodedPath = decodeURIComponent(urlPathname);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  return normalizedPath.replace(/^[/\\]+/, "");
}

function toWebRequest(req) {
  return new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half"
  });
}

async function forwardOpenAIError(response, res, fallbackMessage) {
  let errorPayload;

  try {
    errorPayload = await response.json();
  } catch (error) {
    errorPayload = null;
  }

  const message = errorPayload?.error?.message || fallbackMessage;
  return sendJson(res, response.status, { error: message });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function normalizeTranscript(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");

  content.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

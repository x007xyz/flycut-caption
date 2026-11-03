"""FunASR Provider: FlyCut Provider protocol v1 (docs/provider-http-protocol.md) over FunASR AutoModel.

Standard library HTTP server; funasr/torch/modelscope are imported lazily so health and model
listing work (and explain what is missing) before the inference dependencies are installed.
Copy this file as a template for your own Provider service.
"""
import argparse
import hmac
import importlib.util
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid
import wave

PROTOCOL = {"protocol": "flycut-provider", "version": 1, "name": "FunASR", "capabilities": ["asr"]}
HOME = Path(os.environ.get("FLYCUT_FUNASR_HOME", Path.home() / ".flycut-caption" / "funasr")).expanduser()
MAX_AUDIO = 500 * 1024 * 1024
JOB_TTL = 600

# Companion models referenced by ASR options. `ms` is the ModelScope repository.
COMPANIONS = {
    "fsmn-vad": dict(name="FSMN-VAD", role="vad", ms="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", size="4 MB"),
    "ct-punc": dict(name="CT-Punc 中英标点", role="punc", ms="iic/punc_ct-transformer_cn-en-common-vocab471067-large", size="1.1 GB"),
    "cam++": dict(name="CAM++ 说话人", role="speaker", ms="iic/speech_campplus_sv_zh-cn_16k-common", size="28 MB"),
}
VAD = {"type": "select", "label": "VAD 分段", "default": "fsmn-vad",
       "options": [{"value": "fsmn-vad", "label": "FSMN-VAD"}, {"value": "none", "label": "不使用"}]}
PUNC = {"type": "select", "label": "标点", "default": "ct-punc",
        "options": [{"value": "ct-punc", "label": "CT-Punc"}, {"value": "none", "label": "不加标点"}]}
SPEAKER = {"type": "select", "label": "说话人识别", "default": "none", "description": "需要同时开启 VAD 和标点",
           "options": [{"value": "none", "label": "不识别"}, {"value": "cam++", "label": "CAM++"}]}
BATCH = {"type": "number", "label": "批处理时长（秒）", "default": 60, "min": 1, "max": 600, "step": 1}
ASR = {
    "paraformer-zh": dict(name="Paraformer 中文（热词）", ms="iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                          size="950 MB", languages=["zh"], timestampLevel="word", recommended=True,
                          description="中文识别，支持热词和字级时间戳；配合 CT-Punc 输出句子，配合 CAM++ 区分说话人",
                          options={"vad": VAD, "punc": PUNC, "speaker": SPEAKER,
                                   "hotword": {"type": "string", "label": "热词", "description": "空格分隔，例如人名、产品名"},
                                   "batch_size_s": BATCH}),
    "paraformer-en": dict(name="Paraformer 英文", ms="iic/speech_paraformer-large-vad-punc_asr_nat-en-16k-common-vocab10020",
                          size="1.0 GB", languages=["en"], timestampLevel="word",
                          description="英文识别，字级时间戳",
                          options={"vad": VAD, "punc": PUNC, "speaker": SPEAKER, "batch_size_s": BATCH}),
    "sensevoice-small": dict(name="SenseVoice Small", ms="iic/SenseVoiceSmall", size="900 MB",
                             languages=["auto", "zh", "en", "yue", "ja", "ko"], timestampLevel="segment",
                             description="多语种识别，按 VAD 片段输出句段时间戳",
                             options={"vad": VAD, "batch_size_s": BATCH}),
}
DEFAULT_COMPANIONS = {model_id: [spec["options"][key]["default"] for key in ("vad", "punc") if key in spec["options"]]
                      for model_id, spec in ASR.items()}

JOBS, JOBS_LOCK = {}, threading.Lock()
# One inference and one download at a time: models are large and share memory / GPU.
INFERENCE = ThreadPoolExecutor(max_workers=1)
DOWNLOADS = ThreadPoolExecutor(max_workers=1)
DOWNLOAD_LOCK = threading.Lock()
LOADED = {"key": None, "models": None}


def missing_dependency():
    for module in ("funasr", "torch", "modelscope"):
        if importlib.util.find_spec(module) is None:
            return f"当前 Python 没有安装 {module}，请执行 pip install -r python/requirements-funasr.txt"
    return None


def model_dir(model_id):
    return HOME / "models" / model_id


def is_downloaded(model_id):
    return (model_dir(model_id) / ".flycut-ready").is_file()


def model_rows():
    reason = missing_dependency()
    rows = []
    for model_id, spec in ASR.items():
        ready = is_downloaded(model_id) and all(is_downloaded(c) for c in DEFAULT_COMPANIONS[model_id])
        row = {"id": model_id, "role": "asr", "status": "unavailable" if reason else ("ready" if ready else "download"),
               **{key: spec[key] for key in ("name", "size", "languages", "timestampLevel", "description", "options")}}
        if spec.get("recommended"):
            row["recommended"] = True
        if reason:
            row["reason"] = reason
        rows.append(row)
    for model_id, spec in COMPANIONS.items():
        row = {"id": model_id, "role": spec["role"], "name": spec["name"], "size": spec["size"],
               "status": "unavailable" if reason else ("ready" if is_downloaded(model_id) else "download")}
        if reason:
            row["reason"] = reason
        rows.append(row)
    return rows


def download(model_id, report):
    """Downloads into a fixed local directory; the marker file is written only after a complete download."""
    if is_downloaded(model_id):
        return
    spec = ASR.get(model_id) or COMPANIONS[model_id]
    with DOWNLOAD_LOCK:
        from modelscope import snapshot_download
        report(f"下载 {spec['name']}（{spec['size']}）")
        snapshot_download(spec["ms"], local_dir=str(model_dir(model_id)))
        (model_dir(model_id) / ".flycut-ready").touch()


def check_options(model_id, options):
    declared = ASR[model_id]["options"]
    for key, value in options.items():
        field = declared.get(key)
        if field is None:
            raise ValueError(f"模型 {model_id} 不支持选项 {key}")
        if field["type"] == "select" and value not in [o["value"] for o in field["options"]]:
            raise ValueError(f"选项 {key} 的值无效：{value}")
        if field["type"] == "string" and not isinstance(value, str):
            raise ValueError(f"选项 {key} 应为字符串")
        if field["type"] == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))
                                          or not field["min"] <= value <= field["max"]):
            raise ValueError(f"选项 {key} 超出范围")
    resolved = {key: options.get(key, field.get("default")) for key, field in declared.items()}
    if resolved.get("speaker", "none") != "none" and ("none" in (resolved.get("vad"), resolved.get("punc"))):
        raise ValueError("说话人识别需要同时开启 VAD 和标点")
    return resolved


# ---- Transcript conversion (FunASR milliseconds -> protocol seconds) ----

def clean_text(text):
    if isinstance(text, (list, tuple)):
        text = " ".join(str(token) for token in text)
    return re.sub(r"<\|[^|]*\|>", "", str(text)).strip()


def time_span(start, end, duration):
    try:
        start, end = float(start) / 1000, float(end) / 1000
    except (TypeError, ValueError):
        return None
    if not math.isfinite(start) or not math.isfinite(end):
        return None
    start, end = max(0, start), min(duration, end)
    return [start, end] if end > start else None


# One Chinese character, or one run of other letters/digits (an English word, "IP", "2024").
TOKEN = re.compile(r"[㐀-鿿]|[^\W_㐀-鿿]+(?:['’][^\W_㐀-鿿]+)*")


def transcript_from_results(results, duration, language):
    chunks, words = [], []
    for result in results:
        text = clean_text(result.get("text", ""))
        if not text:
            continue
        sentences = result.get("sentence_info") or [dict(
            result, text=text, start=result.get("start", 0), end=result.get("end", duration * 1000))]
        for sentence in sentences:
            text = clean_text(sentence.get("text", sentence.get("sentence", "")))
            if not text:
                continue
            span = time_span(sentence.get("start"), sentence.get("end"), duration)
            if span is None:
                raise ValueError("FunASR 返回的句段时间戳无效")
            chunk = dict(id=f"funasr-{len(chunks)}", text=text, timestamp=span)
            if sentence.get("spk") is not None:
                chunk["speaker"] = f"SPEAKER_{sentence['spk']}"
            # Pair genuine timestamps only when the surface tokens match exactly.
            # Do not spread timestamps evenly or guess BPE/token boundaries.
            matches = list(TOKEN.finditer(text))
            # Attach intervening punctuation/spacing to its preceding token so
            # editing words reconstructs the sentence without losing spaces.
            tokens = [text[match.start() if i else 0:matches[i + 1].start() if i + 1 < len(matches) else len(text)]
                      for i, match in enumerate(matches)]
            stamps = sentence.get("timestamp") or []
            valid = [time_span(*pair, duration) if isinstance(pair, (list, tuple)) and len(pair) == 2 else None for pair in stamps]
            if tokens and len(tokens) == len(valid) and all(
                pair and span[0] <= pair[0] < pair[1] <= span[1] for pair in valid
            ) and all(valid[i][0] >= valid[i - 1][1] for i in range(1, len(valid))):
                chunk["wordIds"] = []
                for token, pair in zip(tokens, valid):
                    word = dict(id=f"funasr-word-{len(words)}", text=token,
                                timestamp=pair, sentenceId=chunk["id"])
                    if "speaker" in chunk:
                        word["speaker"] = chunk["speaker"]
                    chunk["wordIds"].append(word["id"])
                    words.append(word)
            chunks.append(chunk)
    chunks.sort(key=lambda c: c["timestamp"][0])
    has_words = bool(chunks) and all(chunk.get("wordIds") for chunk in chunks)
    if not has_words:
        words = []
        for chunk in chunks:
            chunk.pop("wordIds", None)
    return dict(text=" ".join(c["text"] for c in chunks), chunks=chunks,
                wordChunks=words, hasWordTimestamps=has_words,
                language=language, duration=duration)


# ---- Inference ----

def device():
    configured = os.environ.get("FLYCUT_FUNASR_DEVICE")
    if configured:
        return configured
    import torch
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def load(key, factory):
    """Keeps one model combination in memory and reuses it across jobs."""
    if LOADED["key"] != key:
        LOADED.update(key=None, models=None)
        LOADED.update(key=key, models=factory())
    return LOADED["models"]


def automodel(model_id, **companions):
    from funasr import AutoModel
    options = dict(model=str(model_dir(model_id)), device=device(), disable_update=True, disable_pbar=True,
                   trust_remote_code=False)
    for key, companion in companions.items():
        if companion:
            options[key] = str(model_dir(companion))
    return AutoModel(**options)


def transcribe(model_id, language, options, wav, report, cancelled):
    resolved = check_options(model_id, options)
    vad, punc, speaker = (resolved.get(k, "none") for k in ("vad", "punc", "speaker"))
    needed = [model_id] + [m for m in (vad, punc, speaker) if m not in (None, "none")]
    for index, name in enumerate(needed):
        if not is_downloaded(name):
            download(name, lambda message: report(message, 5 * index / len(needed)))
        if cancelled():
            raise RuntimeError("cancelled")
    with wave.open(wav, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2:
            raise ValueError("音频必须是 16 kHz 单声道 PCM16 WAV")
        duration = audio.getnframes() / audio.getframerate()
    batch = float(resolved.get("batch_size_s") or 60)
    report("加载模型", 10)
    if model_id == "sensevoice-small":
        return sensevoice(language, vad, batch, wav, duration, report, cancelled)
    asr = load((model_id, vad, punc, speaker),
               lambda: automodel(model_id, vad_model=none(vad), punc_model=none(punc), spk_model=none(speaker)))
    report("识别中", 30)
    generate = dict(input=wav, batch_size_s=batch, sentence_timestamp=punc != "none")
    if resolved.get("hotword"):
        generate["hotword"] = str(resolved["hotword"])
    results = []
    for result in asr.generate(**generate):
        sentences = paraformer_sentences(result)
        results.extend(sentences if sentences is not None else [result])
    transcript = transcript_from_results(results, duration, language)
    if speaker != "none" and any("speaker" not in c for c in transcript["chunks"]):
        raise ValueError("当前模型组合未返回说话人结果")
    return transcript


def none(value):
    return None if value in (None, "none") else value


SENTENCE_END = "。！？!?；;"
CLAUSE_END = "，,、"
MAX_SENTENCE_MS = 6000


def split_sentences(text, words, stamps, offset, speakers=None, clause_ms=MAX_SENTENCE_MS):
    """Splits recognised text at punctuation using the model's real token timestamps (milliseconds).

    Commas end a sentence once it lasts ``clause_ms``. With ``speakers`` (one label per token) a
    sentence also ends where the speaker changes, and carries that speaker as ``spk``.

    Tokens are located in the punctuated text in order. A sentence containing a token that cannot be
    located (for example after inverse text normalisation turned it into a digit) keeps its sentence
    bounds but loses its word timestamps, so no word is ever given another word's time.
    """
    text = clean_text(text)
    lower, cursor, pieces = text.lower(), 0, []
    for k, (word, stamp) in enumerate(zip(words or [], stamps or [])):
        token = str(word).replace("\u2581", "").strip().lower()
        index = lower.find(token, cursor) if token else -1
        if token and not any(c.isalnum() for c in token):
            # Punctuation tokens carry timestamps too; they mark boundaries, not words.
            cursor = index + len(token) if index >= 0 else cursor
            continue
        if index < 0 or not isinstance(stamp, (list, tuple)) or len(stamp) != 2:
            pieces.append(None)
            continue
        pieces.append((index, index + len(token), [stamp[0] + offset, stamp[1] + offset], speakers[k] if speakers else None))
        cursor = index + len(token)
    located = [i for i, piece in enumerate(pieces) if piece]
    if not located:
        return None
    sentences, group, gap, start_char = [], [], False, 0
    for position, i in enumerate(located):
        _, end, stamp, speaker = pieces[i]
        gap = gap or (position == 0 and i > 0)
        group.append(stamp)
        last = position + 1 == len(located)
        following = len(text) if last else pieces[located[position + 1]][0]
        gap_after = any(p is None for p in pieces[i + 1:(len(pieces) if last else located[position + 1])])
        between = text[end:following]
        long_clause = any(c in CLAUSE_END for c in between) and stamp[1] - group[0][0] >= clause_ms
        turn = speakers is not None and not last and pieces[located[position + 1]][3] != speaker
        if last or any(c in SENTENCE_END for c in between) or long_clause or turn:
            sentence = text[start_char:following].strip()
            if sentence:
                sentences.append(dict(text=sentence, start=group[0][0], end=group[-1][1],
                                      timestamp=[] if gap or gap_after else group,
                                      **({"spk": speaker} if speakers is not None else {})))
            group, gap, start_char = [], False, following
        else:
            gap = gap or gap_after
    return sentences


def paraformer_sentences(result):
    """Rebuilds Paraformer sentences from its top-level text and token timestamps.

    FunASR's own ``sentence_info`` can hand characters and timestamps to the wrong sentence, while the
    top-level ``timestamp`` list has exactly one entry per character/word of ``text``. When the counts
    match, sentences are re-split here at every punctuation mark (as FunASR does) and at speaker changes;
    each token's speaker is the ``sentence_info`` speaker whose time span holds it. Otherwise returns
    None and the caller keeps FunASR's sentences.
    """
    text, stamps = clean_text(result.get("text", "")), result.get("timestamp") or []
    words = TOKEN.findall(text)
    if not words or len(words) != len(stamps) or not all(isinstance(s, (list, tuple)) and len(s) == 2 for s in stamps):
        return None
    info = [s for s in result.get("sentence_info") or [] if s.get("spk") is not None]
    speakers = None
    if info:
        def speaker_at(stamp):
            middle = (stamp[0] + stamp[1]) / 2
            return min(info, key=lambda s: max(s["start"] - middle, middle - s["end"], 0))["spk"]
        speakers = [speaker_at(stamp) for stamp in stamps]
    return split_sentences(text, words, stamps, 0, speakers=speakers, clause_ms=0)


def sensevoice(language, vad, batch, wav, duration, report, cancelled):
    """Recognises each VAD segment, then splits it into sentences on SenseVoice's own token timestamps."""
    import numpy as np

    def factory():
        models = {"asr": automodel("sensevoice-small")}
        if vad != "none":
            from funasr import AutoModel
            models["vad"] = AutoModel(model=str(model_dir(vad)), device=device(), disable_update=True,
                                      disable_pbar=True, max_single_segment_time=30000)
        return models

    models = load(("sensevoice-small", vad), factory)
    with wave.open(wav, "rb") as audio:
        samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if "vad" in models:
        report("语音分段", 20)
        segments = models["vad"].generate(input=wav)[0].get("value", [])
    else:
        segments = [[0, duration * 1000]]
    results = []
    for index, (start, end) in enumerate(segments):
        if cancelled():
            raise RuntimeError("cancelled")
        report(f"识别片段 {index + 1}/{len(segments)}", 30 + 65 * index / max(1, len(segments)))
        piece = samples[int(start * 16):int(end * 16)]
        if not len(piece):
            continue
        output = models["asr"].generate(input=piece, language=language, use_itn=True, batch_size_s=batch, output_timestamp=True)
        result = output[0] if output else {}
        sentences = split_sentences(result.get("text", ""), result.get("words"), result.get("timestamp"), start)
        results.extend(sentences if sentences is not None else [dict(text=result.get("text", ""), start=start, end=end)])
    return transcript_from_results(results, duration, language)


# ---- Jobs and HTTP ----

def new_job():
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        now = time.time()
        for stale in [k for k, v in JOBS.items() if v["status"] in ("complete", "error", "cancelled") and now - v["updated"] > JOB_TTL]:
            JOBS.pop(stale)
        JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0, "updated": now, "cancel": threading.Event()}
    return job_id


def update(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job and job["status"] not in ("complete", "error", "cancelled"):
            job.update(fields, updated=time.time())


def run_job(job_id, work):
    cancel = JOBS[job_id]["cancel"]
    if cancel.is_set():
        return
    update(job_id, status="running")
    try:
        result = work(lambda message, progress=None: update(job_id, message=message, **({} if progress is None else {"progress": round(progress)})),
                      cancel.is_set)
        if cancel.is_set():
            return
        update(job_id, status="complete", progress=100, result=result, message="完成")
    except Exception as error:  # noqa: BLE001 - reported to the client
        if not cancel.is_set():
            update(job_id, status="error", error=f"{type(error).__name__}: {error}")


class Handler(BaseHTTPRequestHandler):
    server_version = "FlyCutFunASR/1"
    token = None

    def log_message(self, *_args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not self.token:
            return True
        supplied = self.headers.get("Authorization", "")
        if hmac.compare_digest(supplied, f"Bearer {self.token}"):
            return True
        self.send_json(401, {"error": "unauthorized"})
        return False

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/v1/health":
            return self.send_json(200, PROTOCOL)
        if self.path == "/v1/models":
            return self.send_json(200, {"models": model_rows()})
        match = re.fullmatch(r"/v1/jobs/([0-9a-f]{32})", self.path)
        if match:
            with JOBS_LOCK:
                job = JOBS.get(match.group(1))
                view = job and {k: v for k, v in job.items() if k not in ("cancel", "updated")}
            return self.send_json(200, view) if view else self.send_json(404, {"error": "任务不存在"})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return
        match = re.fullmatch(r"/v1/jobs/([0-9a-f]{32})/cancel", self.path)
        if match:
            with JOBS_LOCK:
                job = JOBS.get(match.group(1))
                if job and job["status"] in ("queued", "running"):
                    job["cancel"].set()
                    job.update(status="cancelled", updated=time.time())
            return self.send_json(200, {"id": match.group(1), "status": job["status"]}) if job else self.send_json(404, {"error": "任务不存在"})
        match = re.fullmatch(r"/v1/models/([A-Za-z0-9._+-]+)/prepare", self.path)
        if match:
            model_id = match.group(1)
            if model_id not in ASR and model_id not in COMPANIONS:
                return self.send_json(404, {"error": f"未知模型 {model_id}"})
            reason = missing_dependency()
            if reason:
                return self.send_json(400, {"error": reason})
            names = [model_id] + DEFAULT_COMPANIONS.get(model_id, [])

            def work(report, cancelled):
                for index, name in enumerate(names):
                    if cancelled():
                        return None
                    download(name, lambda message: report(message, 100 * index / len(names)))
                return {"id": model_id}
            job_id = new_job()
            DOWNLOADS.submit(run_job, job_id, work)
            return self.send_json(202, {"id": job_id})
        if self.path == "/v1/asr/jobs":
            return self.create_asr_job()
        self.send_json(404, {"error": "not found"})

    def create_asr_job(self):
        model_id = self.headers.get("X-Flycut-Model", "")
        language = self.headers.get("X-Flycut-Language", "auto")
        if model_id not in ASR:
            return self.send_json(400, {"error": f"未知识别模型 {model_id}"})
        try:
            options = json.loads(self.headers.get("X-Flycut-Options") or "{}")
            if not isinstance(options, dict):
                raise ValueError("X-Flycut-Options 必须是 JSON 对象")
            check_options(model_id, options)
        except ValueError as error:
            return self.send_json(400, {"error": str(error)})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self.send_json(400, {"error": "缺少音频"})
        if length > MAX_AUDIO:
            return self.send_json(413, {"error": "音频超过 500 MB"})
        reason = missing_dependency()
        if reason:
            return self.send_json(400, {"error": reason})
        handle = tempfile.NamedTemporaryFile(prefix="flycut-funasr-", suffix=".wav", delete=False)
        with handle:
            remaining = length
            while remaining:
                data = self.rfile.read(min(remaining, 1 << 20))
                if not data:
                    break
                handle.write(data)
                remaining -= len(data)

        def work(report, cancelled):
            try:
                return transcribe(model_id, language, options, handle.name, report, cancelled)
            finally:
                os.unlink(handle.name)
        job_id = new_job()
        INFERENCE.submit(run_job, job_id, work)
        self.send_json(202, {"id": job_id})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--token", default=os.environ.get("FLYCUT_WORKER_TOKEN"))
    args = parser.parse_args()
    Handler.token = args.token
    HOME.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"FunASR Provider listening on http://{args.host}:{args.port} (models: {HOME})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

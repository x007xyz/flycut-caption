"""FunASR AutoModel adapter. Model paths are local; stdout carries JSON only."""
import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import wave


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


def transcript_from_results(results, duration, language):
    chunks, words = [], []
    for result in results:
        text = clean_text(result.get("text", ""))
        if not text:
            continue
        sentences = result.get("sentence_info") or [dict(
            text=text, start=0, end=duration * 1000,
            timestamp=result.get("timestamp", []))]
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
            matches = list(re.finditer(r"[\u3400-\u9fff]|[^\W_]+(?:['’][^\W_]+)*", text))
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
    has_words = bool(chunks) and all(chunk.get("wordIds") for chunk in chunks)
    if not has_words:
        words = []
        for chunk in chunks:
            chunk.pop("wordIds", None)
    return dict(text=" ".join(c["text"] for c in chunks), chunks=chunks,
                wordChunks=words, hasWordTimestamps=has_words,
                language=language, duration=duration)


def model_options(model_path, config):
    allowed = {"vad_model", "punc_model", "spk_model", "device", "batch_size_s", "hotword"}
    unknown = set(config) - allowed
    if unknown:
        raise ValueError(f"不支持的 FunASR 配置：{', '.join(sorted(unknown))}")
    options = dict(disable_update=True, disable_pbar=True, trust_remote_code=False,
                   device=config.get("device", "cpu"))
    if options["device"] != "cpu" and not re.fullmatch(r"cuda(?::\d+)?", str(options["device"])):
        raise ValueError("FunASR device 请选择 cpu 或 cuda:N")
    for key, value in [("model", model_path), *[(k, config.get(k)) for k in ("vad_model", "punc_model", "spk_model")]]:
        if value is None:
            continue
        if not isinstance(value, str) or not Path(value).expanduser().is_dir():
            raise ValueError(f"{key} 必须指向已下载的本地 FunASR 模型目录")
        options[key] = str(Path(value).expanduser().resolve())
    if options.get("spk_model") and not options.get("vad_model"):
        raise ValueError("CAM++ 说话人分段需要同时配置 vad_model")
    return options


def run(args):
    from funasr import AutoModel

    if args.check:
        return {"ready": True}
    config = json.loads(args.config)
    options = model_options(args.model, config)
    batch_size = float(config.get("batch_size_s", 60))
    if not math.isfinite(batch_size) or batch_size <= 0 or batch_size > 600:
        raise ValueError("batch_size_s 必须大于 0 且不超过 600")
    model = AutoModel(**options)
    with tempfile.TemporaryDirectory(prefix="flycut-funasr-") as directory:
        wav = str(Path(directory) / "audio.wav")
        subprocess.run([os.environ.get("FFMPEG_PATH", "ffmpeg"), "-nostdin", "-y", "-v", "error",
                        "-i", args.input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
                       check=True, stdout=sys.stderr, stderr=sys.stderr)
        with wave.open(wav, "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
        # Process the whole recording in one generate call so speaker IDs remain
        # consistent; FunASR performs VAD/batching internally.
        generate = dict(input=wav, batch_size_s=batch_size, sentence_timestamp=True)
        if args.language != "auto":
            generate["language"] = args.language
        if config.get("hotword"):
            generate["hotword"] = str(config["hotword"])
        results = model.generate(**generate)
        transcript = transcript_from_results(results, duration, args.language)
        if options.get("spk_model") and any("speaker" not in c for c in transcript["chunks"]):
            raise ValueError("当前模型组合未返回说话人结果，请使用兼容的 ASR、VAD 和 CAM++ 组合")
        return transcript


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--input")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--config", default="{}")
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        result = run(args)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}. 请在 Runtime 使用的 Python 环境安装 funasr、torch、torchaudio，并检查模型目录和组件兼容性。", file=sys.stderr)
        sys.exit(1)

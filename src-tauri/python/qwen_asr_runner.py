"""Offline Qwen3-ASR adapter. stdout is reserved for the transcript protocol."""
import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import wave


LANGUAGES = dict(zip(
    "zh en yue ar de fr es pt id it ko ru th vi ja tr hi ms nl sv da fi pl cs fil fa el hu mk ro".split(),
    "Chinese English Cantonese Arabic German French Spanish Portuguese Indonesian Italian Korean Russian Thai Vietnamese Japanese Turkish Hindi Malay Dutch Swedish Danish Finnish Polish Czech Filipino Persian Greek Hungarian Macedonian Romanian".split(),
))


def normalize_language(language):
    if not language or language == "auto":
        return None
    return LANGUAGES.get(language, language)


def transcript_from_results(results, spans, duration):
    """Only aligner output is treated as real word timestamps; never interpolate."""
    chunks, words, texts, languages = [], [], [], []
    for result, (start, end) in zip(results, spans):
        text = result.text.strip()
        if not text:
            continue
        sentence_id = f"qwen-{len(chunks)}"
        chunk = dict(id=sentence_id, text=text, timestamp=[start, end])
        aligned = getattr(result, "time_stamps", None)
        ids = []
        for item in aligned or []:
            begin, finish = float(item.start_time) + start, float(item.end_time) + start
            if not math.isfinite(begin) or not math.isfinite(finish) or finish <= begin:
                continue
            begin, finish = max(start, begin), min(end, finish)
            if finish <= begin:
                continue
            word_id = f"qwen-word-{len(words)}"
            words.append(dict(id=word_id, text=item.text, timestamp=[begin, finish], sentenceId=sentence_id))
            ids.append(word_id)
        if ids:
            chunk["wordIds"] = ids
            chunk["timestamp"] = [words[-len(ids)]["timestamp"][0], words[-1]["timestamp"][1]]
        chunks.append(chunk)
        texts.append(text)
        languages.append(result.language)
    # Partial alignment must not enable word editing for unaligned sentences.
    has_words = bool(chunks) and all(c.get("wordIds") for c in chunks)
    if not has_words:
        for chunk in chunks:
            chunk.pop("wordIds", None)
    return dict(text=" ".join(texts), chunks=chunks, wordChunks=words if has_words else [],
                hasWordTimestamps=has_words, duration=duration,
                language=next((code for code, name in LANGUAGES.items() if languages and name == languages[0]), "auto"))


def run(args):
    import torch
    import numpy as np
    from qwen_asr import Qwen3ASRModel

    if args.check:
        return {"ready": True}
    config = json.loads(args.config)
    device = config.get("device", "auto")
    if device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    aligner = config.get("forced_aligner")
    if aligner and not Path(aligner).is_dir():
        raise ValueError("ForcedAligner directory does not exist")
    model = Qwen3ASRModel.from_pretrained(
        args.model, dtype=dtype, device_map=device, local_files_only=True,
        max_inference_batch_size=1, max_new_tokens=1024,
        forced_aligner=aligner,
        forced_aligner_kwargs=dict(dtype=dtype, device_map=device, local_files_only=True) if aligner else None,
    )
    # Use bounded windows and read incrementally so long videos do not fill RAM.
    with tempfile.TemporaryDirectory(prefix="flycut-qwen-") as temp:
        wav = str(Path(temp) / "audio.wav")
        subprocess.run([os.environ.get("FFMPEG_PATH", "ffmpeg"), "-nostdin", "-y", "-v", "error",
                        "-i", args.input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
                       check=True, stdout=sys.stderr, stderr=sys.stderr)
        results, spans = [], []
        with wave.open(wav, "rb") as audio:
            rate = audio.getframerate()
            duration = audio.getnframes() / rate
            position = 0
            while True:
                data = audio.readframes(rate * 25)
                if not data:
                    break
                samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
                end = position + len(samples) / rate
                result = model.transcribe(audio=(samples, rate), language=normalize_language(args.language),
                                          return_time_stamps=bool(aligner))[0]
                results.append(result)
                spans.append((position, end))
                position = end
        return transcript_from_results(results, spans, duration)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--input")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--config", default="{}")
    args = parser.parse_args()
    # Imports and inference libraries may log to stdout; keep the JSON channel clean.
    with contextlib.redirect_stdout(sys.stderr):
        result = run(args)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}. 请确认该 Python 环境已安装 qwen-asr，且本地模型完整。", file=sys.stderr)
        sys.exit(1)

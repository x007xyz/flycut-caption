#!/usr/bin/env python3
"""Local runtime for the browser build.

The browser talks to this process over localhost.  It deliberately exposes a
small typed API instead of executing commands supplied by the browser.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import uuid
import hashlib
import re
import hmac
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(os.environ.get("FLYCUT_RUNTIME_HOME", Path.home() / ".flycut-caption"))
CATALOG = ROOT / "models.json"
RUNNER = Path(__file__).with_name("qwen_asr_runner.py")
FUNASR_RUNNER = Path(__file__).with_name("funasr_runner.py")
PROVIDERS = {"qwen-asr", "sherpa-onnx", "funasr"}
PROJECT_ROOT = Path(__file__).resolve().parent.parent
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="flycut-asr")
DISCOVERED: dict[str, dict] = {}
JOB_CANCEL: dict[str, threading.Event] = {}


def read_catalog() -> list[dict]:
    if not CATALOG.exists():
        return []
    value = json.loads(CATALOG.read_text(encoding="utf-8"))
    return value if isinstance(value, list) else []


def write_catalog(models: list[dict]) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    temp = CATALOG.with_suffix(".tmp")
    temp.write_text(json.dumps(models, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(CATALOG)


def safe_upload_path(value: str) -> Path:
    path = Path(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("invalid relative model file path")
    return Path(*path.parts)


def model_roots() -> list[Path]:
    configured = os.environ.get("FLYCUT_MODEL_ROOTS", "")
    values = [Path(item).expanduser() for item in configured.split(os.pathsep) if item]
    values.extend([ROOT / "models", Path.home() / "models"])
    return list(dict.fromkeys(path.resolve() for path in values))


def discover_models() -> list[dict]:
    DISCOVERED.clear()
    result: list[dict] = []
    for root in model_roots():
        if not root.is_dir():
            continue
        for directory in [root, *[item for item in root.iterdir() if item.is_dir() and not item.name.startswith(".")]]:
            config_path = directory / "config.json"
            files = {item.name for item in directory.iterdir()} if directory.is_dir() else set()
            provider = None
            family = None
            if config_path.is_file():
                try:
                    config = json.loads(config_path.read_text(encoding="utf-8"))
                    if config.get("model_type") == "qwen3_asr" or config.get("thinker_config"):
                        provider, family = "qwen-asr", "qwen_asr"
                except (OSError, ValueError):
                    pass
            if provider is None and "config.yaml" in files and ("model.pt" in files or "model.pth" in files):
                # Auxiliary VAD/punctuation/speaker checkpoints are not ASR candidates.
                import re
                match = re.search(r"(?m)^model:\s*['\"]?([\w-]+)", (directory / "config.yaml").read_text(encoding="utf-8"))
                families = {"Paraformer": "paraformer", "SenseVoiceSmall": "sense_voice"}
                if match and match.group(1) in families:
                    provider, family = "funasr", families[match.group(1)]
            if provider is None and ("tokens.txt" in files or any(name.endswith(".onnx") for name in files)):
                provider, family = "sherpa-onnx", "sense_voice"
            if not provider:
                continue
            candidate_id = "candidate-" + hashlib.sha256(str(directory).encode()).hexdigest()[:16]
            candidate = {"candidateId": candidate_id, "name": directory.name, "provider": provider,
                         "family": family, "files": sorted(files)}
            DISCOVERED[candidate_id] = {**candidate, "path": str(directory)}
            result.append(candidate)
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "FlyCutRuntime/0.1"

    def log_message(self, *_args):
        return

    def authorized(self):
        token = os.environ.get('FLYCUT_WORKER_TOKEN')
        return not token or hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token)

    def send_json(self, status: int, value: object) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        if not os.environ.get('FLYCUT_WORKER_TOKEN'):
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Flycut-Model, X-Flycut-Language, X-Flycut-Path")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path == "/health":
            return self.send_json(200, {"ok": True, "version": self.server_version, "providers": sorted(PROVIDERS), "asyncJobs": True})
        if path == "/v1/models":
            return self.send_json(200, {"models": read_catalog()})
        if path == "/v1/runtime/config":
            return self.send_json(200, {"catalog": str(CATALOG), "roots": [str(root) for root in model_roots()]})
        if path == "/v1/models/discover":
            return self.send_json(200, {"roots": [str(root) for root in model_roots()], "models": discover_models()})
        if path.startswith("/v1/asr/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            return self.send_json(200, job) if job else self.send_json(404, {"error": "unknown_job"})
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path.startswith('/v1/asr/jobs/') and path.endswith('/cancel'):
            job_id = path.split('/')[-2]
            with JOBS_LOCK:
                event = JOB_CANCEL.get(job_id)
                if event:
                    event.set()
            return self.send_json(200, {"cancelled": bool(event)})
        if path == "/v1/models/register":
            return self.register_model()
        if path == "/v1/models/register-discovered":
            return self.register_discovered_model()
        if path == "/v1/models/upload-file":
            return self.upload_file()
        if path == "/v1/models/commit":
            return self.commit_upload()
        if path == "/v1/asr/transcribe":
            return self.transcribe()
        if path == "/v1/asr/jobs":
            return self.create_job()
        self.send_json(404, {"error": "not_found"})

    def body_json(self) -> dict:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 1_000_000:
            raise ValueError("request too large")
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def register_model(self):
        try:
            model = self.body_json()
            model_id = str(model.get("id", ""))
            model_path = Path(str(model.get("path", ""))).expanduser().resolve()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", model_id) or not model_path.is_dir():
                raise ValueError("invalid model id or model directory")
            if model.get("provider", "qwen-asr") not in PROVIDERS:
                raise ValueError("unsupported provider")
            model["path"] = str(model_path)
            models = [m for m in read_catalog() if m.get("id") != model_id]
            models.append(model)
            write_catalog(models)
            self.send_json(200, model)
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def register_discovered_model(self):
        try:
            payload = self.body_json()
            candidate = DISCOVERED.get(str(payload.get("candidateId", "")))
            model_id = str(payload.get("id", ""))
            if not candidate or not model_id.startswith("custom-"):
                raise ValueError("unknown model candidate or invalid id")
            model = {"id": model_id, "name": payload.get("name") or candidate["name"],
                     "provider": candidate["provider"], "family": candidate["family"],
                     "path": candidate["path"], "config": payload.get("config", {})}
            models = [m for m in read_catalog() if m.get("id") != model_id]
            models.append(model)
            write_catalog(models)
            self.send_json(200, model)
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def upload_file(self):
        try:
            model_id = self.headers.get("X-Flycut-Model", "")
            relative = safe_upload_path(self.headers.get("X-Flycut-Path", ""))
            size = int(self.headers.get("Content-Length", "0"))
            if not model_id.startswith("custom-") or size <= 0 or size > 500 * 1024 * 1024:
                raise ValueError("invalid model upload")
            destination = ROOT / "uploads" / model_id / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(self.rfile.read(size))
            self.send_json(200, {"path": str(relative)})
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def commit_upload(self):
        try:
            model = self.body_json()
            model_id = str(model.get("id", ""))
            if model.get("provider", "qwen-asr") not in PROVIDERS:
                raise ValueError("unsupported provider")
            source = ROOT / "uploads" / model_id
            if not model_id.startswith("custom-") or not source.is_dir():
                raise ValueError("no uploaded model files")
            destination = ROOT / "models" / model_id
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                import shutil
                shutil.rmtree(destination)
            source.replace(destination)
            model["path"] = str(destination)
            models = [m for m in read_catalog() if m.get("id") != model_id]
            models.append(model)
            write_catalog(models)
            self.send_json(200, model)
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def transcribe(self):
        # Multipart parsing is intentionally avoided: the browser sends a WAV
        # body and metadata in headers, which keeps this endpoint dependency-free.
        model_id = self.headers.get("X-Flycut-Model", "")
        language = self.headers.get("X-Flycut-Language", "auto")
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > 500 * 1024 * 1024:
            return self.send_json(400, {"error": "invalid audio body"})
        model = next((m for m in read_catalog() if m.get("id") == model_id), None)
        if not model:
            return self.send_json(404, {"error": "unknown model"})
        if model.get("provider", "qwen-asr") not in PROVIDERS:
            return self.send_json(400, {"error": "unsupported model provider"})
        try:
            audio = self.rfile.read(content_length)
            self.send_json(200, run_model(model, language, audio))
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def create_job(self):
        model_id = self.headers.get("X-Flycut-Model", "")
        language = self.headers.get("X-Flycut-Language", "auto")
        content_length = int(self.headers.get("Content-Length", "0"))
        model = next((m for m in read_catalog() if m.get("id") == model_id), None)
        if not model or model.get("provider", "qwen-asr") not in PROVIDERS:
            return self.send_json(400, {"error": "unknown or unsupported model"})
        if content_length <= 0 or content_length > 500 * 1024 * 1024:
            return self.send_json(400, {"error": "invalid audio body"})
        job_id = uuid.uuid4().hex
        cancel = threading.Event()
        try:
            execution = json.loads(self.headers.get('X-Flycut-Execution', '{}'))
        except ValueError:
            return self.send_json(400, {"error": "invalid execution config"})
        with JOBS_LOCK:
            JOBS[job_id] = {"id": job_id, "status": "queued", "progress": 0}
            JOB_CANCEL[job_id] = cancel
        audio = self.rfile.read(content_length)
        EXECUTOR.submit(run_job, job_id, model, language, audio, cancel, execution)
        self.send_json(202, {"id": job_id, "status": "queued"})


def run_model(model: dict, language: str, audio: bytes, cancel=None, execution=None) -> dict:
    with tempfile.TemporaryDirectory(prefix="flycut-runtime-") as directory:
        audio_path = Path(directory) / "input.wav"
        audio_path.write_bytes(audio)
        provider = model.get("provider", "qwen-asr")
        if provider in {"qwen-asr", "funasr"}:
            config = json.dumps(model.get("config", {}), ensure_ascii=False)
            runner = FUNASR_RUNNER if provider == "funasr" else RUNNER
            command = [model.get("config", {}).get("python_path") or os.environ.get("FLYCUT_PYTHON", sys.executable), str(runner),
                       "--model", str(Path(model["path"]).expanduser()), "--input", str(audio_path),
                       "--language", language, "--config", config]
        elif provider == "sherpa-onnx":
            default_sidecar = PROJECT_ROOT / "src-tauri" / "binaries" / ("funasr-asr.exe" if os.name == "nt" else "funasr-asr")
            sidecar = os.environ.get("FLYCUT_FUNASR_SIDECAR", str(default_sidecar) if default_sidecar.is_file() else "funasr-asr")
            config = json.dumps(model.get("config", {}), ensure_ascii=False)
            command = [sidecar, "--input", str(audio_path), "--model", str(Path(model["path"]).expanduser()),
                       "--model-type", str(model.get("family", "")), "--recognizer-config", config,
                       "--vad-type", "none", "--language", language, "--timestamp-mode", (execution or {}).get('timestampMode', 'auto'), "--output-json"]
        else:
            raise ValueError(f"unsupported provider: {provider}")
        if cancel is None:
            result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
            if result.returncode:
                raise RuntimeError(result.stderr[-4000:] or "model runner failed")
            return json.loads(result.stdout)
        # Redirect output to files: runners may write large transcripts and must
        # never block on a full PIPE while the cancellation owner is waiting.
        with tempfile.TemporaryFile(mode='w+') as output, tempfile.TemporaryFile(mode='w+') as errors:
            process = subprocess.Popen(command, stdout=output, stderr=errors,
                                       start_new_session=os.name != 'nt')
            import time
            deadline = time.monotonic() + 1800
            try:
                while process.poll() is None:
                    if cancel.wait(0.1):
                        raise RuntimeError('ASR cancelled')
                    if time.monotonic() > deadline:
                        raise RuntimeError('ASR timed out')
                output.seek(0)
                errors.seek(0)
                if process.returncode:
                    raise RuntimeError(errors.read()[-4000:] or 'model runner failed')
                return json.loads(output.read())
            finally:
                if process.poll() is None:
                    if os.name != 'nt':
                        import signal
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        if os.name != 'nt':
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                        process.wait()


def run_job(job_id: str, model: dict, language: str, audio: bytes, cancel=None, execution=None) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(status="running", progress=5)
    try:
        if cancel and cancel.is_set():
            raise RuntimeError('ASR cancelled')
        result = run_model(model, language, audio, cancel, execution)
        with JOBS_LOCK:
            if cancel and cancel.is_set():
                JOBS[job_id].update(status='cancelled', error='ASR cancelled')
            else:
                JOBS[job_id].update(status="complete", progress=100, result=result)
    except Exception as error:
        with JOBS_LOCK:
            JOBS[job_id].update(status="cancelled" if cancel and cancel.is_set() else "error", progress=100, error=str(error))
    finally:
        with JOBS_LOCK:
            JOB_CANCEL.pop(job_id, None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"FlyCut Runtime listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

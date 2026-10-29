// funasr-asr sidecar
//
// 基于 sherpa-onnx 1.13.3 的 ASR CLI，支持 8 个 model family：
//   sense_voice / paraformer / whisper / moonshine / telespeech_ctc /
//   zipformer_ctc / nemo_transducer / fire_red_asr
//
// 识别流程：
//   1. 输入媒体文件（非 WAV 自动用 ffmpeg 转 16k 单声道 WAV）
//   2. 用 silero VAD 把整段音频切成语音段
//   3. 对每段独立跑 OfflineRecognizer，合并时间戳
//   4. 输出 JSON：
//      - chunks：句子级（必选；有字词时间戳时由字词分组，否则为 VAD 段）
//      - wordChunks：字词级（模型支持 token timestamps 时提供）
//      - hasWordTimestamps：是否具备字词级裁剪能力
//
// 参数：
//   --input <media-file>
//   --model <model-dir>
//   --model-type <family>        与 manifest 的 family 字段一致
//   --recognizer-config <json>   manifest 的 recognizer_config 序列化字符串
//   --vad-type <fsmn|silero>     默认 fsmn
//   --vad-dir <dir>              FSMN VAD 模型目录（fsmn 时必填）
//   --vad-model <onnx-path>      silero_vad.onnx 路径（silero 时必填）
//   --language <zh|en|auto|...>
//   --output-json

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    OfflineFireRedAsrModelConfig, OfflineModelConfig, OfflineMoonshineModelConfig,
    OfflineParaformerModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineRecognizerResult, OfflineSenseVoiceModelConfig, OfflineTransducerModelConfig,
    OfflineWhisperModelConfig, OfflineZipformerCtcModelConfig, SileroVadModelConfig,
    VadModelConfig, VoiceActivityDetector, Wave,
};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

mod fsmn_vad;
use fsmn_vad::{segment_with_fsmn_vad, VadBackend};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimestampMode {
    Auto,
    Token,
    Segment,
}

#[derive(Debug)]
struct Args {
    input: PathBuf,
    model: PathBuf,
    model_type: String,
    recognizer_config: Option<RecognizerConfig>,
    recognizer_config_raw: String,
    vad_type: VadBackend,
    vad_dir: Option<PathBuf>,
    vad_model: Option<PathBuf>,
    language: String,
    timestamp_mode: TimestampMode,
    output_json: bool,
    vad_dump_json: bool,
}

#[derive(Debug, Serialize)]
struct VadDumpOutput {
    #[serde(rename = "vadType")]
    vad_type: String,
    duration: f64,
    #[serde(rename = "segmentCount")]
    segment_count: usize,
    segments: Vec<[i32; 2]>,
}

/// 从 manifest 透传的 recognizer_config，按 model_type 反序列化后用 build_recognizer 分发。
/// 所有 family 特有字段都是 Option，缺失时用 #[serde(default)] 兜底。
#[derive(Debug, Deserialize)]
struct RecognizerConfig {
    model_type: String,
    tokens: String,
    // sense_voice
    #[serde(default)]
    sense_voice_model: Option<String>,
    // paraformer
    #[serde(default)]
    paraformer_model: Option<String>,
    // whisper
    #[serde(default)]
    whisper_encoder: Option<String>,
    #[serde(default)]
    whisper_decoder: Option<String>,
    // moonshine
    #[serde(default)]
    moonshine_preprocessor: Option<String>,
    #[serde(default)]
    moonshine_encoder: Option<String>,
    #[serde(default)]
    moonshine_uncached_decoder: Option<String>,
    #[serde(default)]
    moonshine_cached_decoder: Option<String>,
    // telespeech_ctc / zipformer_ctc
    #[serde(default)]
    telespeech_ctc_model: Option<String>,
    #[serde(default)]
    zipformer_ctc_model: Option<String>,
    // nemo_transducer
    #[serde(default)]
    encoder: Option<String>,
    #[serde(default)]
    decoder: Option<String>,
    #[serde(default)]
    joiner: Option<String>,
    // fire_red_asr
    #[serde(default)]
    fire_red_asr_encoder: Option<String>,
    #[serde(default)]
    fire_red_asr_decoder: Option<String>,
    // 通用
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    use_itn: Option<bool>,
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    sample_rate: Option<i32>,
    #[serde(default)]
    feature_dim: Option<i32>,
    #[serde(default)]
    num_threads: Option<i32>,
}

#[derive(Debug, Clone)]
struct TimedChunk {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Serialize)]
struct OutputSubtitleChunk {
    id: String,
    text: String,
    timestamp: [f64; 2],
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sentenceId")]
    sentence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "wordIds")]
    word_ids: Option<Vec<String>>,
    selected: bool,
}

#[derive(Debug, Serialize)]
struct OutputTranscript {
    text: String,
    chunks: Vec<OutputSubtitleChunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "wordChunks")]
    word_chunks: Option<Vec<OutputSubtitleChunk>>,
    #[serde(rename = "hasWordTimestamps")]
    has_word_timestamps: bool,
    language: String,
    duration: f64,
}

struct RecognitionOutput {
    text: String,
    duration: f64,
    chunks: Vec<OutputSubtitleChunk>,
    word_chunks: Option<Vec<OutputSubtitleChunk>>,
    has_word_timestamps: bool,
}

fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            process::exit(1);
        }
    }
}

fn run() -> Result<String, String> {
    let args = parse_args(env::args().skip(1))?;
    validate_args(&args)?;

    if !args.output_json && !args.vad_dump_json {
        return Err("必须指定 --output-json 或 --vad-dump-json".to_string());
    }

    let audio_path = prepare_wav_input(&args.input)?;

    if args.vad_dump_json {
        let dump = dump_vad_segments(&args, &audio_path)?;
        if audio_path != args.input {
            let _ = fs::remove_file(&audio_path);
        }
        return serde_json::to_string(&dump).map_err(|e| format!("序列化 VAD 结果失败：{e}"));
    }

    let recognition = recognize(&args, &audio_path);

    if audio_path != args.input {
        let _ = fs::remove_file(&audio_path);
    }

    let recognition = recognition?;
    let output = OutputTranscript {
        text: recognition.text,
        chunks: recognition.chunks,
        word_chunks: recognition.word_chunks,
        has_word_timestamps: recognition.has_word_timestamps,
        language: args.language.clone(),
        duration: recognition.duration,
    };

    serde_json::to_string(&output)
        .map_err(|e| format!("序列化 ASR 结果失败：{e}"))
}

fn recognize(args: &Args, wav_path: &Path) -> Result<RecognitionOutput, String> {
    let config = args
        .recognizer_config
        .as_ref()
        .ok_or_else(|| "缺少 --recognizer-config 参数".to_string())?;

    let recognizer = build_recognizer(config, &args.model, args.timestamp_mode)?;

    recognize_with_vad(
        &recognizer,
        args.vad_type,
        args.vad_dir.as_deref(),
        args.vad_model.as_deref(),
        wav_path,
        config,
        args.timestamp_mode,
    )
}

/// 按 model_type 分发到对应 sherpa-onnx Config，构造 OfflineRecognizer。
fn build_recognizer(
    config: &RecognizerConfig,
    model_dir: &Path,
    timestamp_mode: TimestampMode,
) -> Result<OfflineRecognizer, String> {
    let want_token_timestamps = matches!(
        timestamp_mode,
        TimestampMode::Auto | TimestampMode::Token
    );
    let mut mc = OfflineModelConfig::default();
    mc.tokens = Some(model_dir.join(&config.tokens).to_string_lossy().to_string());
    mc.num_threads = config.num_threads.unwrap_or(2);
    mc.provider = Some("cpu".to_string());
    mc.debug = false;

    // 把相对路径解析为绝对路径（相对 model_dir）
    let resolve = |rel: &Option<String>| -> Option<String> {
        rel.as_ref()
            .map(|p| model_dir.join(p).to_string_lossy().to_string())
    };

    match config.model_type.as_str() {
        "sense_voice" => {
            mc.sense_voice = OfflineSenseVoiceModelConfig {
                model: resolve(&config.sense_voice_model),
                language: config.language.clone().or(Some("auto".to_string())),
                use_itn: config.use_itn.unwrap_or(true),
            };
            mc.model_type = Some("sense_voice".to_string());
        }
        "paraformer" => {
            mc.paraformer = OfflineParaformerModelConfig {
                model: resolve(&config.paraformer_model),
            };
            mc.model_type = Some("paraformer".to_string());
        }
        "whisper" => {
            mc.whisper = OfflineWhisperModelConfig {
                encoder: resolve(&config.whisper_encoder),
                decoder: resolve(&config.whisper_decoder),
                language: config.language.clone().or(Some("en".to_string())),
                task: config.task.clone().or(Some("transcribe".to_string())),
                enable_token_timestamps: want_token_timestamps,
                enable_segment_timestamps: false,
                ..Default::default()
            };
            mc.model_type = Some("whisper".to_string());
        }
        "moonshine" => {
            mc.moonshine = OfflineMoonshineModelConfig {
                preprocessor: resolve(&config.moonshine_preprocessor),
                encoder: resolve(&config.moonshine_encoder),
                uncached_decoder: resolve(&config.moonshine_uncached_decoder),
                cached_decoder: resolve(&config.moonshine_cached_decoder),
                ..Default::default()
            };
            mc.model_type = Some("moonshine".to_string());
        }
        "telespeech_ctc" => {
            // telespeech_ctc 是 OfflineModelConfig 的 Option<String> 字段（不是 struct）
            mc.telespeech_ctc = resolve(&config.telespeech_ctc_model);
            mc.model_type = Some("telespeech_ctc".to_string());
        }
        "zipformer_ctc" => {
            mc.zipformer_ctc = OfflineZipformerCtcModelConfig {
                model: resolve(&config.zipformer_ctc_model),
            };
            mc.model_type = Some("zipformer_ctc".to_string());
        }
        "nemo_transducer" => {
            mc.transducer = OfflineTransducerModelConfig {
                encoder: resolve(&config.encoder),
                decoder: resolve(&config.decoder),
                joiner: resolve(&config.joiner),
            };
            mc.model_type = Some("nemo_transducer".to_string());
        }
        "fire_red_asr" => {
            mc.fire_red_asr = OfflineFireRedAsrModelConfig {
                encoder: resolve(&config.fire_red_asr_encoder),
                decoder: resolve(&config.fire_red_asr_decoder),
            };
            mc.model_type = Some("fire_red_asr".to_string());
        }
        other => return Err(format!("不支持的 model_type: {other}")),
    }

    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config = mc;
    cfg.decoding_method = Some("greedy_search".to_string());

    OfflineRecognizer::create(&cfg).ok_or_else(|| {
        format!(
            "创建 OfflineRecognizer 失败（model_type={}）。请确认模型文件完整且与 family 匹配。",
            config.model_type
        )
    })
}

/// 字幕场景 VAD：仅在自然停顿处切段，不做短时长强切（强切交给模型 token 时间 + 组句）。
const SUBTITLE_MAX_SPEECH_SECS: f32 = 30.0;
const SUBTITLE_MIN_SILENCE_SECS: f32 = 0.35;
const SUBTITLE_MIN_SPEECH_SECS: f32 = 0.25;
const SUBTITLE_VAD_THRESHOLD: f32 = 0.45;

/// 字词时间戳组句：在真实 token 时间上拆短字幕条。
struct SentenceGroupingConfig {
    max_duration_secs: f64,
    pause_threshold_secs: f64,
    sentence_enders: &'static [&'static str],
    merge_adjacent_digit_tokens: bool,
}

const DEFAULT_SENTENCE_GROUPING: SentenceGroupingConfig = SentenceGroupingConfig {
    max_duration_secs: 10.0,
    pause_threshold_secs: 0.6,
    sentence_enders: &[
        ".", "!", "?", "。", "！", "？", "…", "；", ";", ",", "，", " ",
    ],
    merge_adjacent_digit_tokens: true,
};

fn dump_vad_segments(args: &Args, wav_path: &Path) -> Result<VadDumpOutput, String> {
    let wav_path_str = wav_path
        .to_str()
        .ok_or_else(|| format!("音频路径包含非法字符：{}", wav_path.display()))?;
    let wave = Wave::read(wav_path_str)
        .ok_or_else(|| format!("无法读取 WAV 音频：{}", wav_path.display()))?;
    let sample_rate = wave.sample_rate();
    let samples: Vec<f32> = wave.samples().to_vec();
    let duration = samples.len() as f64 / sample_rate as f64;

    let segments_ms: Vec<[i32; 2]> = match args.vad_type {
        VadBackend::None => vec![[0, (duration * 1000.0).round() as i32]],
        VadBackend::Fsmn => {
            let model_dir = args
                .vad_dir
                .as_ref()
                .ok_or_else(|| "FSMN VAD 需要 --vad-dir 参数".to_string())?;
            let segments = segment_with_fsmn_vad(wav_path, model_dir, &samples, sample_rate)?;
            segments
                .into_iter()
                .map(|(start_sample, seg_samples)| {
                    let start_ms =
                        ((start_sample as f64 / sample_rate as f64) * 1000.0).round() as i32;
                    let end_ms = (((start_sample + seg_samples.len()) as f64
                        / sample_rate as f64)
                        * 1000.0)
                        .round() as i32;
                    [start_ms, end_ms]
                })
                .collect()
        }
        VadBackend::Silero => {
            let vad_model_path = args
                .vad_model
                .as_ref()
                .ok_or_else(|| "Silero VAD 需要 --vad-model 参数".to_string())?;

            let mut vad_config = VadModelConfig::default();
            vad_config.silero_vad = SileroVadModelConfig {
                model: Some(vad_model_path.to_string_lossy().to_string()),
                threshold: SUBTITLE_VAD_THRESHOLD,
                min_silence_duration: SUBTITLE_MIN_SILENCE_SECS,
                min_speech_duration: SUBTITLE_MIN_SPEECH_SECS,
                window_size: 512,
                max_speech_duration: SUBTITLE_MAX_SPEECH_SECS,
            };
            vad_config.sample_rate = sample_rate;
            vad_config.num_threads = 1;
            vad_config.provider = Some("cpu".to_string());
            vad_config.debug = false;

            let vad = VoiceActivityDetector::create(&vad_config, 60.0).ok_or_else(|| {
                "创建 silero VAD 失败，请确认 silero_vad.onnx 路径正确".to_string()
            })?;

            let window = vad_config.silero_vad.window_size as usize;
            let mut segments: Vec<(usize, Vec<f32>)> = Vec::new();
            let mut i = 0;
            while i + window <= samples.len() {
                vad.accept_waveform(&samples[i..i + window]);
                drain_vad_segments(&vad, &mut segments);
                i += window;
            }
            if i < samples.len() {
                vad.accept_waveform(&samples[i..]);
            }
            vad.flush();
            drain_vad_segments(&vad, &mut segments);

            segments
                .into_iter()
                .map(|(start_sample, seg_samples)| {
                    let start_ms =
                        ((start_sample as f64 / sample_rate as f64) * 1000.0).round() as i32;
                    let end_ms = (((start_sample + seg_samples.len()) as f64
                        / sample_rate as f64)
                        * 1000.0)
                        .round() as i32;
                    [start_ms, end_ms]
                })
                .collect()
        }
    };

    Ok(VadDumpOutput {
        vad_type: match args.vad_type {
            VadBackend::None => "none".to_string(),
            VadBackend::Fsmn => "fsmn".to_string(),
            VadBackend::Silero => "silero".to_string(),
        },
        duration,
        segment_count: segments_ms.len(),
        segments: segments_ms,
    })
}

/// VAD 分段识别：FSMN / silero VAD 切段 → 每段独立识别 → 合并时间戳。
/// 若 VAD 未切出任何段（静音/失败），回退整段识别一次。
fn recognize_with_vad(
    recognizer: &OfflineRecognizer,
    vad_type: VadBackend,
    vad_dir: Option<&Path>,
    vad_model_path: Option<&Path>,
    wav_path: &Path,
    _config: &RecognizerConfig,
    timestamp_mode: TimestampMode,
) -> Result<RecognitionOutput, String> {
    let wav_path_str = wav_path
        .to_str()
        .ok_or_else(|| format!("音频路径包含非法字符：{}", wav_path.display()))?;
    let wave = Wave::read(wav_path_str)
        .ok_or_else(|| format!("无法读取 WAV 音频：{}", wav_path.display()))?;
    let sample_rate = wave.sample_rate();
    // Wave 是 !Send + !Sync，复制一份独立持有
    let samples: Vec<f32> = wave.samples().to_vec();

    let mut segments: Vec<(usize, Vec<f32>)> = Vec::new();

    match vad_type {
        VadBackend::None => {
            segments.push((0, samples.clone()));
        }
        VadBackend::Fsmn => {
            let model_dir = vad_dir.ok_or_else(|| "FSMN VAD 需要 --vad-dir 参数".to_string())?;
            segments = segment_with_fsmn_vad(wav_path, model_dir, &samples, sample_rate)?;
        }
        VadBackend::Silero => {
            let vad_model_path = vad_model_path
                .ok_or_else(|| "Silero VAD 需要 --vad-model 参数".to_string())?;

            let mut vad_config = VadModelConfig::default();
            vad_config.silero_vad = SileroVadModelConfig {
                model: Some(vad_model_path.to_string_lossy().to_string()),
                threshold: SUBTITLE_VAD_THRESHOLD,
                min_silence_duration: SUBTITLE_MIN_SILENCE_SECS,
                min_speech_duration: SUBTITLE_MIN_SPEECH_SECS,
                window_size: 512,
                max_speech_duration: SUBTITLE_MAX_SPEECH_SECS,
            };
            vad_config.sample_rate = sample_rate;
            vad_config.num_threads = 1;
            vad_config.provider = Some("cpu".to_string());
            vad_config.debug = false;

            let vad = VoiceActivityDetector::create(&vad_config, 60.0).ok_or_else(|| {
                "创建 silero VAD 失败，请确认 silero_vad.onnx 路径正确".to_string()
            })?;

            let window = vad_config.silero_vad.window_size as usize;
            let mut i = 0;
            while i + window <= samples.len() {
                vad.accept_waveform(&samples[i..i + window]);
                drain_vad_segments(&vad, &mut segments);
                i += window;
            }
            if i < samples.len() {
                vad.accept_waveform(&samples[i..]);
            }
            vad.flush();
            drain_vad_segments(&vad, &mut segments);
        }
    }

    // 3. 每段独立识别：VAD 段始终记录；字词时间戳单独收集
    let mut vad_segments = Vec::new();
    let mut word_segments = Vec::new();
    let mut full_text = String::new();

    for (_idx, (start_sample, seg_samples)) in segments.iter().enumerate() {
        if seg_samples.is_empty() {
            continue;
        }
        let stream = recognizer.create_stream();
        stream.accept_waveform(sample_rate, seg_samples);
        recognizer.decode(&stream);

        if let Some(result) = stream.get_result() {
            let start_sec = *start_sample as f64 / sample_rate as f64;
            let end_sec = (*start_sample + seg_samples.len()) as f64 / sample_rate as f64;
            append_recognition_result(
                &result,
                start_sec,
                end_sec,
                timestamp_mode,
                &mut vad_segments,
                &mut word_segments,
                &mut full_text,
            );
        }
    }

    // 4. 兜底：VAD 未切出任何段（静音或失败），回退整段识别
    if vad_segments.is_empty() && word_segments.is_empty() {
        let stream = recognizer.create_stream();
        stream.accept_waveform(sample_rate, &samples);
        recognizer.decode(&stream);
        if let Some(result) = stream.get_result() {
            let end_sec = samples.len() as f64 / sample_rate as f64;
            append_recognition_result(
                &result,
                0.0,
                end_sec,
                timestamp_mode,
                &mut vad_segments,
                &mut word_segments,
                &mut full_text,
            );
        }
    }

    if vad_segments.is_empty() && word_segments.is_empty() {
        return Err(
            "VAD 与整段识别均未识别到字幕文本，请确认视频包含清晰人声或尝试更换模型".to_string(),
        );
    }

    let duration = samples.len() as f64 / sample_rate as f64;
    finalize_recognition_output(full_text.trim().to_string(), duration, vad_segments, word_segments)
}

fn append_recognition_result(
    result: &OfflineRecognizerResult,
    segment_start_sec: f64,
    segment_end_sec: f64,
    timestamp_mode: TimestampMode,
    vad_segments: &mut Vec<TimedChunk>,
    word_segments: &mut Vec<TimedChunk>,
    full_text: &mut String,
) {
    let text = result.text.trim().to_string();
    if text.is_empty() {
        return;
    }

    vad_segments.push(TimedChunk {
        text: text.clone(),
        start: segment_start_sec,
        end: segment_end_sec,
    });

    let prefer_token = !matches!(timestamp_mode, TimestampMode::Segment);
    if prefer_token && has_token_timestamps(result) {
        let mut token_chunks =
            tokens_to_chunks(result, segment_start_sec, segment_end_sec);
        if DEFAULT_SENTENCE_GROUPING.merge_adjacent_digit_tokens {
            token_chunks = merge_adjacent_digit_tokens(token_chunks);
        }
        if !token_chunks.is_empty() {
            word_segments.extend(token_chunks);
        }
    }

    full_text.push_str(&text);
    full_text.push(' ');
}

fn finalize_recognition_output(
    text: String,
    duration: f64,
    vad_segments: Vec<TimedChunk>,
    word_segments: Vec<TimedChunk>,
) -> Result<RecognitionOutput, String> {
    if !word_segments.is_empty() {
        let (sentences, words) =
            group_words_into_sentences(word_segments, &DEFAULT_SENTENCE_GROUPING);
        return Ok(RecognitionOutput {
            text,
            duration,
            chunks: sentences,
            word_chunks: Some(words),
            has_word_timestamps: true,
        });
    }

    let chunks = vad_segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| OutputSubtitleChunk {
            id: format!("sentence-{}", index),
            text: segment.text,
            timestamp: [segment.start, segment.end],
            sentence_id: None,
            word_ids: None,
            selected: false,
        })
        .collect();

    Ok(RecognitionOutput {
        text,
        duration,
        chunks,
        word_chunks: None,
        has_word_timestamps: false,
    })
}

fn text_ends_sentence(text: &str, sentence_enders: &[&str]) -> bool {
    let trimmed = text.trim_end();
    sentence_enders.iter().any(|ender| {
        if *ender == " " {
            text.ends_with(' ') || trimmed.len() != text.len()
        } else {
            trimmed.ends_with(ender)
        }
    })
}

fn group_words_into_sentences(
    words: Vec<TimedChunk>,
    config: &SentenceGroupingConfig,
) -> (Vec<OutputSubtitleChunk>, Vec<OutputSubtitleChunk>) {
    let mut sentences = Vec::new();
    let mut output_words = Vec::new();
    let mut current_words: Vec<(usize, TimedChunk)> = Vec::new();
    let mut sentence_index = 0;
    let indexed_words: Vec<(usize, TimedChunk)> = words.into_iter().enumerate().collect();

    for (i, (word_index, word)) in indexed_words.iter().cloned().enumerate() {
        current_words.push((word_index, word));

        let is_last = i + 1 == indexed_words.len();
        let next_word = if is_last {
            None
        } else {
            Some(&indexed_words[i + 1].1)
        };

        let current_duration = current_words[current_words.len() - 1].1.end - current_words[0].1.start;
        let pause_to_next = next_word
            .map(|next| next.start - current_words[current_words.len() - 1].1.end)
            .unwrap_or(0.0);
        let current_text = &current_words[current_words.len() - 1].1.text;
        let ends_on_ender = text_ends_sentence(current_text, config.sentence_enders);

        let should_end_sentence = is_last
            || current_duration >= config.max_duration_secs
            || pause_to_next >= config.pause_threshold_secs
            || ends_on_ender;

        if should_end_sentence {
            flush_sentence_group(
                &mut current_words,
                &mut sentences,
                &mut output_words,
                &mut sentence_index,
            );
        }
    }

    (sentences, output_words)
}

fn flush_sentence_group(
    current_words: &mut Vec<(usize, TimedChunk)>,
    sentences: &mut Vec<OutputSubtitleChunk>,
    output_words: &mut Vec<OutputSubtitleChunk>,
    sentence_index: &mut usize,
) {
    if current_words.is_empty() {
        return;
    }

    let sentence_id = format!("sentence-{}", *sentence_index);
    let start = current_words[0].1.start;
    let end = current_words[current_words.len() - 1].1.end;
    let sentence_text: String = current_words
        .iter()
        .map(|(_, w)| w.text.as_str())
        .collect();
    let word_ids: Vec<String> = current_words
        .iter()
        .map(|(word_index, _)| format!("word-{}", word_index + 1))
        .collect();

    for (word_index, word) in current_words.drain(..) {
        output_words.push(OutputSubtitleChunk {
            id: format!("word-{}", word_index + 1),
            text: word.text,
            timestamp: [word.start, word.end],
            sentence_id: Some(sentence_id.clone()),
            word_ids: None,
            selected: false,
        });
    }

    sentences.push(OutputSubtitleChunk {
        id: sentence_id,
        text: sentence_text,
        timestamp: [start, end],
        sentence_id: None,
        word_ids: Some(word_ids),
        selected: false,
    });

    *sentence_index += 1;
}

fn has_token_timestamps(result: &OfflineRecognizerResult) -> bool {
    let Some(timestamps) = &result.timestamps else {
        return false;
    };
    !timestamps.is_empty() && timestamps.len() == result.tokens.len()
}

fn is_punctuation_only(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | '…' | '；' | ';' | '，' | ',' | '、' | ':' | '：' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}' | '（' | '）' | '(' | ')'))
}

fn is_skippable_token(token: &str) -> bool {
    let trimmed = token.trim();
    trimmed.is_empty()
        || trimmed == "<s>"
        || trimmed == "</s>"
        || trimmed == "<unk>"
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
}

fn normalize_token_text(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.ends_with("@@") && trimmed.len() > 2 {
        trimmed[..trimmed.len() - 2].to_string()
    } else {
        trimmed.to_string()
    }
}

fn token_end_sec(
    timestamps: &[f32],
    durations: Option<&[f32]>,
    index: usize,
    segment_start_sec: f64,
    segment_end_sec: f64,
) -> f64 {
    if let Some(durs) = durations {
        if index < durs.len() && durs[index] > 0.0 {
            return segment_start_sec + timestamps[index] as f64 + durs[index] as f64;
        }
    }
    if index + 1 < timestamps.len() {
        segment_start_sec + timestamps[index + 1] as f64
    } else {
        segment_end_sec
    }
}

fn is_digit_only(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit())
}

fn merge_adjacent_digit_tokens(chunks: Vec<TimedChunk>) -> Vec<TimedChunk> {
    let mut merged: Vec<TimedChunk> = Vec::new();
    for chunk in chunks {
        if let Some(last) = merged.last_mut() {
            if is_digit_only(&last.text) && is_digit_only(&chunk.text) {
                last.text.push_str(&chunk.text);
                last.end = chunk.end;
                continue;
            }
        }
        merged.push(chunk);
    }
    merged
}

fn tokens_to_chunks(
    result: &OfflineRecognizerResult,
    segment_start_sec: f64,
    segment_end_sec: f64,
) -> Vec<TimedChunk> {
    let timestamps = result.timestamps.as_ref().unwrap();
    let durations = result.durations.as_deref();

    let mut chunks: Vec<TimedChunk> = Vec::new();
    for (index, token) in result.tokens.iter().enumerate() {
        if is_skippable_token(token) {
            continue;
        }
        let text = normalize_token_text(token);
        if text.is_empty() {
            continue;
        }

        let start = segment_start_sec + timestamps[index] as f64;
        let mut end = token_end_sec(
            timestamps,
            durations,
            index,
            segment_start_sec,
            segment_end_sec,
        );
        if end <= start {
            end = (start + 0.05).min(segment_end_sec);
        }

        if is_punctuation_only(&text) {
            if let Some(last) = chunks.last_mut() {
                last.text.push_str(&text);
                last.end = end;
                continue;
            }
        }

        chunks.push(TimedChunk { text, start, end });
    }

    chunks
}

/// 把 VAD 队列里就绪的段全部取出，转成 (start_sample, samples) 存入 segments。
fn drain_vad_segments(vad: &VoiceActivityDetector, segments: &mut Vec<(usize, Vec<f32>)>) {
    while !vad.is_empty() {
        if let Some(seg) = vad.front() {
            let start = seg.start() as usize;
            let seg_samples = seg.samples().to_vec();
            segments.push((start, seg_samples));
            vad.pop();
        }
    }
}

fn prepare_wav_input(input: &Path) -> Result<PathBuf, String> {
    let ext = input
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    if ext == "wav" {
        return Ok(input.to_path_buf());
    }

    let output = env::temp_dir().join(format!(
        "flycut-funasr-{}-{}.wav",
        process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    let ffmpeg = std::env::var_os("FFMPEG_PATH").unwrap_or_else(|| std::ffi::OsString::from("ffmpeg"));

    let status = Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-f")
        .arg("wav")
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("调用 ffmpeg 失败：{e}。请先安装 ffmpeg，或上传 16k 单声道 WAV 文件。"))?;

    if !status.success() {
        return Err(format!(
            "ffmpeg 提取音频失败：{}。请确认媒体文件包含音频轨道。",
            input.display()
        ));
    }

    Ok(output)
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut input = None;
    let mut model = None;
    let mut model_type = String::new();
    let mut recognizer_config_raw = String::new();
    let mut vad_type = VadBackend::Fsmn;
    let mut vad_dir = None;
    let mut vad_model = None;
    let mut language = "zh".to_string();
    let mut timestamp_mode = TimestampMode::Auto;
    let mut output_json = false;
    let mut vad_dump_json = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--input" => input = Some(read_value("--input", &mut args)?),
            "--model" => model = Some(read_value("--model", &mut args)?),
            "--model-type" => model_type = read_value("--model-type", &mut args)?,
            "--recognizer-config" => {
                recognizer_config_raw = read_value("--recognizer-config", &mut args)?
            }
            "--vad-type" => {
                vad_type = VadBackend::parse(&read_value("--vad-type", &mut args)?)?
            }
            "--vad-dir" => vad_dir = Some(PathBuf::from(read_value("--vad-dir", &mut args)?)),
            "--vad-model" => vad_model = Some(PathBuf::from(read_value("--vad-model", &mut args)?)),
            "--language" => language = read_value("--language", &mut args)?,
            "--timestamp-mode" => {
                timestamp_mode = parse_timestamp_mode(&read_value("--timestamp-mode", &mut args)?)?
            }
            "--output-json" => output_json = true,
            "--vad-dump-json" => vad_dump_json = true,
            "--help" | "-h" => return Err(usage()),
            unknown => return Err(format!("未知参数：{unknown}\n{}", usage())),
        }
    }

    let input = input
        .map(PathBuf::from)
        .ok_or_else(|| format!("缺少 --input\n{}", usage()))?;
    let model = model.map(PathBuf::from).unwrap_or_default();

    if !vad_dump_json && model.as_os_str().is_empty() {
        return Err(format!("缺少 --model\n{}", usage()));
    }

    if !vad_dump_json && model_type.is_empty() {
        return Err(format!("缺少 --model-type\n{}", usage()));
    }

    let recognizer_config = if recognizer_config_raw.is_empty() {
        None
    } else {
        Some(serde_json::from_str::<RecognizerConfig>(&recognizer_config_raw).map_err(|e| {
            format!(
                "解析 --recognizer-config JSON 失败：{e}\n原始字符串：{recognizer_config_raw}"
            )
        })?)
    };

    Ok(Args {
        input,
        model,
        model_type,
        recognizer_config,
        recognizer_config_raw,
        vad_type,
        vad_dir,
        vad_model,
        language,
        timestamp_mode,
        output_json,
        vad_dump_json,
    })
}

fn parse_timestamp_mode(raw: &str) -> Result<TimestampMode, String> {
    match raw {
        "auto" => Ok(TimestampMode::Auto),
        "token" => Ok(TimestampMode::Token),
        "segment" => Ok(TimestampMode::Segment),
        other => Err(format!(
            "不支持的 --timestamp-mode：{other}（可选：auto、token、segment）"
        )),
    }
}

fn read_value(name: &str, args: &mut impl Iterator<Item = String>) -> Result<String, String> {
    args.next()
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("{name} 缺少参数值"))
}

fn validate_args(args: &Args) -> Result<(), String> {
    if !args.input.is_file() {
        return Err(format!("输入文件不存在或不是文件：{}", args.input.display()));
    }

    match args.vad_type {
        VadBackend::None => {}
        VadBackend::Fsmn => {
            let vad_dir = args
                .vad_dir
                .as_ref()
                .ok_or_else(|| "FSMN VAD 需要 --vad-dir 参数".to_string())?;
            fsmn_vad::validate_fsmn_model_dir(vad_dir)?;
        }
        VadBackend::Silero => {
            let vad = args
                .vad_model
                .as_ref()
                .ok_or_else(|| "Silero VAD 需要 --vad-model 参数".to_string())?;
            if !vad.is_file() {
                return Err(format!("VAD 模型文件不存在：{}", vad.display()));
            }
        }
    }

    if args.vad_dump_json {
        return Ok(());
    }

    if !args.model.is_dir() {
        return Err(format!("模型目录不存在或不是目录：{}", args.model.display()));
    }

    // 校验 recognizer_config 中声明的所有路径在 model_dir 下都存在
    if let Some(config) = &args.recognizer_config {
        if config.model_type != args.model_type {
            return Err(format!(
                "model_type 不匹配：--model-type 是 {}，但 recognizer_config.model_type 是 {}",
                args.model_type, config.model_type
            ));
        }

        let check = |rel: &Option<String>, name: &str| -> Result<(), String> {
            if let Some(p) = rel {
                let full = args.model.join(p);
                if !full.is_file() {
                    return Err(format!("模型目录缺少 {name}：{}", full.display()));
                }
            }
            Ok(())
        };

        let tokens_path = args.model.join(&config.tokens);
        if !tokens_path.is_file() {
            return Err(format!(
                "模型目录缺少 tokens 文件：{}",
                tokens_path.display()
            ));
        }

        check(&config.sense_voice_model, "sense_voice_model")?;
        check(&config.paraformer_model, "paraformer_model")?;
        check(&config.whisper_encoder, "whisper_encoder")?;
        check(&config.whisper_decoder, "whisper_decoder")?;
        check(&config.moonshine_preprocessor, "moonshine_preprocessor")?;
        check(&config.moonshine_encoder, "moonshine_encoder")?;
        check(&config.moonshine_uncached_decoder, "moonshine_uncached_decoder")?;
        check(&config.moonshine_cached_decoder, "moonshine_cached_decoder")?;
        check(&config.telespeech_ctc_model, "telespeech_ctc_model")?;
        check(&config.zipformer_ctc_model, "zipformer_ctc_model")?;
        check(&config.encoder, "encoder")?;
        check(&config.decoder, "decoder")?;
        check(&config.joiner, "joiner")?;
        check(&config.fire_red_asr_encoder, "fire_red_asr_encoder")?;
        check(&config.fire_red_asr_decoder, "fire_red_asr_decoder")?;
    }

    Ok(())
}

fn escape_json_string(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            ch if ch.is_control() => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}

fn usage() -> String {
    "用法：funasr-asr --input <media-file> [--vad-dump-json | (--model <model-dir> --model-type <family> --recognizer-config <json> --output-json)] [--vad-type none|fsmn|silero] [--vad-dir <fsmn-dir>] [--vad-model <silero-onnx>] [--language zh] [--timestamp-mode auto|token|segment]".to_string()
}

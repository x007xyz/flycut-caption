mod config;
mod e2e_vad;
mod frontend;
mod onnx;

use config::load_config;
use e2e_vad::E2EVadModel;
use frontend::WavFrontend;
use onnx::FsmnOnnxModel;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadBackend {
    None,
    Fsmn,
    Silero,
}

impl VadBackend {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "none" | "off" => Ok(Self::None),
            "fsmn" | "funasr-fsmn" | "funasr" => Ok(Self::Fsmn),
            "silero" => Ok(Self::Silero),
            other => Err(format!(
                "不支持的 --vad-type：{other}（可选：none、fsmn、silero）"
            )),
        }
    }
}

pub fn validate_fsmn_model_dir(model_dir: &Path) -> Result<(), String> {
    if !model_dir.is_dir() {
        return Err(format!("FSMN VAD 目录不存在：{}", model_dir.display()));
    }

    let has_model = model_dir.join("model_quant.onnx").is_file()
        || model_dir.join("model.onnx").is_file();
    if !has_model {
        return Err(format!(
            "FSMN VAD 目录缺少 model_quant.onnx / model.onnx：{}",
            model_dir.display()
        ));
    }

    let has_cmvn = model_dir.join("am.mvn").is_file() || model_dir.join("vad.mvn").is_file();
    if !has_cmvn {
        return Err(format!(
            "FSMN VAD 目录缺少 am.mvn / vad.mvn：{}",
            model_dir.display()
        ));
    }

    let has_config = model_dir.join("config.yaml").is_file() || model_dir.join("vad.yaml").is_file();
    if !has_config {
        return Err(format!(
            "FSMN VAD 目录缺少 config.yaml / vad.yaml：{}",
            model_dir.display()
        ));
    }

    Ok(())
}

pub fn segment_with_fsmn_vad(
    _wav_path: &Path,
    model_dir: &Path,
    samples: &[f32],
    sample_rate: i32,
) -> Result<Vec<(usize, Vec<f32>)>, String> {
    validate_fsmn_model_dir(model_dir)?;
    if sample_rate != 16000 {
        return Err(format!(
            "FSMN VAD 仅支持 16kHz 音频，当前 sample_rate={sample_rate}"
        ));
    }
    if samples.is_empty() {
        return Err("FSMN VAD 输入音频为空".to_string());
    }

    let cfg = load_config(model_dir)?;
    let mut frontend = WavFrontend::new(cfg.frontend.clone(), cfg.cmvn.clone())?;
    let feats = frontend.extract(samples)?;
    if feats.is_empty() {
        return Err("FSMN VAD 特征提取结果为空".to_string());
    }

    let onnx = FsmnOnnxModel::load(&cfg.model_path, &cfg.encoder)?;
    let mut caches = onnx.initial_caches();
    let mut vad = E2EVadModel::new(cfg.vad_post.clone());
    let max_end_sil = cfg.vad_post.max_end_silence_time;

    let feats_len = feats.len();
    let step = feats_len.min(6000);
    let mut all_segments: Vec<[i32; 2]> = Vec::new();
    let mut offset = 0usize;

    while offset < feats_len {
        let chunk_end = (offset + step).min(feats_len);
        let is_final = chunk_end >= feats_len;
        let chunk_feats = &feats[offset..chunk_end];

        let wave_start = offset * 160;
        let wave_end = if is_final {
            samples.len()
        } else {
            ((chunk_end.saturating_sub(1)) * 160 + 400).min(samples.len())
        };
        let waveform = &samples[wave_start..wave_end];

        let (scores, out_caches) = onnx.infer(chunk_feats, &caches)?;
        caches = out_caches;
        let mut segs = vad.process_chunk(scores, waveform, is_final, max_end_sil);
        all_segments.append(&mut segs);
        offset = chunk_end;
    }

    let total_samples = samples.len();
    let mut segments = Vec::new();
    for [start_ms, end_ms] in all_segments {
        if end_ms <= start_ms {
            continue;
        }
        let start_sample = ((start_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;
        let end_sample = ((end_ms as f64 / 1000.0) * sample_rate as f64).round() as usize;
        let start_sample = start_sample.min(total_samples);
        let end_sample = end_sample.min(total_samples);
        if end_sample <= start_sample {
            continue;
        }
        segments.push((start_sample, samples[start_sample..end_sample].to_vec()));
    }

    if segments.is_empty() {
        return Err("FunASR FSMN VAD 未检测到语音段".to_string());
    }

    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
    }

    fn fsmn_model_dir() -> PathBuf {
        project_root().join("shared_assets").join("funasr-fsmn-vad")
    }

    fn demo_wav_samples() -> Option<(Vec<f32>, i32)> {
        let demo_mp4 = project_root().join("..").join("src").join("assets").join("demo.mp4");
        if !demo_mp4.is_file() {
            return None;
        }

        let wav_path = std::env::temp_dir().join("flycut-fsmn-vad-test.wav");
        let ffmpeg = std::env::var_os("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into());
        let status = std::process::Command::new(ffmpeg)
            .arg("-y")
            .arg("-i")
            .arg(&demo_mp4)
            .arg("-vn")
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg("-f")
            .arg("wav")
            .arg(&wav_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()?;
        if !status.success() {
            return None;
        }

        let wav_path_str = wav_path.to_str()?;
        let wave = sherpa_onnx::Wave::read(wav_path_str)?;
        Some((wave.samples().to_vec(), wave.sample_rate()))
    }

    #[test]
    fn loads_fsmn_config_from_shared_assets() {
        let model_dir = fsmn_model_dir();
        if !model_dir.is_dir() {
            eprintln!("skip: FSMN VAD assets missing at {}", model_dir.display());
            return;
        }

        let cfg = load_config(&model_dir).expect("load_config");
        assert!(cfg.model_path.is_file(), "onnx model missing");
        assert_eq!(cfg.frontend.fs, 16000);
        assert_eq!(cfg.frontend.lfr_m, 5);
        assert_eq!(cfg.cmvn.means.len(), 400);
    }

    #[test]
    fn fsmn_vad_segments_demo_audio() {
        let model_dir = fsmn_model_dir();
        if !model_dir.is_dir() {
            eprintln!("skip: FSMN VAD assets missing");
            return;
        }

        let Some((samples, sample_rate)) = demo_wav_samples() else {
            eprintln!("skip: demo.mp4/ffmpeg unavailable");
            return;
        };

        let wav_path = std::env::temp_dir().join("flycut-fsmn-vad-test.wav");
        let segments =
            segment_with_fsmn_vad(&wav_path, &model_dir, &samples, sample_rate).expect("segments");

        assert!(segments.len() >= 5, "expected multiple speech segments");
        assert!(segments.len() <= 80, "too many segments: {}", segments.len());

        let total_ms = (samples.len() as f64 / sample_rate as f64 * 1000.0) as i32;
        for (start_sample, seg_samples) in &segments {
            assert!(!seg_samples.is_empty());
            let start_ms = (*start_sample as f64 / sample_rate as f64 * 1000.0) as i32;
            let end_ms = ((*start_sample + seg_samples.len()) as f64 / sample_rate as f64
                * 1000.0) as i32;
            assert!(start_ms >= 0);
            assert!(end_ms > start_ms);
            assert!(end_ms <= total_ms + 500);
        }

        eprintln!(
            "FSMN VAD demo: {} segments, duration={:.1}s",
            segments.len(),
            samples.len() as f64 / sample_rate as f64
        );
    }
}

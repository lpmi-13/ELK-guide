#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp", "faster-whisper"]
# ///
"""Download video, audio, and transcripts from one or more YouTube URLs.

Usage:
    # Video (no audio), audio, YouTube transcript, and a fresh Whisper
    # transcript of the audio — the default, for as many URLs as you like:
    uv run scripts/download-video.py <url> [<url> ...]

    # YouTube caption transcript only (no media, no Whisper):
    uv run scripts/download-video.py --no-video --no-audio <url> [<url> ...]

    # Just the audio + a Whisper transcript (skip YouTube's captions):
    uv run scripts/download-video.py --no-video --no-transcript <url>

    # Bigger, more accurate Whisper model (slower):
    uv run scripts/download-video.py --whisper-model large-v3 <url>

    # Custom output dir and caption language(s):
    uv run scripts/download-video.py -o recordings/videos --lang en,en-US <url>

Video is fetched as the best video-only format, so the video file has no audio
track; the audio is saved as a separate file (default .m4a, copied without
re-encoding when the source is already m4a — pass `--audio-format best` to keep
whatever container YouTube serves). YouTube transcripts are downloaded as .vtt
(manual captions preferred, auto-generated as fallback) and also cleaned into a
plain-text .txt next to each .vtt. The downloaded audio is then transcribed
locally with faster-whisper into `<name>.whisper.txt` (plain text) and
`<name>.whisper.srt` (timestamped) — handy when YouTube's captions are garbage.
Requires ffmpeg on PATH (already present here) for the mp4 remux and audio extract.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from yt_dlp import YoutubeDL


def base_opts(out_dir: str) -> dict:
    return {
        "outtmpl": f"{out_dir}/%(title)s [%(id)s].%(ext)s",
        "noplaylist": True,
        "ignoreerrors": True,  # keep going if one URL in a batch fails
    }


def video_opts(out_dir: str, fmt: str) -> dict:
    opts = base_opts(out_dir)
    opts["format"] = fmt  # best video-only -> no audio track
    opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]
    return opts


def audio_opts(out_dir: str, audio_format: str) -> dict:
    opts = base_opts(out_dir)
    opts["format"] = "bestaudio/best"
    # "best" keeps the source codec/container (no re-encode); a concrete codec
    # like m4a/mp3/wav copies when it matches the source and re-encodes otherwise.
    opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": audio_format}]
    return opts


def add_transcript_opts(opts: dict, langs: list[str]) -> dict:
    opts["writesubtitles"] = True       # human-authored captions if available
    opts["writeautomaticsub"] = True    # fall back to auto-generated
    opts["subtitleslangs"] = langs
    opts["subtitlesformat"] = "vtt"
    return opts


# Matches "00:00:01.234" or "00:01.234" cue timings and inline <...> timing tags.
_CUE_LINE = re.compile(r"^\d{2}:\d{2}(:\d{2})?[.,]\d{3}\s*-->")
_INLINE_TAG = re.compile(r"<[^>]+>")


def clean_vtt(vtt_path: Path) -> str:
    """Turn a .vtt caption file into readable plain text.

    Strips the WEBVTT header, cue timing lines, styling/positioning cues, and
    inline timing tags, then drops consecutive duplicate lines (YouTube's
    auto-captions repeat each line as they scroll)."""
    lines: list[str] = []
    for raw in vtt_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line == "WEBVTT":
            continue
        if line.startswith(("Kind:", "Language:", "NOTE", "STYLE")):
            continue
        if _CUE_LINE.search(line) or line.isdigit():
            continue
        text = _INLINE_TAG.sub("", line).strip()
        if text and (not lines or lines[-1] != text):
            lines.append(text)
    return "\n".join(lines) + "\n" if lines else ""


def convert_transcripts(out_dir: Path) -> None:
    for vtt in sorted(out_dir.glob("*.vtt")):
        text = clean_vtt(vtt)
        if text:
            vtt.with_suffix(".txt").write_text(text, encoding="utf-8")
            print(f"[transcript] wrote {vtt.with_suffix('.txt').name}")


# Audio containers we might have downloaded (never .mp4 — that's the video-only file).
_AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".flac", ".opus", ".ogg", ".aac", ".webm"}


def _srt_timestamp(seconds: float) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1_000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _to_srt(segments: list) -> str:
    blocks = [
        f"{i}\n{_srt_timestamp(seg.start)} --> {_srt_timestamp(seg.end)}\n{seg.text.strip()}\n"
        for i, seg in enumerate(segments, 1)
        if seg.text.strip()
    ]
    return "\n".join(blocks)


def whisper_transcribe(
    out_dir: Path, model_size: str, device: str, compute_type: str,
    lang: str | None, overwrite: bool = False,
) -> None:
    """Transcribe every downloaded audio file with faster-whisper.

    Writes `<name>.whisper.txt` (plain text) and `<name>.whisper.srt`
    (timestamped) next to each audio file, skipping files that already have a
    Whisper transcript unless `overwrite` is set."""

    def out_path(audio: Path, ext: str) -> Path:
        return audio.with_name(f"{audio.stem}.whisper.{ext}")

    audio_files = sorted(
        p for p in out_dir.iterdir()
        if p.is_file() and p.suffix.lower() in _AUDIO_EXTS
    )
    pending = [a for a in audio_files if overwrite or not out_path(a, "txt").exists()]
    if not pending:
        return

    # Imported lazily so non-Whisper runs don't pay the (heavy) import cost.
    from faster_whisper import WhisperModel

    print(f"[whisper] loading model '{model_size}' (device={device}, compute={compute_type})")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    for audio in pending:
        print(f"[whisper] transcribing {audio.name} ...")
        segments, info = model.transcribe(str(audio), language=lang, vad_filter=True)
        segments = list(segments)  # generator -> run the transcription
        text = "\n".join(seg.text.strip() for seg in segments if seg.text.strip())
        out_path(audio, "txt").write_text(text + "\n" if text else "", encoding="utf-8")
        out_path(audio, "srt").write_text(_to_srt(segments), encoding="utf-8")
        print(
            f"[whisper] wrote {out_path(audio, 'txt').name} "
            f"({info.language}, {len(segments)} segments)"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("urls", nargs="+", help="One or more YouTube URLs")
    parser.add_argument("-o", "--out-dir", default="video-downloads", help="Output directory")
    parser.add_argument(
        "-f", "--format", default="bestvideo",
        help="yt-dlp format selector for video (default: bestvideo = best video-only, no audio)",
    )
    parser.add_argument(
        "--audio-format", default="m4a",
        help="Audio codec/container to save (default: m4a; use 'best' to keep the source without re-encoding)",
    )
    parser.add_argument("--no-video", action="store_true", help="Skip the video download")
    parser.add_argument("--no-audio", action="store_true", help="Skip the audio download")
    parser.add_argument("--no-transcript", action="store_true", help="Skip YouTube caption download")
    parser.add_argument(
        "--no-whisper", action="store_true",
        help="Skip local Whisper transcription of the downloaded audio",
    )
    parser.add_argument(
        "--whisper-model", default="small",
        help="faster-whisper model size (tiny/base/small/medium/large-v3, default: small)",
    )
    parser.add_argument(
        "--whisper-device", default="auto",
        help="Device for Whisper (auto/cpu/cuda, default: auto)",
    )
    parser.add_argument(
        "--whisper-compute-type", default="int8",
        help="CTranslate2 compute type, e.g. int8/int8_float16/float16/float32 (default: int8)",
    )
    parser.add_argument(
        "--whisper-overwrite", action="store_true",
        help="Re-transcribe audio even if a .whisper.txt already exists",
    )
    parser.add_argument(
        "--lang", default="en",
        help="Comma-separated caption languages to try; the first also hints Whisper (default: en)",
    )
    args = parser.parse_args()

    want_video = not args.no_video
    want_audio = not args.no_audio
    want_transcript = not args.no_transcript
    if not (want_video or want_audio or want_transcript):
        parser.error("nothing to do: --no-video, --no-audio and --no-transcript can't all be set")

    langs = [s.strip() for s in args.lang.split(",") if s.strip()]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Video and audio need distinct format selectors and postprocessors, so each
    # runs as its own yt-dlp pass. Transcripts ride along with the first media
    # pass (or get a standalone pass when only transcripts are wanted).
    jobs: list[dict] = []
    if want_video:
        jobs.append(video_opts(str(out_dir), args.format))
    if want_audio:
        jobs.append(audio_opts(str(out_dir), args.audio_format))
    if want_transcript:
        if jobs:
            add_transcript_opts(jobs[0], langs)
        else:
            jobs.append(add_transcript_opts({**base_opts(str(out_dir)), "skip_download": True}, langs))

    ret = 0
    for opts in jobs:
        with YoutubeDL(opts) as ydl:
            ret = ydl.download(args.urls) or ret

    if want_transcript:
        convert_transcripts(out_dir)

    # Whisper transcribes the audio we just downloaded, so it needs the audio pass.
    if want_audio and not args.no_whisper:
        whisper_lang = langs[0].split("-")[0] if langs else None  # "en-US" -> "en"; None autodetects
        whisper_transcribe(
            out_dir, args.whisper_model, args.whisper_device,
            args.whisper_compute_type, whisper_lang, overwrite=args.whisper_overwrite,
        )
    return ret


if __name__ == "__main__":
    sys.exit(main())

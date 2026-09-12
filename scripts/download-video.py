#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["yt-dlp"]
# ///
"""Download video-only streams and/or transcripts from one or more YouTube URLs.

Usage:
    # Both video (no audio) and transcript, for as many URLs as you like:
    uv run scripts/download-video.py <url> [<url> ...]

    # Transcript only (no video download):
    uv run scripts/download-video.py --no-video <url> [<url> ...]

    # Video only:
    uv run scripts/download-video.py --no-transcript <url> [<url> ...]

    # Custom output dir and caption language(s):
    uv run scripts/download-video.py -o recordings/videos --lang en,en-US <url>

Video is fetched as the best video-only format, so the file has no audio track.
Transcripts are downloaded as .vtt (manual captions preferred, auto-generated as
fallback) and also cleaned into a plain-text .txt next to each .vtt.
Requires ffmpeg on PATH (already present here) for the mp4 remux.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from yt_dlp import YoutubeDL


def build_opts(out_dir: str, fmt: str, want_video: bool, want_transcript: bool, langs: list[str]) -> dict:
    opts: dict = {
        "outtmpl": f"{out_dir}/%(title)s [%(id)s].%(ext)s",
        "noplaylist": True,
        "ignoreerrors": True,  # keep going if one URL in a batch fails
    }
    if want_video:
        opts["format"] = fmt  # best video-only -> no audio track
        opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]
    else:
        opts["skip_download"] = True
    if want_transcript:
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
    parser.add_argument("--no-video", action="store_true", help="Skip the video download")
    parser.add_argument("--no-transcript", action="store_true", help="Skip transcript download")
    parser.add_argument(
        "--lang", default="en",
        help="Comma-separated caption languages to try (default: en)",
    )
    args = parser.parse_args()

    want_video = not args.no_video
    want_transcript = not args.no_transcript
    if not want_video and not want_transcript:
        parser.error("nothing to do: --no-video and --no-transcript can't both be set")

    langs = [s.strip() for s in args.lang.split(",") if s.strip()]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    opts = build_opts(str(out_dir), args.format, want_video, want_transcript, langs)
    with YoutubeDL(opts) as ydl:
        ret = ydl.download(args.urls)

    if want_transcript:
        convert_transcripts(out_dir)
    return ret


if __name__ == "__main__":
    sys.exit(main())

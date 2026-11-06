/**
 * Caption sidecar files (#144): SubRip (`.srt`) and WebVTT (`.vtt`) from the
 * render plan's caption cues, in plan order.
 *
 * A cue frame is written at `round(frame * 1000 / fps)` milliseconds, as
 * `HH:MM:SS,mmm` in SRT and `HH:MM:SS.mmm` in WebVTT (hours grow past two
 * digits if they must). Lines end with `\n`. Cue text keeps its line breaks,
 * with `\r\n` and `\r` read as `\n` and blank lines dropped, since a blank
 * line ends a cue in both formats. WebVTT text escapes `&`, `<` and `>`,
 * which also keeps a `-->` in the text from reading as a timing line; SRT has
 * no escapes, so any run of dashes before `>` in SRT text is written as `->`.
 * With no cues, the SRT file is empty and the WebVTT file is just its header,
 * both valid.
 */
import type { CaptionCue } from "./plan";

export function toSrt(cues: readonly CaptionCue[], fps: number): string {
  return cues
    .map((cue, i) => {
      const text = cueLines(cue.text).map((line) => line.replace(/--+>/g, "->"));
      return [String(i + 1), `${timestamp(cue.startFrame, fps, ",")} --> ${timestamp(cue.endFrame, fps, ",")}`, ...text].join("\n") + "\n\n";
    })
    .join("");
}

export function toVtt(cues: readonly CaptionCue[], fps: number): string {
  const blocks = cues.map((cue) => {
    const text = cueLines(cue.text).map(escapeVtt);
    return "\n" + [`${timestamp(cue.startFrame, fps, ".")} --> ${timestamp(cue.endFrame, fps, ".")}`, ...text].join("\n") + "\n";
  });
  return "WEBVTT\n" + blocks.join("");
}

function cueLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function escapeVtt(line: string): string {
  return line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function timestamp(frame: number, fps: number, separator: "," | "."): string {
  const totalMs = Math.round((frame * 1000) / fps);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const seconds = totalSeconds % 60;
  const minutes = ((totalSeconds - seconds) / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(seconds)}${separator}${String(ms).padStart(3, "0")}`;
}

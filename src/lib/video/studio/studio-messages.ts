/**
 * What the Studio page says when the API refuses pairing, an import or a
 * new production (#150), in plain words, chosen by the server's stable error
 * code, never by its message. A code the page does not know falls back to
 * the server's own message, which never carries paths or secrets.
 */
import type { StudioApiError } from "./api";

type ApiErrorLike = Pick<StudioApiError, "code" | "message" | "details">;

const ADDRESS = "Open the Studio from the CreatorBrio app's own address (the one npm run dev or npm start prints) and try again.";
const UNREACHABLE = "CreatorBrio did not answer. Check that it is still running, then try again.";

/** How long to wait after too many pairing attempts, from the `Retry-After` the API sent, if the page has it. */
export function waitPhrase(details: Record<string, unknown>): string {
  const raw = details.retryAfterSeconds;
  const seconds = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : raw;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "a minute";
  const whole = Math.ceil(seconds);
  if (whole < 60) return whole === 1 ? "1 second" : `${whole} seconds`;
  const minutes = Math.ceil(whole / 60);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

export function pairingErrorMessage(error: ApiErrorLike): string {
  switch (error.code) {
    case "invalid_pairing_code":
      return "That code did not work. It may be mistyped, already used, or older than five minutes. Run npm run studio:pair again and enter the new code.";
    case "rate_limited":
      return `Too many codes were tried. Wait ${waitPhrase(error.details)}, then run npm run studio:pair again for a new code.`;
    case "request_refused":
    case "session_request_refused":
      return `This browser could not be paired from this address. ${ADDRESS}`;
    case "network_error":
      return UNREACHABLE;
    default:
      return `The browser was not paired: ${error.message}`;
  }
}

export function importErrorMessage(error: ApiErrorLike): string {
  switch (error.code) {
    case "invalid_path":
      return "Give the full path of the file, starting with / (for example /Users/you/Movies/clip.mov).";
    case "not_found":
      return "No file exists at that path. Check the spelling and try again.";
    case "not_a_file":
      return "That path is a folder, a link or a device. Give the path of the file itself.";
    case "inside_data_directory":
      return "That file is inside CreatorBrio's own data folder. Choose the original file instead.";
    case "too_large":
      return "That file is larger than CreatorBrio can import (32 GiB).";
    case "unsupported_media":
      return "That file is not a video, sound or still image CreatorBrio can read.";
    case "tool_missing":
      return "FFmpeg is not installed, so media cannot be imported. Install FFmpeg and restart CreatorBrio.";
    case "network_error":
      return UNREACHABLE;
    default:
      return `The file was not imported: ${error.message}`;
  }
}

export function retryErrorMessage(error: ApiErrorLike): string {
  switch (error.code) {
    case "job_not_failed":
      return "The preview is already being made again.";
    case "media_not_found":
      return "This media is no longer in the library.";
    case "network_error":
      return UNREACHABLE;
    default:
      return `The preview was not retried: ${error.message}`;
  }
}

export function createErrorMessage(error: ApiErrorLike): string {
  switch (error.code) {
    case "already_exists":
      return "A production with this id already exists. Try again.";
    case "network_error":
      return UNREACHABLE;
    default: {
      const issues = error.details.issues;
      const first = Array.isArray(issues) ? (issues[0] as { message?: unknown } | undefined) : undefined;
      return `The production was not created: ${typeof first?.message === "string" ? first.message : error.message}`;
    }
  }
}

/** Any other failure to read from the API (a list, a session check). */
export function readErrorMessage(error: ApiErrorLike, what: string): string {
  return error.code === "network_error" ? UNREACHABLE : `${what} could not be read: ${error.message}`;
}

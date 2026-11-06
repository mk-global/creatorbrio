/**
 * The pairing code as a person types it (#150). `npm run studio:pair` prints
 * 20 characters in four groups of five; people type them with or without the
 * dashes, with spaces, in either case. The page keeps only letters and
 * digits, upper-cases them, shows them grouped as typed and sends the
 * grouped form; the server's `normaliseCode()` is the judge of what is a
 * valid code (it also reads O as 0 and I or L as 1), so the page does not
 * refuse letters the server would accept.
 */

/** Characters in a pairing code, without its separators. */
export const PAIRING_CODE_LENGTH = 20;
const GROUP = 5;

export interface PairingInput {
  /** Up to 20 upper-case letters and digits, separators removed. */
  code: string;
  /** The code as four dash-separated groups of five, as far as typed. */
  display: string;
  /** All 20 characters are there, so it can be sent. */
  complete: boolean;
}

/** Reads what the person typed or pasted into the pairing field. */
export function readPairingInput(raw: string): PairingInput {
  const code = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .slice(0, PAIRING_CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) groups.push(code.slice(i, i + GROUP));
  return { code, display: groups.join("-"), complete: code.length === PAIRING_CODE_LENGTH };
}

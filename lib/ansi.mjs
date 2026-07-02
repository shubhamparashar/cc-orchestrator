// Strip ANSI / VT control sequences to plain readable text for the stripped-text
// live view. This is intentionally lossy: an interactive TUI repaints the screen
// with cursor-addressing escapes, and flattening them to text loses the layout. A
// faithful terminal renderer is a later phase; here the goal is a usable feed.

/* eslint-disable no-control-regex */
// OSC sequences (e.g. window-title sets): ESC ] … BEL, or ESC ] … ESC \. Stripped
// first so their payload isn't mistaken for text.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI and other escape sequences: ESC (or the 8-bit CSI \x9b) + params + a final
// byte. Covers SGR colour, cursor moves, erase, and private modes (?25h …).
const CSI_RE = /[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
// Remaining non-printing control bytes, preserving \t (\x09) and \n (\x0a).
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

export function stripAnsi(input) {
    let s = String(input);
    s = s.replace(OSC_RE, '');
    s = s.replace(CSI_RE, '');
    // A bare CR returns the cursor to column 0 to overwrite the line; with no
    // renderer, fold CRLF to one newline and drop lone CRs.
    s = s.replace(/\r\n/g, '\n').replace(/\r/g, '');
    s = s.replace(CTRL_RE, '');
    return s;
}

/* eslint-disable no-control-regex */
// A chunk-final escape-sequence prefix still awaiting its terminator: an OSC
// needs its BEL/ST, and a CSI-style sequence needs a non-digit final byte —
// digits are parameter bytes, so a trailing "\x1b[38;5;1" is incomplete even
// though CSI_RE (which allows a digit final for forms like "\x1b[3~"'s params)
// would swallow it at a chunk boundary and leak the sequence's remainder as text.
const PARTIAL_TAIL_RE = /[\x1b\x9b](?:\][^\x07\x1b]*\x1b?|[[\]()#;?]*[\d;]*)?$/;
/* eslint-enable no-control-regex */

// An unterminated sequence is held back at most this long before being flushed
// through the stripper, so a runaway OSC payload can't buffer without bound.
const MAX_CARRY_CHARS = 4096;

// Chunk-boundary-safe stripping. Pipe reads split output at arbitrary byte
// boundaries — frequently mid-escape-sequence — and stripping each chunk
// independently leaks sequence fragments (e.g. "96m") into the text. Hold a
// chunk-final incomplete sequence back and prepend it to the next chunk.
export class AnsiStreamStripper {
    constructor() {
        this.carry = '';
    }

    push(chunk) {
        let s = this.carry + String(chunk);
        this.carry = '';
        const m = s.match(PARTIAL_TAIL_RE);
        if (m && m[0].length <= MAX_CARRY_CHARS) {
            this.carry = m[0];
            s = s.slice(0, s.length - m[0].length);
        }
        return stripAnsi(s);
    }

    // End of stream: strip whatever is still held (a partial sequence strips to
    // nothing; any trailing plain text survives).
    flush() {
        const rest = this.carry;
        this.carry = '';
        return stripAnsi(rest);
    }
}

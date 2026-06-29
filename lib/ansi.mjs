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

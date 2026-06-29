// Bounded ring buffer of recent output text, byte-capped. Backs live-session
// scrollback: a reconnecting viewer replays whatever is still in the window. Kept
// deliberately simple (an array of chunks + a running byte total) so it's cheap to
// append to on every pty write and trivially testable.
export class RingBuffer {
    constructor(maxBytes = 256 * 1024) {
        this.maxBytes = maxBytes;
        this.chunks = [];
        this.bytes = 0;
    }

    push(chunk) {
        let str = String(chunk);
        if (!str) return;
        // A single chunk larger than the whole window can't fit — keep only its
        // tail, so the buffer never exceeds maxBytes even from one giant write.
        if (Buffer.byteLength(str) > this.maxBytes) {
            str = str.slice(-this.maxBytes);
        }
        this.chunks.push(str);
        this.bytes += Buffer.byteLength(str);
        while (this.bytes > this.maxBytes && this.chunks.length > 1) {
            this.bytes -= Buffer.byteLength(this.chunks.shift());
        }
    }

    text() {
        return this.chunks.join('');
    }

    clear() {
        this.chunks = [];
        this.bytes = 0;
    }
}

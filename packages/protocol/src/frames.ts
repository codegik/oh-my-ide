/**
 * Length-prefixed binary framing.
 *
 *   ┌───────────┬────────┬──────────────────────────────┐
 *   │ u32be len │ u8 typ │ payload (len - 1 bytes)      │
 *   └───────────┴────────┴──────────────────────────────┘
 *
 * Control messages are JSON inside a CONTROL frame. PTY bytes travel raw:
 * base64-in-JSON would cost 33% bandwidth plus encode/decode CPU precisely when
 * a session is spewing output, which is the worst possible moment.
 */

export const FRAME_CONTROL = 0x01;
export const FRAME_PTY_OUT = 0x02;
export const FRAME_PTY_IN = 0x03;

/** Refuse absurd frames rather than allocating on a corrupt length. */
export const MAX_FRAME = 64 * 1024 * 1024;

export interface ControlFrame {
  typ: typeof FRAME_CONTROL;
  msg: unknown;
}
export interface PtyOutFrame {
  typ: typeof FRAME_PTY_OUT;
  viewId: string;
  epoch: number;
  offset: bigint;
  bytes: Buffer;
}
export interface PtyInFrame {
  typ: typeof FRAME_PTY_IN;
  viewId: string;
  bytes: Buffer;
}
export type Frame = ControlFrame | PtyOutFrame | PtyInFrame;

function withHeader(typ: number, body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out.writeUInt8(typ, 4);
  body.copy(out, 5);
  return out;
}

export function encodeControl(msg: unknown): Buffer {
  return withHeader(FRAME_CONTROL, Buffer.from(JSON.stringify(msg), 'utf8'));
}

export function encodePtyOut(viewId: string, epoch: number, offset: bigint, bytes: Buffer): Buffer {
  const id = Buffer.from(viewId, 'utf8');
  const body = Buffer.allocUnsafe(2 + id.length + 4 + 8 + bytes.length);
  let p = 0;
  body.writeUInt16BE(id.length, p);
  p += 2;
  id.copy(body, p);
  p += id.length;
  body.writeUInt32BE(epoch, p);
  p += 4;
  body.writeBigUInt64BE(offset, p);
  p += 8;
  bytes.copy(body, p);
  return withHeader(FRAME_PTY_OUT, body);
}

export function encodePtyIn(viewId: string, bytes: Buffer): Buffer {
  const id = Buffer.from(viewId, 'utf8');
  const body = Buffer.allocUnsafe(2 + id.length + bytes.length);
  body.writeUInt16BE(id.length, 0);
  id.copy(body, 2);
  bytes.copy(body, 2 + id.length);
  return withHeader(FRAME_PTY_IN, body);
}

/**
 * Streaming decoder. A socket read boundary lands mid-frame constantly, so the
 * partial-buffer handling here is the most test-worthy code in the repo.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Frame[] = [];

    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME) throw new Error(`invalid frame length: ${len}`);
      if (this.buf.length < 4 + len) break;

      const typ = this.buf.readUInt8(4);
      const body = this.buf.subarray(5, 4 + len);
      const frame = decodeBody(typ, body);
      if (frame) out.push(frame);
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

function decodeBody(typ: number, body: Buffer): Frame | null {
  if (typ === FRAME_CONTROL) {
    try {
      return { typ: FRAME_CONTROL, msg: JSON.parse(body.toString('utf8')) };
    } catch {
      return null; // a malformed control frame is dropped, never fatal
    }
  }
  if (typ === FRAME_PTY_OUT) {
    const idLen = body.readUInt16BE(0);
    const viewId = body.subarray(2, 2 + idLen).toString('utf8');
    let p = 2 + idLen;
    const epoch = body.readUInt32BE(p);
    p += 4;
    const offset = body.readBigUInt64BE(p);
    p += 8;
    return { typ: FRAME_PTY_OUT, viewId, epoch, offset, bytes: Buffer.from(body.subarray(p)) };
  }
  if (typ === FRAME_PTY_IN) {
    const idLen = body.readUInt16BE(0);
    const viewId = body.subarray(2, 2 + idLen).toString('utf8');
    return { typ: FRAME_PTY_IN, viewId, bytes: Buffer.from(body.subarray(2 + idLen)) };
  }
  return null; // unknown frame type: ignore, forward-compatible
}

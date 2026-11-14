import type { Identity } from './response-ledger.js';

type Incoming =
  | { type: 'REQUEST'; id: number; payload: unknown }
  | { type: 'ACK'; id: number; digest: string }
  | { type: 'REQUESTS_END'; id: number }
  | { type: 'PHASE_DONE'; id: number; digest: string };

/** Decode one complete, externally delimited frame. Framing and EOF remain the channel owner's responsibility. */
export function decodeResponseFrame(bytes: Uint8Array, identity: Identity, maxFrameBytes: number): Incoming {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 65536 || bytes.byteLength > maxFrameBytes) {
    throw new Error('frame limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // Compare bytes, not decoded text: TextDecoder otherwise strips a UTF-8 BOM.
    if (!Buffer.from(JSON.stringify(value)).equals(Buffer.from(bytes))) throw new Error('noncanonical frame');
  } catch {
    throw new Error('malformed frame');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed frame');
  const f = value as Record<string, unknown>;
  if (f.version !== identity.version || f.caseId !== identity.caseId || f.phaseId !== identity.phaseId || f.nonce !== identity.nonce ||
      !Number.isSafeInteger(f.id) || (f.id as number) < 0) throw new Error('invalid frame identity');
  const common = ['version', 'caseId', 'phaseId', 'nonce', 'id', 'type'];
  const allowed = f.type === 'REQUEST' ? [...common, 'payload'] :
    f.type === 'ACK' || f.type === 'PHASE_DONE' ? [...common, 'digest'] :
      f.type === 'REQUESTS_END' ? common : [];
  if (!allowed.length || Object.keys(f).some(k => !allowed.includes(k)) ||
      (f.type === 'REQUEST' && (!Object.hasOwn(f, 'payload') || f.id === 0)) ||
      ((f.type === 'ACK' || f.type === 'PHASE_DONE') && (typeof f.digest !== 'string' || !/^[0-9a-f]{64}$/.test(f.digest))) ||
      (f.type === 'ACK' && f.id === 0)) throw new Error('invalid frame fields');
  return f as Incoming;
}

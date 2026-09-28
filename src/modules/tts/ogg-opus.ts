// Raw 16-bit little-endian mono PCM → Ogg/Opus (RFC 7845), the only container WhatsApp renders as a
// voice note (PTT). For providers that emit PCM and no Opus (Gemini). The Opus encoder is libopus
// compiled to WASM (`opusscript`), loaded on first use, so no ffmpeg or native addon enters the image;
// the Ogg framing is written here, since it is a page header, a CRC and a segment table.

const FRAME_MS = 20;
const OPUS_BITRATE = 32_000;
// NOTE: libopus' encoder lookahead at 48 kHz (2.5 ms + 4 ms of delay compensation), the value RFC 7845
// recommends for pre-skip. Measured on this encoder: the decoded signal lags the input by 152 samples
// at 24 kHz, i.e. 304 at 48 kHz, so 312 trims the delay without eating speech.
const PRE_SKIP_48K = 312;
const PACKETS_PER_PAGE = 50;
const OPUS_RATES = [8_000, 12_000, 16_000, 24_000, 48_000] as const;
type OpusRate = (typeof OPUS_RATES)[number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, unreflected, zero initial value, no final xor. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

function oggPage(
  packets: Uint8Array[],
  opts: { granule: number; serial: number; seq: number; flags: number },
): Uint8Array {
  const segments: number[] = [];
  for (const p of packets) {
    for (let left = p.byteLength; ; left -= 255) {
      segments.push(Math.min(left, 255));
      if (left < 255) break;
    }
  }
  const bodyLength = packets.reduce((n, p) => n + p.byteLength, 0);
  const page = new Uint8Array(27 + segments.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  view.setUint8(5, opts.flags);
  // NOTE: the 64-bit granule as two 32-bit halves; a voice note stays far below 2^53 samples.
  view.setUint32(6, opts.granule % 0x100000000, true);
  view.setUint32(10, Math.floor(opts.granule / 0x100000000), true);
  view.setUint32(14, opts.serial, true);
  view.setUint32(18, opts.seq, true);
  view.setUint8(26, segments.length);
  page.set(segments, 27);
  let offset = 27 + segments.length;
  for (const p of packets) {
    page.set(p, offset);
    offset += p.byteLength;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function segmentCount(p: Uint8Array): number {
  return Math.floor(p.byteLength / 255) + 1;
}

function opusHead(inputRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  view.setUint8(8, 1); // version
  view.setUint8(9, 1); // channels
  view.setUint16(10, PRE_SKIP_48K, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true); // output gain
  view.setUint8(18, 0); // channel mapping family: mono/stereo
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("fazer.ai agents");
  const tags = new Uint8Array(8 + 4 + vendor.byteLength + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.byteLength, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.byteLength, 0, true); // no user comments
  return tags;
}

export async function pcmToOggOpus(
  pcm: ArrayBuffer,
  sampleRate: number,
): Promise<ArrayBuffer> {
  if (!OPUS_RATES.includes(sampleRate as OpusRate)) {
    throw new RangeError(`Opus cannot encode ${sampleRate} Hz`);
  }
  const { default: OpusScript } = await import("opusscript");
  const encoder = new OpusScript(
    sampleRate as OpusRate,
    1,
    OpusScript.Application.VOIP,
  );
  try {
    encoder.setBitrate(OPUS_BITRATE);
    const frameSamples = (sampleRate * FRAME_MS) / 1000;
    const toGranule = 48_000 / sampleRate;
    const inputSamples = Math.floor(pcm.byteLength / 2);
    // NOTE: the encoder holds back pre-skip worth of audio, so the input is padded by that much
    // silence (then to a whole frame) or the last syllable never leaves it.
    const padded = inputSamples + Math.ceil(PRE_SKIP_48K / toGranule);
    const frames = Math.max(1, Math.ceil(padded / frameSamples));
    const source = new Uint8Array(pcm, 0, inputSamples * 2);
    const input = new Uint8Array(frames * frameSamples * 2);
    input.set(source);

    const serial = (Math.random() * 0x100000000) >>> 0;
    const pages: Uint8Array[] = [
      oggPage([opusHead(sampleRate)], {
        granule: 0,
        serial,
        seq: 0,
        flags: 0x02,
      }),
      oggPage([opusTags()], { granule: 0, serial, seq: 1, flags: 0 }),
    ];
    const finalGranule = PRE_SKIP_48K + inputSamples * toGranule;
    let pending: Uint8Array[] = [];
    let pendingSegments = 0;
    const flush = (granule: number, last: boolean) => {
      pages.push(
        oggPage(pending, {
          granule: last ? finalGranule : granule,
          serial,
          seq: pages.length,
          flags: last ? 0x04 : 0,
        }),
      );
      pending = [];
      pendingSegments = 0;
    };
    for (let f = 0; f < frames; f++) {
      const bytes = frameSamples * 2;
      const frame = Buffer.from(input.buffer, f * bytes, bytes);
      const packet = new Uint8Array(encoder.encode(frame, frameSamples));
      if (pendingSegments + segmentCount(packet) > 255)
        flush(f * frameSamples * toGranule, false);
      pending.push(packet);
      pendingSegments += segmentCount(packet);
      const isLast = f === frames - 1;
      if (isLast || pending.length >= PACKETS_PER_PAGE)
        flush((f + 1) * frameSamples * toGranule, isLast);
    }

    const out = new Uint8Array(pages.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const p of pages) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out.buffer;
  } finally {
    encoder.delete();
  }
}

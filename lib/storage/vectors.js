// Embedding vector encoding/validation shared by the storage backends.
//
// Vectors are stored as little-endian Float64 (JS numbers are doubles, so a
// round-trip is exact and migration can verify equality). We never truncate or
// reinterpret a vector: a malformed vector is rejected loudly rather than
// silently dropped or down-cast.

function assertVector(vec, label = "embedding") {
  if (vec == null) return null;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`${label} must be a non-empty array of finite numbers`);
  }
  for (const x of vec) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error(`${label} contains a non-finite value`);
    }
  }
  return vec;
}

function encodeVector(vec) {
  if (vec == null) return null;
  assertVector(vec);
  const f64 = Float64Array.from(vec);
  return Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength);
}

function decodeVector(buf, expectedDim = null) {
  if (buf == null) return null;
  if (buf.byteLength % 8 !== 0) {
    throw new Error(`corrupt embedding blob: ${buf.byteLength} bytes is not a multiple of 8`);
  }
  // Copy into a fresh, zero-offset ArrayBuffer so alignment is guaranteed
  // regardless of how the driver hands us the buffer.
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const out = Array.from(new Float64Array(copy));
  if (expectedDim != null && out.length !== expectedDim) {
    throw new Error(
      `embedding dimension mismatch: decoded ${out.length} but column says ${expectedDim}`
    );
  }
  return out;
}

function vectorsEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = { assertVector, encodeVector, decodeVector, vectorsEqual };

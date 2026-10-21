// Pure vector-space helpers. No model loading, no storage — this keeps the
// "may I reuse / may I score this vector?" decisions trivially unit-testable.

// A vector may only be scored when it is a non-empty array of finite numbers.
// This is deliberately stricter than a bare `vec.length` check: a vector with a
// non-number, NaN or Infinity must never reach cosine scoring (a truthy length
// says nothing about usability).
function isUsableVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return false;
  for (const x of vec) {
    if (typeof x !== "number" || !Number.isFinite(x)) return false;
  }
  return true;
}

// A stored vector may only be reused when it was produced by the SAME vector
// space the current provider would produce. Anything we cannot positively prove
// compatible (missing/unusable embedding, missing/foreign provider or model
// metadata, or a recorded dimension that disagrees with the vector length) is
// treated as incompatible, so the caller re-embeds instead of comparing foreign
// vectors.
function matches(row, want) {
  if (!row || !want) return false;
  if (!isUsableVector(row.embedding)) return false;
  if (row.embeddingProvider !== want.provider) return false;
  if (row.embeddingModel !== want.model) return false;
  if (row.embeddingDim != null && row.embeddingDim !== row.embedding.length) return false;
  return true;
}

// Local space-qualified model id. It encodes every input that can change the
// vector for the same text: precision (dtype), the hand-maintained stack
// revision, and the resolved runtime versions. The runtime component is what
// catches a dependency bump (a caret upgrade can change onnxruntime-node and
// therefore the int8 numerics) without a manual revision change.
function localSpaceModel({ base, dtype, revision, fingerprint }) {
  const tf = (fingerprint && fingerprint.transformers) || "?";
  const ort = (fingerprint && fingerprint.onnxruntime) || "?";
  return `${base}@${dtype}~r${revision}+tf${tf}+ort${ort}`;
}

module.exports = { matches, isUsableVector, localSpaceModel };

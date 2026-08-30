// Shared WebCrypto helpers for the optional passphrase lock.
//
// The threat this closes is offline access to the profile directory (a stolen
// laptop without full-disk encryption, a synced backup, a shared machine).
// It deliberately does NOT try to defend against malware already running as
// the user - that could keylog the passphrase or read the unlocked key out of
// memory, and pretending otherwise would be security theatre.
//
// The derived key is kept in chrome.storage.session, which is memory-backed
// and never written to disk, so the passphrase is needed again after every
// browser restart. That is the whole point: nothing on disk can decrypt the
// token on its own.
//
// Loaded as a classic script (importScripts in the service worker, a <script>
// tag in the options/popup pages), so it attaches to the global rather than
// exporting.

(function attachCryptoUtils(global) {
  const ENCODER = new TextEncoder();
  const DECODER = new TextDecoder();

  // OWASP's floor for PBKDF2-SHA256. Stored alongside the ciphertext so this
  // can be raised later without stranding tokens encrypted at the old cost.
  const PBKDF2_ITERATIONS = 310000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12; // AES-GCM's standard nonce length

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  }

  async function deriveKey(passphrase, saltBytes, iterations) {
    const material = await crypto.subtle.importKey("raw", ENCODER.encode(passphrase), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      true, // extractable, so the raw bytes can be parked in session storage
      ["encrypt", "decrypt"]
    );
  }

  // Returns both the on-disk record and the raw key, so a caller that has just
  // set a passphrase can unlock immediately instead of prompting for it again.
  async function encryptToken(token, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENCODER.encode(token));
    return {
      record: {
        ciphertext: bytesToBase64(ciphertext),
        iv: bytesToBase64(iv),
        salt: bytesToBase64(salt),
        iterations: PBKDF2_ITERATIONS,
      },
      keyB64: bytesToBase64(await crypto.subtle.exportKey("raw", key)),
    };
  }

  async function deriveKeyB64(passphrase, record) {
    const key = await deriveKey(
      passphrase,
      base64ToBytes(record.salt),
      record.iterations || PBKDF2_ITERATIONS
    );
    return bytesToBase64(await crypto.subtle.exportKey("raw", key));
  }

  // AES-GCM is authenticated, so a wrong passphrase fails here rather than
  // returning garbage - that's what makes this a usable passphrase check.
  async function decryptToken(record, keyB64) {
    const key = await crypto.subtle.importKey("raw", base64ToBytes(keyB64), { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv) },
      key,
      base64ToBytes(record.ciphertext)
    );
    return DECODER.decode(plaintext);
  }

  global.LcgsCrypto = { PBKDF2_ITERATIONS, encryptToken, deriveKeyB64, decryptToken };
})(typeof self !== "undefined" ? self : globalThis);

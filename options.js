const tokenInput = document.getElementById("token");
const repoInput = document.getElementById("repo");
const basePathInput = document.getElementById("basePath");
const syncFailedAttemptsInput = document.getElementById("syncFailedAttempts");
const encryptTokenInput = document.getElementById("encryptToken");
const passphraseFields = document.getElementById("passphraseFields");
const passphraseInput = document.getElementById("passphrase");
const passphraseConfirmInput = document.getElementById("passphraseConfirm");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

const MIN_PASSPHRASE_LENGTH = 8;

// kind: "ok" | "error" | "info". Progress and advisory messages must not use
// "ok" - green reads as "that worked", which is wrong for something still in
// flight or for a notice that the token is locked.
function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusEl.className = `visible ${kind}`;
}

function syncPassphraseVisibility() {
  passphraseFields.hidden = !encryptTokenInput.checked;
}

async function loadSettings() {
  const { githubToken, encryptedToken, githubRepo, basePath, syncFailedAttempts } =
    await chrome.storage.local.get([
      "githubToken",
      "encryptedToken",
      "githubRepo",
      "basePath",
      "syncFailedAttempts",
    ]);

  if (githubRepo) repoInput.value = githubRepo;
  basePathInput.value = basePath || "problems";
  syncFailedAttemptsInput.checked = syncFailedAttempts !== false;
  encryptTokenInput.checked = Boolean(encryptedToken);
  syncPassphraseVisibility();

  if (!encryptedToken) {
    if (githubToken) tokenInput.value = githubToken;
    return;
  }

  // Encrypted: only prefill if this browser session is already unlocked.
  // Otherwise the user has to paste a token again to change anything here,
  // which is the honest consequence of the key not being on disk.
  const { tokenKey } = await chrome.storage.session.get("tokenKey");
  if (!tokenKey) {
    setStatus("Your token is encrypted and locked. Unlock from the extension popup, or paste a new token below to replace it.", "info");
    return;
  }
  try {
    tokenInput.value = await LcgsCrypto.decryptToken(encryptedToken, tokenKey);
  } catch (err) {
    console.warn("[LeetCode->GitHub] could not decrypt stored token", err);
    setStatus("Stored token could not be decrypted. Paste a token below to replace it.", "error");
  }
}

function githubHeaders(token, extra) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    ...extra,
  };
}

// A GET on /repos/{owner}/{repo} succeeds for any public repo regardless of
// token permissions, so it can't tell us whether the token can actually write.
// We prove write access for real: PUT a throwaway file, then delete it.
async function validateWriteAccess(token, repo) {
  const testPath = `.leetcode-github-sync-write-check-${Date.now()}`;

  const putResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${testPath}`, {
    method: "PUT",
    headers: githubHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      message: "Validate write access (auto-deleted)",
      content: btoa("leetcode-github-sync write check"),
    }),
  });
  if (!putResponse.ok) {
    const body = await putResponse.text();
    throw new Error(`Token cannot write to "${repo}" (HTTP ${putResponse.status}): ${body}`);
  }
  const putJson = await putResponse.json();

  // Best-effort cleanup - write access is already proven by the PUT above,
  // so a failure here (dropped connection, etc.) shouldn't fail validation.
  // It just means a small leftover file the user can delete manually.
  try {
    const deleteResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${testPath}`, {
      method: "DELETE",
      headers: githubHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: "Remove write access check file",
        sha: putJson.content.sha,
      }),
    });
    if (!deleteResponse.ok) {
      console.warn(`[LeetCode->GitHub] could not clean up validation file "${testPath}" (HTTP ${deleteResponse.status})`);
    }
  } catch (err) {
    console.warn(`[LeetCode->GitHub] could not clean up validation file "${testPath}"`, err);
  }
}

async function validateToken(token, repo) {
  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
  });
  if (!userResponse.ok) {
    throw new Error(`Token rejected by GitHub (HTTP ${userResponse.status}).`);
  }

  const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: githubHeaders(token),
  });
  if (!repoResponse.ok) {
    throw new Error(`Repo "${repo}" not reachable with this token (HTTP ${repoResponse.status}).`);
  }

  await validateWriteAccess(token, repo);
}

saveButton.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  const repo = repoInput.value.trim();
  const basePath = (basePathInput.value.trim() || "problems").replace(/^\/+|\/+$/g, "");

  if (!token || !repo) {
    setStatus("Token and target repo are both required.", "error");
    return;
  }
  // The repo string is interpolated straight into every GitHub API URL, so it
  // has to be exactly "owner/repo" and nothing else - an "includes a slash"
  // check would happily pass a value carrying extra path segments or a query.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    setStatus('Target repo must be in "owner/repo" format.', "error");
    return;
  }
  // basePath is prepended to every committed file path, so a ".." segment
  // would write outside the folder the user thinks they picked.
  if (basePath.split("/").some((segment) => segment === "..")) {
    setStatus('Base folder cannot contain ".." segments.', "error");
    return;
  }

  const usePassphrase = encryptTokenInput.checked;
  const passphrase = passphraseInput.value;
  if (usePassphrase) {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setStatus(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`, "error");
      return;
    }
    if (passphrase !== passphraseConfirmInput.value) {
      setStatus("The two passphrases don't match.", "error");
      return;
    }
  }

  saveButton.disabled = true;
  setStatus("Validating token, repo access, and write permission...", "info");

  try {
    await validateToken(token, repo);
    await chrome.storage.local.set({
      githubRepo: repo,
      basePath,
      syncFailedAttempts: syncFailedAttemptsInput.checked,
    });

    if (usePassphrase) {
      const { record, keyB64 } = await LcgsCrypto.encryptToken(token, passphrase);
      await chrome.storage.local.set({ encryptedToken: record });
      // The plaintext copy must go, or encrypting it accomplished nothing.
      await chrome.storage.local.remove("githubToken");
      // Unlock straight away so saving doesn't immediately lock the user out.
      await chrome.storage.session.set({ tokenKey: keyB64 });
      setStatus("Saved and encrypted. You'll re-enter this passphrase after each browser restart.", "ok");
    } else {
      await chrome.storage.local.set({ githubToken: token });
      await chrome.storage.local.remove("encryptedToken");
      await chrome.storage.session.remove("tokenKey");
      setStatus("Saved. Token, repo access, and write permission confirmed.", "ok");
    }

    passphraseInput.value = "";
    passphraseConfirmInput.value = "";
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    saveButton.disabled = false;
  }
});

encryptTokenInput.addEventListener("change", syncPassphraseVisibility);

loadSettings();

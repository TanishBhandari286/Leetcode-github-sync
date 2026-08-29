const tokenInput = document.getElementById("token");
const repoInput = document.getElementById("repo");
const basePathInput = document.getElementById("basePath");
const syncFailedAttemptsInput = document.getElementById("syncFailedAttempts");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

function setStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.className = `visible ${isError ? "error" : "ok"}`;
}

async function loadSettings() {
  const { githubToken, githubRepo, basePath, syncFailedAttempts } = await chrome.storage.local.get([
    "githubToken",
    "githubRepo",
    "basePath",
    "syncFailedAttempts",
  ]);
  if (githubToken) tokenInput.value = githubToken;
  if (githubRepo) repoInput.value = githubRepo;
  basePathInput.value = basePath || "problems";
  syncFailedAttemptsInput.checked = syncFailedAttempts !== false;
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
  const basePath = basePathInput.value.trim() || "problems";

  if (!token || !repo) {
    setStatus("Token and target repo are both required.", true);
    return;
  }
  if (!repo.includes("/")) {
    setStatus('Target repo must be in "owner/repo" format.', true);
    return;
  }

  saveButton.disabled = true;
  setStatus("Validating token, repo access, and write permission...", false);

  try {
    await validateToken(token, repo);
    await chrome.storage.local.set({
      githubToken: token,
      githubRepo: repo,
      basePath,
      syncFailedAttempts: syncFailedAttemptsInput.checked,
    });
    setStatus("Saved. Token, repo access, and write permission confirmed.", false);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

loadSettings();

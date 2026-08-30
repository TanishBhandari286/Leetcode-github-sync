const repoLabel = document.getElementById("repoLabel");
const openOptions = document.getElementById("openOptions");
const openOptionsFooter = document.getElementById("openOptionsFooter");
const retryBanner = document.getElementById("retryBanner");
const retryDetail = document.getElementById("retryDetail");
const retryButton = document.getElementById("retryButton");
const activityList = document.getElementById("activityList");
const emptyState = document.getElementById("emptyState");
const backfillDetail = document.getElementById("backfillDetail");
const backfillButton = document.getElementById("backfillButton");
const backfillProgressTrack = document.getElementById("backfillProgressTrack");
const backfillProgressFill = document.getElementById("backfillProgressFill");

const DIFFICULTY_CLASS = { Easy: "difficulty-easy", Medium: "difficulty-medium", Hard: "difficulty-hard" };

function relativeTime(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function githubFileUrl(repo, path) {
  return `https://github.com/${repo}/blob/HEAD/${path}`;
}

function statusDotClass(outcome) {
  if (outcome === "success") return "status-success";
  if (outcome === "skipped" || outcome === "disabled") return "status-skipped";
  return "status-failed";
}

function outcomeText(entry) {
  switch (entry.outcome) {
    case "success":
      return `${entry.statusDisplay || "Synced"} · ${relativeTime(entry.timestamp)}`;
    case "skipped":
      return `Already synced · ${relativeTime(entry.timestamp)}`;
    case "disabled":
      return `Skipped - failed-attempt syncing is off · ${relativeTime(entry.timestamp)}`;
    case "not_configured":
      return "Not configured - open settings";
    default:
      return (entry.errorMessage || "Sync failed").slice(0, 90);
  }
}

function renderRow(entry) {
  const isLink = entry.outcome === "success" && entry.repo && entry.filePath;
  const row = document.createElement(isLink ? "a" : "div");
  row.className = "activity-row";
  if (isLink) {
    row.href = githubFileUrl(entry.repo, entry.filePath);
    row.target = "_blank";
    row.rel = "noopener noreferrer";
  }

  const dot = document.createElement("span");
  dot.className = `status-dot ${statusDotClass(entry.outcome)}`;
  row.appendChild(dot);

  const main = document.createElement("div");
  main.className = "activity-main";

  const titleLine = document.createElement("div");
  titleLine.className = "activity-title";
  const titleText = document.createElement("span");
  titleText.textContent = entry.title || entry.titleSlug || "Unknown problem";
  titleLine.appendChild(titleText);
  if (entry.difficulty && DIFFICULTY_CLASS[entry.difficulty]) {
    const tag = document.createElement("span");
    tag.className = `difficulty-tag ${DIFFICULTY_CLASS[entry.difficulty]}`;
    tag.textContent = entry.difficulty;
    titleLine.appendChild(tag);
  }
  main.appendChild(titleLine);

  const metaLine = document.createElement("div");
  metaLine.className = "activity-meta";
  if (entry.outcome === "failed") metaLine.classList.add("activity-meta-error");
  metaLine.textContent = outcomeText(entry);
  main.appendChild(metaLine);

  row.appendChild(main);

  if (isLink) {
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "›";
    row.appendChild(chevron);
  }

  return row;
}

function renderBackfillPanel(backfillStatus) {
  const status = backfillStatus || {};
  backfillProgressTrack.hidden = true;
  backfillDetail.classList.remove("is-error");

  if (status.running) {
    backfillButton.disabled = true;
    backfillButton.textContent = "Running...";
    if (status.note) {
      backfillDetail.textContent = status.note;
    } else if (status.phase === "scanning") {
      backfillDetail.textContent = `Scanning your submission history... ${status.scanned || 0} checked so far.`;
    } else {
      const total = status.totalAccepted || 0;
      const done = (status.synced || 0) + (status.skipped || 0) + (status.failed || 0);
      backfillDetail.textContent = status.currentTitle
        ? `Syncing ${done}/${total} - ${status.currentTitle}`
        : `Syncing ${done}/${total} accepted submissions...`;
    }
    if (status.phase === "syncing") {
      const total = status.totalAccepted || 0;
      const done = (status.synced || 0) + (status.skipped || 0) + (status.failed || 0);
      backfillProgressTrack.hidden = false;
      backfillProgressFill.style.width = total > 0 ? `${Math.min(100, (done / total) * 100)}%` : "0%";
    }
    return;
  }

  backfillButton.disabled = false;
  backfillButton.textContent = status.finishedAt ? "Run again" : "Backfill";

  if (status.phase === "error") {
    backfillDetail.textContent = `Backfill failed: ${(status.error || "unknown error").slice(0, 120)}`;
    backfillDetail.classList.add("is-error");
  } else if (status.phase === "done") {
    backfillDetail.textContent =
      `Done - ${status.synced || 0} synced, ${status.skipped || 0} already up to date` +
      (status.failed ? `, ${status.failed} failed` : "") +
      ` · ${relativeTime(status.finishedAt)}`;
  } else {
    backfillDetail.textContent =
      "Pulls every accepted submission from your LeetCode history into this repo - handy if you're migrating from LeetHub or another tool.";
  }
}

async function render() {
  const {
    activityLog = [],
    lastFailedSync = null,
    githubRepo,
    backfillStatus = null,
  } = await chrome.storage.local.get(["activityLog", "lastFailedSync", "githubRepo", "backfillStatus"]);

  renderBackfillPanel(backfillStatus);

  repoLabel.textContent = githubRepo || "Not configured";

  if (lastFailedSync) {
    retryBanner.hidden = false;
    retryDetail.textContent = `${lastFailedSync.title || "A submission"} · ${relativeTime(lastFailedSync.timestamp)}`;
  } else {
    retryBanner.hidden = true;
  }

  activityList.innerHTML = "";
  if (activityLog.length === 0) {
    emptyState.hidden = false;
    activityList.hidden = true;
  } else {
    emptyState.hidden = true;
    activityList.hidden = false;
    activityLog.forEach((entry) => activityList.appendChild(renderRow(entry)));
  }
}

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
openOptionsFooter.addEventListener("click", () => chrome.runtime.openOptionsPage());

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  retryButton.textContent = "Retrying...";
  try {
    await chrome.runtime.sendMessage({ type: "RETRY_LAST_FAILED" });
  } finally {
    await render();
    retryButton.disabled = false;
    retryButton.textContent = "Retry";
  }
});

backfillButton.addEventListener("click", async () => {
  backfillButton.disabled = true;
  backfillButton.textContent = "Starting...";
  // On success, leave rendering to the storage.onChanged listener below -
  // content.js writes "backfillStatus" almost immediately once it starts,
  // and a render() here would just race that write with stale data.
  const result = await chrome.runtime.sendMessage({ type: "START_BACKFILL" });
  if (!result?.ok) {
    backfillButton.disabled = false;
    backfillButton.textContent = "Backfill";
    backfillDetail.classList.add("is-error");
    if (result?.reason === "no_leetcode_tab") {
      backfillDetail.textContent = "Open any LeetCode problem page in a tab first, then try again.";
    } else if (result?.reason === "already_running") {
      backfillDetail.textContent = "A backfill is already in progress.";
    } else {
      backfillDetail.textContent = "Couldn't start the backfill - check the console on your LeetCode tab.";
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "local" &&
    (changes.activityLog || changes.lastFailedSync || changes.githubRepo || changes.backfillStatus)
  ) {
    render();
  }
});

render();

const repoLabel = document.getElementById("repoLabel");
const openOptions = document.getElementById("openOptions");
const openOptionsFooter = document.getElementById("openOptionsFooter");
const retryBanner = document.getElementById("retryBanner");
const retryDetail = document.getElementById("retryDetail");
const retryButton = document.getElementById("retryButton");
const activityList = document.getElementById("activityList");
const emptyState = document.getElementById("emptyState");

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

async function render() {
  const { activityLog = [], lastFailedSync = null, githubRepo } = await chrome.storage.local.get([
    "activityLog",
    "lastFailedSync",
    "githubRepo",
  ]);

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.activityLog || changes.lastFailedSync || changes.githubRepo)) {
    render();
  }
});

render();

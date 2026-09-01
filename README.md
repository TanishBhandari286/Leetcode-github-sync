# LeetCode to GitHub Sync

A browser extension that watches your LeetCode submissions and pushes them to a GitHub repo of your choice automatically. Every submission gets committed — not just the ones that pass — so your repo ends up as a real record of how you actually solved each problem, not just a highlight reel.

It also keeps a README in that repo up to date with a solved-problems index and two auto-generated stat visualizations (difficulty rings and a topics breakdown), so the repo is something you'd actually want to look back at.

> ### ⚠️ Chromium-only
>
> This works on **Chromium-based browsers only**: Chrome, Brave, Edge, Arc, Opera, Vivaldi.
>
> **Firefox is not supported** and won't work if you try — it uses a different extension API surface, and this is built against Chrome's Manifest V3 (`chrome.*` APIs, a service worker background script, and `chrome.storage.session`). Safari isn't supported either. Porting to Firefox is possible but hasn't been done.

**What you get:**

- Every submission synced — accepted *and* failed (failed attempts are optional, see below)
- Each accepted attempt kept as its own file, so an optimized second pass never overwrites your first solution
- An auto-generated README index with difficulty, topic tags, and status per problem
- Difficulty-ring and topic-breakdown SVG charts, refreshed on every sync
- One-click **backfill** of your entire existing solve history
- Optional **passphrase encryption** for your GitHub token

## Setup

### 1. Clone this repo

```
git clone https://github.com/TanishBhandari286/Leetcode-github-sync.git
```

This creates a folder called `Leetcode-github-sync`. Keep it somewhere permanent — Chrome loads the extension from this folder every time it starts, so if you delete or move it, the extension breaks.

### 2. Turn on developer mode

Extensions that aren't from the Chrome Web Store need developer mode turned on before your browser will load them.

1. Open `chrome://extensions` in a new tab. (On Brave it's `brave://extensions`, on Edge `edge://extensions` — same page, different prefix.)
2. Look for the **Developer mode** toggle in the top-right corner of the page.
3. Turn it on. A few extra buttons will appear, including "Load unpacked".

### 3. Load the extension

1. Still on the extensions page, click **Load unpacked**.
2. In the file picker, select the `Leetcode-github-sync` folder you just cloned — the folder itself, the one with `manifest.json` directly inside it. Don't open the folder and pick a file.
3. It should appear in your extensions list with no errors. If your browser complains, double-check you selected the right folder.

### 4. Create a GitHub personal access token

The extension needs a token to push commits on your behalf. Here's how to make one:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens/new) (or navigate manually: click your profile picture → **Settings** → scroll down to **Developer settings** on the left → **Personal access tokens** → **Tokens (classic)**).
2. Click **Generate new token** → **Generate new token (classic)**.
3. Give it a name you'll recognize later, like "leetcode-sync".
4. Set an expiration. A bounded expiry is genuinely worth it here — if the token ever leaks, it dies on its own.
5. Under **Select scopes**, check the box for **`repo`**. That one checkbox covers everything the extension needs (creating files, updating them, reading repo info). If your tracking repo is going to be public and you'd rather scope things down, you can check just **`public_repo`** instead, which does the same thing but only for public repos.
6. Scroll down and click **Generate token**.
7. Copy the token now — GitHub only shows it to you once. If you lose it, you'll have to generate a new one.

We recommend the **classic** token over a fine-grained one here. Fine-grained tokens are more precise in theory, but GitHub's UI makes it easy to grant read-only access by mistake, and the permission changes don't always take effect without regenerating the token. Classic tokens with the `repo` scope just work.

### 5. Create the repo you want your solutions pushed to

This is separate from the extension's own repo — it's wherever *your* solved problems will actually live. Go to GitHub and create a new repo (public or private, your call). It can start completely empty; the extension will create everything it needs inside it.

### 6. Configure the extension

1. Go back to the extensions page, find "LeetCode to GitHub Sync", and open its options page (click **Details** → **Extension options**, or right-click the extension's icon in your toolbar and choose **Options**).
2. Paste in the personal access token you generated.
3. Enter your target repo in the form `your-username/your-repo-name`.
4. Optionally set a base folder name (defaults to `problems`).
5. Leave **Sync failed submissions** on to capture everything, or turn it off to only commit solutions that passed.
6. Click **Validate & Save**. This doesn't just check the token exists — it actually writes a temporary file to your repo and deletes it, to prove the token really has write access. If anything's wrong, it'll tell you exactly what (bad token, wrong repo name, missing permissions).

### 7. Optionally, protect your token with a passphrase

**This step is entirely optional — skip it and everything works.**

By default your token is stored unencrypted in the extension's local storage. If you'd rather it not sit on disk in the clear, flip on **Protect token with a passphrase** in the options page and set a passphrase.

What changes when it's on:

- Your token is encrypted with AES-GCM, using a key derived from your passphrase (PBKDF2-SHA256, 310,000 iterations, random per-token salt).
- The key is kept **in memory only** and never written to disk — which is exactly what makes the encryption meaningful.
- You'll re-enter the passphrase **once per browser restart** (also after reloading or updating the extension). Not on every sync — once you unlock, it stays unlocked for that browser session.
- While locked, syncs pause. Click the extension icon, enter your passphrase, then hit **Retry**.
- **There's no recovery.** Forget the passphrase and you just paste a fresh token and set a new one.

It's off by default because it's a real tradeoff against syncing silently in the background. See [Security and privacy](#security-and-privacy) for what it actually protects against.

### 8. That's it

Go solve a problem on LeetCode like you normally would. Hit Submit. A minute or so later, check your repo — the solution should be sitting there, along with an updated README showing your progress. No further action needed; it runs in the background from here.

## Bringing your existing solve history over

Already have hundreds of solves, or you're coming from LeetHub or LeetSync? You don't have to start from scratch.

Open any LeetCode problem page, click the extension icon, and hit **Backfill**. It pulls every accepted submission you've ever made straight from LeetCode's own API, so it works no matter what tool you used before — it never touches your old repo.

A few things to expect:

- Only **accepted** submissions are backfilled. Replaying years of failed attempts would flood the repo and burn through rate limits for little benefit.
- It's paced deliberately slowly to stay under LeetCode's rate limits, with periodic pauses. A large history takes a while — that's expected, not a hang.
- It's safe to re-run. Anything already synced is skipped — and re-running repairs the stats charts for any problem whose difficulty and topic data LeetCode didn't return the first time, so it's the fix if the rings ever look behind the table.
- Keep the LeetCode tab open while it runs. If you close it, the backfill stops — just hit **Backfill** again to pick up where it left off.

## A couple of things worth knowing

- The extension only acts when you click **Submit** on a LeetCode problem page. If you reload the extension itself (say, because you pulled an update), also reload any open LeetCode tabs — otherwise the page is still running the old content script and nothing will sync until you refresh it.
- Click the extension's toolbar icon any time to see recent syncs, including any that failed and why, with a retry button.
- If a sync fails repeatedly, it's almost always the token — check it hasn't expired and still has the right scope.

## Security and privacy

Worth understanding before you point this at a repo:

- **By default your token is stored unencrypted on your machine.** It lives in the extension's local storage (deliberately not Chrome's *sync* storage, so it never leaves your device). Anything with access to your machine or your browser profile can read it. Scope the token to the one repo it needs, give it an expiry, and revoke it in GitHub if you ever think it leaked.
- **Optionally, you can lock it behind a passphrase** — see [step 7](#7-optionally-protect-your-token-with-a-passphrase). This closes exactly one gap: someone reading your disk, a backup, or a profile you left behind on a shared machine. It is **not** protection against malware already running as you — that could log the passphrase or read the key out of memory. We'd rather say that plainly than imply it's bulletproof.
- **Everything synced is as public as your repo is.** If your target repo is public, so are your solutions — including, by default, your failed attempts. If you'd rather not publish wrong answers, turn off "Sync failed submissions" in the options or use a private repo.
- **The extension only runs on LeetCode problem pages** and only ever talks to `leetcode.com` and `api.github.com`. There is no backend, no telemetry, and nothing is sent anywhere else. You don't have to take that on faith — `manifest.json` lists the complete set of hosts it's permitted to reach.
- **It can write to your repo, not just add to it.** The token needs write access, so a bug (or a bad token pasted from somewhere else) could in principle modify files. Pointing it at a dedicated solutions repo, rather than one holding anything you care about, is the safer default.

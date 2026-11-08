# Terms of Use and Warnings

Last updated: 2026-11-08

By installing, running, forking or otherwise using Saint Expeditus Bot ("the software": the bridge server, the
Discord bot and the Chrome extension in this repository), you agree to these terms. If you do not agree, do not use
the software.

## 1. ⚠️ The agent runs in "YOLO mode"

The bridge starts the Claude Code CLI with `--dangerously-skip-permissions`
(`bridge-server/src/session-manager.ts`). **The agent never asks before it acts.** Anything you, or anyone who can
message the bot, asks for can be carried out at once, with the full rights of the operating-system user that runs the
bridge. That includes:

- **Running any shell command:** installing software, deleting or overwriting files, changing system settings.
- **Reading any file that user can read:** source code, SSH keys, cloud credentials, `.env` files, browser data,
  keystores, personal documents.
- **Acting on your accounts:** `git push` (including to `main`), opening or merging pull requests, publishing
  packages, uploading app builds, sending email or messages, posting to Discord, Messenger or YouTube, through any
  CLI or token that is logged in on the machine.
- **Spending money:** API usage (Anthropic, cloud providers, stores), paid services and anything billed per call.
- **Talking to the internet:** fetching pages and calling APIs, and sending data out.

### Be careful what you approve

- **"Yes", "do it", "make an informed decision for me" and "continue" are approvals.** Read what the agent proposes
  before you answer, especially anything irreversible: deleting data, force-pushing, publishing, releasing to users,
  payments, emails, messages to other people, or changes to credentials and permissions.
- **The agent can be wrong and still sound confident.** Check its claims (test results, "it's safe", "nothing
  changed") against the actual files, commits and dashboards before you rely on them.
- **Anyone who can trigger the bot can steer it.** Restrict who can message it (private channels, allow-listed
  users), and treat every member of those channels as able to run commands on your machine.
- **Prompt injection is real.** Web pages, emails, chat messages, issues, files and tool output the agent reads can
  contain instructions that try to hijack it. Don't point it at untrusted content while it holds powerful
  credentials.
- **Autonomous loops multiply mistakes.** Auto-continue, scheduled runs and sub-agents act without a human in
  between. Keep them to work you would approve unseen.

### Run it safely

- Run the bridge as a **dedicated OS user, or in a VM or container**, with access only to the projects it needs.
- Give it **least-privilege, revocable tokens:** scoped GitHub tokens, no admin or billing roles, separate API keys
  with spend limits. Never log it into accounts it doesn't need.
- **Keep secrets out of reach:** a keychain or secret manager instead of plain files in its working directories.
  Never paste secrets into chat.
- **Back up** anything you can't afford to lose, and protect important branches (required reviews, no force push).
- **Watch it:** keep logs, review what it did after each session, and stop the process
  (`pm2 stop all` / Ctrl-C) the moment it does something you didn't intend.
- Prefer the CLI's normal permission prompts, or an `--allowedTools` allow-list, wherever you don't need full
  autonomy.

## 2. No warranty

THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, SECURITY AND
NON-INFRINGEMENT. AI output may be incorrect, incomplete, insecure or harmful. You are solely responsible for
reviewing and verifying everything the software or the agent produces or does.

## 3. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL THE AUTHORS, CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR ITS USE. This includes data loss, leaked credentials, unauthorized
actions on your accounts, service charges, account suspensions, downtime and any direct, indirect, incidental,
special or consequential damages, even if advised of the possibility of such damages.

## 4. Your responsibilities

- **Every action the agent takes on your machine and accounts is your action.** You are responsible for its
  consequences and for complying with the law.
- **Third-party terms apply to you.** Anthropic, Discord, Meta/Facebook Messenger, Google/YouTube, GitHub and any
  other service the software touches have their own terms, usage policies and rate limits. Automating a personal
  account (for example, reading or posting in Messenger through a browser extension) may break a platform's terms
  and can get the account restricted. Check before you use it.
- **Privacy.** The bot reads chat messages and keeps "memory" files on disk, and it sends conversation content to
  the AI provider. Tell the people in your chats, get any consent the law requires, keep what you store to a
  minimum, and delete it when asked. Don't use the software to process sensitive personal data (health, finances,
  minors' information) or for surveillance.
- **No harmful use.** Don't use the software to harass, spam, impersonate, deceive, break into systems or violate
  anyone's rights, or for any purpose prohibited by the AI provider's usage policy.
- **Not professional advice.** Anything the agent says is not legal, medical, financial or safety advice.

## 5. Changes and termination

These terms may change at any time. Continuing to use the software after a change means you accept the new terms.
You may stop using the software at any time; your responsibility for what it did while you ran it remains.

## 6. Ownership

This repository has no open-source license yet. Unless a `LICENSE` file says otherwise, all rights are reserved by
the copyright holder. Viewing and forking on GitHub are governed by GitHub's Terms of Service.

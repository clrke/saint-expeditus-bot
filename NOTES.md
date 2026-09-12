# Project Notes

## Relationship to `saint-expeditus` (private)
This repo (`saint-expeditus-bot`, public) is a deliberately separate copy of
just the application code from the private `saint-expeditus` monorepo. It was
built from a precise include-whitelist, not a copy-then-exclude — the private
repo's git history (which contains real Messenger chat exports and
cross-project business notes) was never touched and never will be by this
repo's existence.

Keep editing application code (bridge-server, chrome-extension, discord-bot,
shared, test, scripts) in whichever repo you're actively working in, then
port changes to the other manually — there's no automated sync between them.

## Deferred decision — private repo history purge
**Status: on hold, resume only on explicit request.**

Question considered: should `saint-expeditus`'s git history be rewritten
(via `git-filter-repo` + force-push) to strip the confidential files
(Messenger chat exports, `.projects/` business notes, `HANDOFF.md`) so that
repo itself could eventually be made public, instead of maintaining two
repos?

Decision (2026-09-12): **declined for now.** The goal that prompted this —
having a public, shareable version of the bot's code — is already fully
satisfied by this repo. A history rewrite adds real risk (force-push,
breaks any existing clones, GitHub-side caching can retain traces even
after a rewrite) for no remaining functional benefit. Per git-safety
practice, destructive history rewrites only happen on an explicit,
specific request for that exact action — not a general "clean this up."

If you want it revisited later (e.g. a new reason to want the *original*
repo public, not just a code copy), say so explicitly and it can be
re-scoped as its own task.

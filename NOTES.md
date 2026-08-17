# NOTES.md — Lessons from the headless (Puppeteer) version

This extension and the headless automation (`mathew8e/inviter-headless`) both
automate the same Facebook flow: open a post's reactions dialog, scroll it,
click "Invite" on everyone who doesn't already follow the page. The headless
version ran for months against a real account and hit real, non-obvious
failure modes. Condensed here so they don't get rediscovered from scratch if
this extension is ever extended.

## 1. The reactions dialog can open filtered to ONE reaction type

Facebook sometimes opens the dialog scoped to whichever reaction icon was
actually clicked (e.g. "Like: 316 people") instead of the full list. If you
invite from that filtered view, everyone who reacted with Haha/Love/Wow/etc.
is invisible and silently never gets invited — while the run still reports
"success." This was the single biggest source of missed invites in the whole
project, likely responsible for tens of thousands of missed people over time.

**Fix:** after opening the dialog, look for an "All" / "Vše" tab and click it
before scanning for Invite buttons. Don't trust that a dialog which opened
successfully is showing everyone.

## 2. The reactor list lazy-loads — don't trust one quick check

The list is virtualized: scrolling to what looks like the bottom doesn't mean
everyone has rendered yet. A single "no new rows after one scroll" check is
not reliable — it can conclude "done" after seeing well under half the real
list, especially right after switching to the "All" tab (that switch tears
down and re-renders the whole list, which needs real time to repopulate).

**Fix:** after a scroll (or a tab switch) that appears to hit bottom, wait
and recheck — ideally more than once, independently — before concluding
there's nothing left. Seconds, not milliseconds.

## 3. Rate limits are real, and "safe" is not fully known

Facebook's actual block message: *"You're Temporarily Blocked — It looks
like you were misusing this feature by going too fast. You've been
temporarily blocked from using it."* This happened twice on the same
account:

- ~1,166 invites in one day at ~1.5s between clicks → blocked.
- ~302 invites in one day at 12–24s between clicks → blocked again.

The second block happened at roughly a quarter the volume of the first, with
much more conservative pacing. **Conclusion: slower pacing alone did not
prove safe.** Treat every invite-sending session as a real risk to the
account, not a solved problem. If this account (or others on the same home
network) show a block message anywhere on Facebook — not just here — that's
a sign the restriction may be tied to the network's IP, not the account
itself; if that happens, testing from a different network (e.g. mobile
data instead of home WiFi) is the way to tell the difference.

## 4. Stories vs. Reels vs. regular posts

- **Stories**: if the account's habit is "everything posted to the wall also
  gets posted to Stories," Stories are duplicates of a wall post that's
  already being handled — they don't need their own invite pass, and don't
  reliably expose a working reactions dialog anyway.
- **Reels**: these are NOT duplicates — they have their own real reactions
  and their own real people to invite. Easy to undercount if a workflow only
  checks regular photo/text posts.

## 5. Pacing values actually tested (not guaranteed safe — see #3)

- 12–24s between individual invite clicks (randomized, not fixed)
- ~60s pause between posts
- Cap of ~30 invites per post per pass (bounds risk if one post has an
  unexpectedly huge reactor list)
- Manual daily volume around 500 ran without issue historically; 1,400/day
  automated did not (see #3).

## 6. "Done" doesn't mean actually done

A post marked complete after one pass isn't guaranteed clean — new people
react to old posts constantly, and a pass can finish early due to #1 or #2
above without anyone noticing. The only real way to verify: reopen the
dialog later and count how many people still show an available Invite
button, compared to the post's total reaction count. Don't trust a status
label without spot-checking the actual dialog periodically.

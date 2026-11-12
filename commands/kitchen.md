---
description: Show where the Monkey Kitchen view is running
---

The kitchen page is locked to its owner, and the link that opens it carries the key. Find the line in your session context that starts with "The live kitchen view is at" and give the user that link exactly as written (it looks like `http://localhost:4747/?k=...`). Tell them that opening it once unlocks the page in that browser, that the server starts by itself when a session starts, and that the link should not be shared with anyone else.

If your session context has no such line (or it says the kitchen view is off, or that another server is in the way), tell the user what that line says instead, or, when there is none, to start a new Claude Code session, which prints a fresh link. Do not guess a link and do not do anything else.

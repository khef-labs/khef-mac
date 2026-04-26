---
name: change-name
description: This skill should be used when the user says "change name", "rename session", "change my name", "change your name", "rename yourself", or wants to change the current session's nickname.
---

# Change Name

Change the current session's nickname and update the iTerm2 terminal badge to match.

## Arguments

`$ARGUMENTS` is required — the new nickname to claim (e.g., `rooster`, `ridge`).

## Steps

### 1. Claim the Nickname

Call `claim_nickname` with your session ID and the requested nickname from `$ARGUMENTS`.

Your session ID is in the `UserPromptSubmit` hook output (e.g., `Session ID: <uuid>`).

### 2. Update the iTerm2 Badge

Run this bash command to update the terminal badge so it reflects the new name:

```bash
osascript -e "tell application \"iTerm2\" to tell current session of current tab of current window to set variable named \"user.claude_nickname\" to \"NEW_NAME\"" > /dev/null 2>&1
```

Replace `NEW_NAME` with the claimed nickname.

### 3. Confirm

Tell the user the name has been changed.

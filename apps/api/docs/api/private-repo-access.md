# GitHub Private Repo Access via Deploy Key (Read-Only)

This document describes how to grant **read-only access** to a **private GitHub repository** from a machine **without linking GitHub accounts**.

Use case:
- Clone / pull a private personal repo on a work machine
- No account crossover
- Re-clone allowed in the future
- Easy revocation

---

## 1. Generate a Repo-Scoped SSH Key (on target machine)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github-<owner>-<repo>-ro
````

* Do **not** reuse keys across repos
* Passphrase recommended

Files created:

* `~/.ssh/github-<owner>-<repo>-ro`
* `~/.ssh/github-<owner>-<repo>-ro.pub`

---

## 2. Add the Public Key as a Deploy Key (on GitHub)

Location:

```
Repository → Settings → Deploy keys → Add deploy key
```

Steps:

1. Open the `.pub` file:

   ```bash
   cat ~/.ssh/github-<owner>-<repo>-ro.pub
   ```
2. Paste the **entire single line** into GitHub
3. Leave **Allow write access** ⛔ unchecked

Notes:

* Do NOT paste `-----BEGIN...-----` blocks
* Deploy keys are repo-scoped and read-only

---

## 3. Add a Repo-Specific SSH Host Alias

Edit `~/.ssh/config`:

```ssh
Host gh-<repo>
  HostName github.com
  User git
  IdentityFile ~/.ssh/github-<owner>-<repo>-ro
  AddKeysToAgent yes
  UseKeychain yes
  IdentitiesOnly yes
```

Guidelines:

* One `Host` per repo
* Keep names explicit and auditable
* Place specific hosts above generic ones

---

## 4. Clone Using the Alias Host

Original GitHub SSH URL:

```
git@github.com:<owner>/<repo>.git
```

Modified (replace host only):

```
git@gh-<repo>:<owner>/<repo>.git
```

Clone:

```bash
git clone git@gh-<repo>:<owner>/<repo>.git
```

---

## 5. Store Passphrase in macOS Keychain (Optional)

```bash
ssh-add --apple-use-keychain ~/.ssh/github-<owner>-<repo>-ro
```

Verify:

```bash
ssh-add -l
```

---

## 6. Verify Access

Test SSH:

```bash
ssh -T git@gh-<repo>
```

Expected:

```
Hi! You've successfully authenticated, but GitHub does not provide shell access.
```

Fetch:

```bash
git fetch
```

---

## 7. Update Remote After Renaming Host (If Needed)

```bash
git remote set-url origin git@gh-<repo>:<owner>/<repo>.git
```

---

## 8. Optional Hardening (Prevent Pushes)

```bash
git config remote.origin.pushurl DISABLED
```

---

## 9. Revoking Access

To revoke access instantly:

```
Repository → Settings → Deploy keys → Remove
```

No machine or account cleanup required.

---

## Summary

* Deploy key = machine-to-repo trust
* SSH host alias = key selection
* Git remote URL = trigger for alias
* No GitHub account linkage
* Read-only, auditable, reversible

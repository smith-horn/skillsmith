# History Rewrite Notification Template

Use this template to notify all collaborators before executing a git history rewrite.
Fill in the bracketed fields and send via the appropriate channel (email, Slack, Linear).

---

**Subject: [ACTION REQUIRED] Skillsmith repository history rewrite on [DATE]**

---

## What is happening

The `smith-horn/skillsmith` repository will undergo a **git history rewrite** to remove sensitive files from the commit history before the repository transitions to public visibility.

This is a one-time, irreversible operation. After the rewrite, all commit SHAs in the repository will change.

**Linear issue**: SMI-2138

## Why

Encrypted files tracked by git-crypt are safe in the current state of the repository, but their binary ciphertext blobs remain in every historical commit. Before making the repository public, we must strip these artifacts from history to eliminate any risk of future cryptanalysis or accidental key exposure.

## When

- **Rewrite date**: [DATE AND TIME, e.g., Monday, February 17, 2026 at 10:00 AM PST]
- **Estimated downtime**: 30-60 minutes (repository will be force-pushed)
- **Freeze period**: No pushes to the repository from [FREEZE START] until the rewrite is confirmed complete

## What is affected

- All commit SHAs will change (every commit in the repository)
- All open pull requests will be invalidated
- All local clones and worktrees will become incompatible
- All forks will need to be re-forked
- CI caches and build artifacts referencing old SHAs will be stale

## What you need to do

### Before the rewrite

1. **Push all local work** to remote branches before [FREEZE START]
2. **Merge or close** any open pull requests
3. **Save any local stashes** -- they will not survive the re-clone
4. **Note your current branch names** for reference

### After the rewrite (confirmed via [CHANNEL])

1. **Remove your old clone entirely**:

   ```bash
   # Back up any untracked/local-only files first
   rm -rf skillsmith
   ```

2. **Re-clone the repository**:

   ```bash
   git clone git@github.com:smith-horn/skillsmith.git
   cd skillsmith
   ```

3. **Unlock git-crypt** (if you have access to encrypted files):

   ```bash
   varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
   ```

4. **Recreate any worktrees** you need:

   ```bash
   ./scripts/create-worktree.sh worktrees/<name> <branch-name>
   ```

5. **Start Docker and rebuild**:

   ```bash
   docker compose --profile dev up -d
   docker exec skillsmith-dev-1 npm install
   docker exec skillsmith-dev-1 npm run build
   ```

6. **Verify your environment**:

   ```bash
   docker exec skillsmith-dev-1 npm run preflight
   ```

### If you have a fork

1. Delete your fork on GitHub
2. Re-fork from the rewritten `smith-horn/skillsmith`
3. Re-clone from your new fork

## What you do NOT need to do

- You do not need to cherry-pick or rebase anything -- the rewrite preserves all file content, only SHAs change
- You do not need to update Linear issues -- commit links will break but issue content is unaffected
- You do not need to update CI configuration -- it will work automatically after the force-push

## Questions or issues

Contact [NAME] via:

- Linear: Comment on SMI-2138
- Email: [EMAIL]
- Slack: [CHANNEL]

---

*This notification was generated from `.claude/templates/history-rewrite-notification.md`.*

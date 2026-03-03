#!/bin/bash
# Enforce worktree workflow: block feature work on main branch in the main worktree.
# This hook runs on PreToolUse for Edit, Write, and Bash (git commit) events.
# Exit 0 = allow, Exit 2 = block (stderr shown to Claude as feedback)

MAIN_WORKTREE="$HOME/dev/smooai/config"
WORKTREE_PARENT="$HOME/dev/smooai"
WORKTREE_PREFIX="config-"

# Read the event from stdin
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null)

# Helper: check if a path is inside a feature worktree (not the main worktree)
is_in_worktree() {
    local path="$1"
    if [[ "$path" == "$WORKTREE_PARENT/$WORKTREE_PREFIX"* ]]; then
        return 0
    fi
    return 1
}

# For Edit/Write: block source code changes targeting the main worktree
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null)
    if is_in_worktree "$FILE_PATH"; then
        exit 0
    fi
    if [[ "$FILE_PATH" == *"/.claude/"* || "$FILE_PATH" == *"/.beads/"* || "$FILE_PATH" == *"/.changeset/"* || "$FILE_PATH" == *"CLAUDE.md"* || "$FILE_PATH" == *"/memory/"* ]]; then
        exit 0
    fi
    BRANCH=$(git -C "$MAIN_WORKTREE" symbolic-ref --short HEAD 2>/dev/null)
    if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
        exit 0
    fi
    cat >&2 <<EOF
BLOCKED: You are editing source code directly on the main branch in the main worktree.

All feature work MUST happen in a git worktree. Create one first:

  cd ~/dev/smooai/config
  git worktree add ../config-SMOODEV-XX-short-desc -b SMOODEV-XX-short-desc main
  cd ../config-SMOODEV-XX-short-desc
  pnpm install
  cd python && uv sync && cd ..

Then do your work in that worktree.
EOF
    exit 2
fi

# For Bash: block git commit on main (but allow merges, pulls, pushes, and worktree commits)
if [[ "$TOOL_NAME" == "Bash" ]]; then
    COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null)

    if echo "$COMMAND" | grep -qE "git\s+-C\s+.*/$WORKTREE_PREFIX"; then
        exit 0
    fi
    if echo "$COMMAND" | grep -qE "cd\s+.*/$WORKTREE_PREFIX.*&&.*git\s+commit"; then
        exit 0
    fi

    if echo "$COMMAND" | grep -qE 'git\s+commit' && ! echo "$COMMAND" | grep -q '\-\-no-ff'; then
        BRANCH=$(git -C "$MAIN_WORKTREE" symbolic-ref --short HEAD 2>/dev/null)
        if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
            cat >&2 <<EOF
BLOCKED: You are committing directly to the main branch in the main worktree.

Commits on main should only happen via merge (git merge BRANCH --no-ff).
All feature work MUST happen in a git worktree:

  cd ~/dev/smooai/config
  git worktree add ../config-SMOODEV-XX-short-desc -b SMOODEV-XX-short-desc main
  cd ../config-SMOODEV-XX-short-desc

Then commit your changes in that worktree.
EOF
            exit 2
        fi
    fi
fi

exit 0

#!/bin/bash

# Khef shell helpers — source from ~/.bash_profile:
#   source ~/projects/khef/lib/shell/claude.sh

KHEF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resume a recent Claude Code session for the current project
# Usage: clauderesume [nickname-or-prefix]
#   clauderesume        # list top 5 sessions, pick interactively
#   clauderesume leann  # resume latest session with nickname "leann"
#   clauderesume a1b2   # resume first session matching ID prefix (min 4 chars)
clauderesume() {
    trap 'echo ""; return 0' INT
    local prefix="${1:-}"
    local encoded=$(pwd | sed 's|/|-|g')
    local sessions_dir="$HOME/.claude/projects/$encoded"
    local project=$(basename "$(pwd)")
    local api="http://localhost:3201/api"

    if [ ! -d "$sessions_dir" ]; then
        echo "No sessions found for $(pwd)"
        return 1
    fi

    # If a prefix was given, try nickname first, then session ID prefix
    if [ -n "$prefix" ]; then
        # Try nickname lookup via dedicated endpoint (returns full lineage, ASC by started_at).
        # Prefer the most recent session in this project; fall back to most recent across projects.
        local nick_match=""
        nick_match=$(curl -sf "$api/sessions/by-nickname/$prefix" 2>/dev/null \
            | jq -r --arg project "$project" '
                (.sessions // []) as $all
                | ($all | map(select(.project_handle == $project))) as $scoped
                | (if ($scoped | length) > 0 then $scoped else $all end)
                | (last // {})
                | .session_id // empty')

        if [ -n "$nick_match" ]; then
            echo "Resuming: $prefix ($nick_match)"
            claude --resume "$nick_match"
            return
        fi

        # Fall back to session ID prefix match
        if [ ${#prefix} -lt 4 ]; then
            echo "No session matching nickname or prefix: $prefix"
            return 1
        fi
        local match=$(ls -t "$sessions_dir"/*.jsonl 2>/dev/null \
            | xargs -I{} basename {} .jsonl \
            | grep -i "^${prefix}" \
            | head -1)
        if [ -z "$match" ]; then
            echo "No session matching nickname or prefix: $prefix"
            return 1
        fi
        echo "Resuming: $match"
        claude --resume "$match"
        return
    fi

    # List mode: fetch sessions with nicknames from API, fall back to local files
    local api_sessions=""
    api_sessions=$(curl -sf "$api/sessions?project=$project&limit=5&sort=started_at&order=desc" 2>/dev/null)

    if [ -n "$api_sessions" ] && echo "$api_sessions" | jq -e '.sessions | length > 0' > /dev/null 2>&1; then
        local count=$(echo "$api_sessions" | jq '.sessions | length')

        echo "Recent sessions for $project:"
        echo ""
        for i in $(seq 0 $((count - 1))); do
            local sid=$(echo "$api_sessions" | jq -r ".sessions[$i].session_id")
            local nick=$(echo "$api_sessions" | jq -r ".sessions[$i].nickname // empty")
            local started=$(echo "$api_sessions" | jq -r ".sessions[$i].started_at // empty")
            local mod=""
            if [ -n "$started" ]; then
                mod=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${started%%.*}" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "${started:0:16}")
            fi
            printf "  %2d) %s  %-14s %s\n" $((i+1)) "$mod" "${nick:---}" "$sid"
        done

        echo ""
        read -p "Pick a session (1-${count}), or q to cancel: " choice

        if [[ "$choice" == "q" || -z "$choice" ]]; then
            return 0
        fi

        local idx=$((choice - 1))
        if [ $idx -ge 0 ] && [ $idx -lt $count ]; then
            local session_id=$(echo "$api_sessions" | jq -r ".sessions[$idx].session_id")
            local nick=$(echo "$api_sessions" | jq -r ".sessions[$idx].nickname // empty")
            echo "Resuming: ${nick:+$nick }($session_id)"
            claude --resume "$session_id"
        else
            echo "Invalid selection"
            return 1
        fi
    else
        # Fallback: local file listing (API unavailable)
        local files=($(ls -t "$sessions_dir"/*.jsonl 2>/dev/null | head -5))
        if [ ${#files[@]} -eq 0 ]; then
            echo "No sessions found for $(pwd)"
            return 1
        fi

        echo "Recent sessions for $project (API unavailable, names may be missing):"
        echo ""
        for i in "${!files[@]}"; do
            local sid=$(basename "${files[$i]}" .jsonl)
            local mod=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "${files[$i]}")
            printf "  %2d) %s  %-14s %s\n" $((i+1)) "$mod" "--" "$sid"
        done

        echo ""
        read -p "Pick a session (1-${#files[@]}), or q to cancel: " choice

        if [[ "$choice" == "q" || -z "$choice" ]]; then
            return 0
        fi

        local idx=$((choice - 1))
        if [ $idx -ge 0 ] && [ $idx -lt ${#files[@]} ]; then
            local session_id=$(basename "${files[$idx]}" .jsonl)
            echo "Resuming: $session_id"
            claude --resume "$session_id"
        else
            echo "Invalid selection"
            return 1
        fi
    fi
}

# Clear the iTerm2 session badge variables (claude_nickname, claude_session, claude_session_short, claude_badge)
# Usage: clearname
clearname() {
    local sid="${ITERM_SESSION_ID#*:}"
    if [ -z "$sid" ]; then
        echo "Not running in iTerm2 (ITERM_SESSION_ID not set)"
        return 1
    fi
    for v in claude_nickname claude_session claude_session_short claude_badge; do
        printf '\033]1337;SetUserVar=%s=\007' "$v" > /dev/tty 2>/dev/null || true
        osascript \
            -e 'tell application "iTerm2"' \
            -e 'repeat with w in windows' \
            -e 'repeat with t in tabs of w' \
            -e 'repeat with s in sessions of t' \
            -e "if id of s is \"$sid\" then" \
            -e "tell s to set variable named \"user.$v\" to \"\"" \
            -e 'end if' \
            -e 'end repeat' \
            -e 'end repeat' \
            -e 'end repeat' \
            -e 'end tell' >/dev/null 2>&1 || true
    done
}

alias cr="clauderesume"
alias kfr="source $KHEF_DIR/lib/shell/claude.sh"
alias kf="$KHEF_DIR/scripts/kf-edit.sh"
alias kv="$KHEF_DIR/scripts/voice/kf-voice.sh"

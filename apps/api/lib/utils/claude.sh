#!/bin/bash

# Claude Code helpers

# Show active Claude Code sessions (running claude processes)
# Usage: claude-ps
claude-ps() {
    local procs
    procs=$(ps aux | grep -E '[c]laude' | grep -v 'grep')
    if [[ -z "$procs" ]]; then
        echo "No active Claude sessions found."
        return 0
    fi
    echo "Active Claude sessions:"
    echo "$procs" | awk '{printf "  PID %-8s  %s %s %s %s\n", $2, $11, $12, $13, $14}'
}

# Update Claude Code to the latest version
# Usage: claudeupdate
claudeupdate() {
    echo "Updating Claude Code..."
    claude update
}

# Open global CLAUDE.md in editor
# Usage: editclaudeconfig
editclaudeconfig() {
    ${EDITOR:-code} ~/.claude/CLAUDE.md
}

# Open ~/.claude.json in editor
# Usage: editclaudejson
editclaudejson() {
    ${EDITOR:-code} ~/.claude.json
}

# List Claude session files and copy a selected session ID to clipboard
# Reads from tmp/sessions/ in the current directory (or specified dir)
# Usage: claude-sessions [dir]
claude-sessions() {
    local sess_dir="${1:-tmp/sessions}"

    if [[ ! -d "$sess_dir" ]]; then
        echo "No sessions directory found at $sess_dir"
        return 1
    fi

    # Build array of session files sorted by most recent first
    local files=()
    while IFS= read -r -d '' f; do
        files+=("$f")
    done < <(find "$sess_dir" -maxdepth 1 -type f -print0 | xargs -0 ls -1t 2>/dev/null | tr '\n' '\0')

    if [[ ${#files[@]} -eq 0 ]]; then
        echo "No session files found in $sess_dir"
        return 1
    fi

    # Display numbered list with titles
    echo "Claude sessions (most recent first):"
    echo
    local i=1
    for f in "${files[@]}"; do
        local sid
        sid=$(basename "$f")
        local titles
        titles=$(cat "$f" 2>/dev/null)
        local latest
        latest=$(tail -1 "$f" 2>/dev/null)

        if [[ -n "$latest" ]]; then
            printf "  %d) %s — %s\n" "$i" "$sid" "$latest"
        else
            printf "  %d) %s\n" "$i" "$sid"
        fi
        ((i++))
    done

    echo
    read -rp "Select session to copy ID [1-${#files[@]}]: " choice

    if [[ -z "$choice" ]] || [[ "$choice" -lt 1 ]] || [[ "$choice" -gt ${#files[@]} ]] 2>/dev/null; then
        echo "Cancelled."
        return 0
    fi

    local selected="${files[$((choice - 1))]}"
    local selected_id
    selected_id=$(basename "$selected")

    echo -n "$selected_id" | pbcopy
    echo "Copied: $selected_id"
}

# (Chat-related functions have moved to functions/chat.sh to make them
# available broadly, independent of any specific tool.)

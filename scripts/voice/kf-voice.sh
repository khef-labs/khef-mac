#!/bin/bash
# kf-voice.sh — Dictate a message and send it to a Claude Code session
#
# Prereqs:
#   1. ./listen binary compiled (make)
#   2. khef API running (npm run dev:api)
#
# Usage: ./kf-voice.sh [--debug] [--file PATH | SESSION]
#        ./kf-voice.sh --install
#   Listens until you press Enter, shows the transcript, and sends it
#   to a session of your choice via khef live messages.
#
#   SESSION can be a nickname (e.g., "vicky") or a session UUID.
#   When provided, messages are sent directly without the session picker.
#
#   --file PATH (-f PATH): Append transcript to a file instead of sending.
#   --install: Add 'vs' alias to shell profile (idempotent, safe for scripts)
#
#   Set KHEF_USER_NAME to show your name in the inbox (e.g., "Roger")
#   instead of "kf-voice". Add to your shell profile:
#     export KHEF_USER_NAME="Roger"

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
MAKE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Install mode ---
if [[ "${1:-}" == "--install" ]]; then
  # Compile listen binary first
  make -C "$MAKE_DIR" -s 2>/dev/null || true

  # Detect shell profile
  profile="$HOME/.bash_profile"
  [[ "$(basename "${SHELL:-bash}")" == "zsh" ]] && profile="$HOME/.zshrc"

  alias_line="alias vs='${SCRIPT_PATH}'"

  # Already installed and pointing here — nothing to do
  if grep -qF "$SCRIPT_PATH" "$profile" 2>/dev/null; then
    echo "vs: alias already installed in $profile"
    exit 0
  fi

  # Check if vs alias exists in profile pointing elsewhere
  if grep -qF "alias vs=" "$profile" 2>/dev/null; then
    existing="$(grep "alias vs=" "$profile")"
    echo "WARNING: existing vs alias found in $profile:"
    echo "  $existing"
    echo "Replacing with: $alias_line"
    sed -i '' "s|^alias vs=.*|${alias_line}|" "$profile"
    echo "vs: alias updated in $profile"
    exit 0
  fi

  # Fresh install
  echo "" >> "$profile"
  echo "# khef kf-voice — dictate and send messages to Claude Code sessions" >> "$profile"
  echo "$alias_line" >> "$profile"
  echo "vs: alias added to $profile (restart terminal or: source $profile)"
  exit 0
fi

LISTEN="$MAKE_DIR/listen"
API="${KHEF_API_URL:-http://localhost:3201}"
SENDER="${KHEF_USER_NAME:-kf-voice}"
RUN_TS="$(date +%Y%m%d-%H%M%S)"
DEBUG=false
TARGET_SESSION=""
OUTPUT_FILE=""
NEXT_IS_FILE=false

for arg in "$@"; do
    if [ "$NEXT_IS_FILE" = true ]; then
        OUTPUT_FILE="$arg"
        NEXT_IS_FILE=false
        continue
    fi
    case "$arg" in
        --debug) DEBUG=true ;;
        --file|-f) NEXT_IS_FILE=true ;;
        *) [ -z "$TARGET_SESSION" ] && TARGET_SESSION="$arg" ;;
    esac
done

if [ "$NEXT_IS_FILE" = true ]; then
    echo "Error: --file requires a path argument"
    exit 1
fi

debug() {
    if [ "$DEBUG" = true ]; then
        printf "\033[0;90m[debug] %s\033[0m\n" "$*"
    fi
}

# --- Preflight ---

if [ ! -x "$LISTEN" ]; then
    echo "Error: listen binary not found. Run 'make' in $MAKE_DIR first."
    exit 1
fi

if [ -z "$OUTPUT_FILE" ] && ! curl -sf "$API/health" > /dev/null 2>&1; then
    echo "Error: khef API not reachable at $API"
    echo "Start it with: npm run dev:api"
    exit 1
fi

if [ -z "${KHEF_USER_NAME:-}" ]; then
    printf "\033[0;90mTip: export KHEF_USER_NAME=\"YourName\" to show your name in the inbox.\033[0m\n"
fi

# Kill any lingering listen processes on exit
cleanup() {
    pkill -P $$ -f listen 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# --- Main ---

while true; do
    printf "\n\033[1;36mReady to record.\033[0m Press Enter when done listening.\n"
    printf "\033[0;90m(Ctrl+C to quit)\033[0m\n\n"

    # Listen in manual mode — stops when user presses Enter
    TRANSCRIPT=$("$LISTEN" -m 2>/dev/tty) || true

    if [ -z "$TRANSCRIPT" ]; then
        printf "\n\033[1;33mNo speech detected.\033[0m "
        printf "\033[1;36m[Enter]\033[0m to resume, \033[1;36m[q]\033[0m to quit: "
        read -r RESUME
        case "$RESUME" in
            q|Q) printf "\033[0;90mBye.\033[0m\n"; exit 0 ;;
        esac
        continue
    fi

    # Review loop — allows appending more speech
    while true; do
        # Show transcript
        printf "\n\033[1;32mTranscript:\033[0m\n"
        printf "  %s\n\n" "$TRANSCRIPT"

        if [ -n "$TARGET_SESSION" ]; then
            TARGET_LABEL=" → \033[1;33m$TARGET_SESSION\033[0m"
        else
            TARGET_LABEL=""
        fi
        printf "\033[1;36m[s/d/a/r/e/t/f/q]\033[0m (s=send, d=discard, a=append, r=re-record, e=edit, t=target%b, f=file, q=quit): " "$TARGET_LABEL"
        read -r CHOICE

        case "$CHOICE" in
            t|T)
                printf "\033[1;36mNew target session:\033[0m "
                read -r NEW_TARGET
                if [ -n "$NEW_TARGET" ]; then
                    TARGET_SESSION="$NEW_TARGET"
                    printf "\033[1;32mTarget set to %s.\033[0m\n" "$TARGET_SESSION"
                else
                    printf "\033[1;33mNo input — target unchanged.\033[0m\n"
                fi
                continue
                ;;
            e|E)
                EDIT_DIR=$(mktemp -d /tmp/kf-voice-edit-XXXXXX)
                EDIT_FILE="$EDIT_DIR/transcript.txt"
                echo "$TRANSCRIPT" > "$EDIT_FILE"
                "$MAKE_DIR/../kf-edit.sh" "$EDIT_FILE"
                printf "\033[0;90mEditing in khef editor...\033[0m Press Enter when done: "
                read -r
                EDITED=$(cat "$EDIT_FILE")
                rm -rf "$EDIT_DIR"
                if [ -n "$EDITED" ]; then
                    TRANSCRIPT="$EDITED"
                else
                    printf "\033[1;33mEmpty file — keeping original transcript.\033[0m\n"
                fi
                continue
                ;;
            a|A)
                printf "\n\033[1;36mContinue speaking.\033[0m Press Enter when done.\n\n"
                MORE=$("$LISTEN" -m 2>/dev/tty) || true
                if [ -n "$MORE" ]; then
                    TRANSCRIPT="$TRANSCRIPT $MORE"
                else
                    printf "\033[1;33mNo speech detected.\033[0m Keeping existing transcript.\n"
                fi
                continue
                ;;
            f|F)
                if [ -n "$OUTPUT_FILE" ]; then
                    FILE_PATH="$OUTPUT_FILE"
                else
                    # Default to tmp/voice/<session>-<timestamp>.txt (new file per run)
                    VOICE_DIR="$(cd "$(dirname "$0")/../.." && pwd)/tmp/voice"
                    mkdir -p "$VOICE_DIR"
                    FILE_NAME="${TARGET_SESSION:-transcripts}-$RUN_TS"
                    FILE_PATH="$VOICE_DIR/$FILE_NAME.txt"
                fi
                echo "$TRANSCRIPT" >> "$FILE_PATH"
                printf "\033[1;32mAppended to %s.\033[0m\n" "$FILE_PATH"
                TRANSCRIPT=""
                break
                ;;
            s|S)
                break
                ;;
            r|R)
                TRANSCRIPT=""
                break
                ;;
            q|Q)
                printf "\033[0;90mBye.\033[0m\n"
                exit 0
                ;;
            d|D)
                printf "\033[0;90mDiscarded.\033[0m\n"
                TRANSCRIPT=""
                break
                ;;
            *)
                continue
                ;;
        esac
    done

    # If re-record or discard, go back to top
    if [ -z "$TRANSCRIPT" ]; then
        continue
    fi

    # File-only mode (--file) — skip session resolution entirely
    if [ -n "$OUTPUT_FILE" ]; then
        echo "$TRANSCRIPT" >> "$OUTPUT_FILE"
        printf "\033[1;32mAppended to %s.\033[0m\n" "$OUTPUT_FILE"
        continue
    fi

    # Resolve target session
    if [ -n "$TARGET_SESSION" ]; then
        SESSION_NAME="$TARGET_SESSION"
    else
        # List active sessions and let user pick
        SESSIONS_JSON=$(curl -s "$API/api/active-sessions" 2>/dev/null) || true
        NICKNAMES=$(echo "$SESSIONS_JSON" | jq -r '[.sessions[]? | select(.status == "active") | .nickname // "unnamed"] | unique | .[]' 2>/dev/null) || true

        if [ -z "$NICKNAMES" ]; then
            printf "\033[1;33mNo active sessions found.\033[0m\n"
            continue
        fi

        # Build numbered list
        printf "\n\033[1;36mActive sessions:\033[0m\n"
        i=1
        declare -a NICK_LIST=()
        while IFS= read -r nick; do
            NICK_LIST+=("$nick")
            printf "  \033[1;33m%d)\033[0m %s\n" "$i" "$nick"
            i=$((i + 1))
        done <<< "$NICKNAMES"

        printf "\n\033[1;36mSend to [number or name, q to quit]:\033[0m "
        read -r PICK

        if [ -z "$PICK" ]; then
            printf "\033[1;33mNo selection. Discarding.\033[0m\n"
            continue
        fi

        if [ "$PICK" = "q" ] || [ "$PICK" = "Q" ]; then
            printf "\033[0;90mBye.\033[0m\n"
            exit 0
        fi

        # Resolve pick — number or direct name
        if [[ "$PICK" =~ ^[0-9]+$ ]] && [ "$PICK" -ge 1 ] && [ "$PICK" -le "${#NICK_LIST[@]}" ]; then
            SESSION_NAME="${NICK_LIST[$((PICK - 1))]}"
        else
            SESSION_NAME="$PICK"
        fi
    fi

    debug "Sending to session: $SESSION_NAME"

    # Send via live message API
    HTTP_CODE=$(mktemp /tmp/kf-voice-http-XXXXXX.tmp)
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/live-messages/$SESSION_NAME" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg content "$TRANSCRIPT" --arg from "$SENDER" \
            '{from_session_id: $from, content: $content}')" 2>&1) || true

    STATUS=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
        printf "\033[1;32mSent to %s.\033[0m\n" "$SESSION_NAME"
        debug "Response: $BODY"

        # Deliver nudge via iTerm2 osascript so the target session auto-reads
        NUDGE="Voice message from kf-voice. Use check_live_messages to read it."
        SESSION_IDS=$(echo "$BODY" | jq -r '.messages[]?.to_session_id // empty' 2>/dev/null) || true
        NUDGE_OK=0
        NUDGE_FAIL=0
        for TARGET_SID in $SESSION_IDS; do
            TERM_SID=$(curl -s "$API/api/active-sessions/by-session-id/$TARGET_SID" 2>/dev/null \
                | jq -r '.session.terminal_session_id // empty' 2>/dev/null) || true
            if [ -n "$TERM_SID" ]; then
                debug "iTerm2 nudge to terminal $TERM_SID"
                ESCAPED_NUDGE=$(echo "$NUDGE" | sed 's/\\/\\\\/g; s/"/\\"/g')
                NUDGE_RESULT=$(osascript -e "
tell application \"iTerm2\"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is \"$TERM_SID\" then
          tell s to write text \"$ESCAPED_NUDGE\"
          return \"ok\"
        end if
      end repeat
    end repeat
  end repeat
end tell
return \"not_found\"" 2>/dev/null) || NUDGE_RESULT="error"
                if [ "$NUDGE_RESULT" = "ok" ]; then
                    NUDGE_OK=$((NUDGE_OK + 1))
                else
                    NUDGE_FAIL=$((NUDGE_FAIL + 1))
                    debug "Nudge failed for $TARGET_SID: $NUDGE_RESULT"
                fi
            else
                NUDGE_FAIL=$((NUDGE_FAIL + 1))
                debug "No terminal_session_id for $TARGET_SID, skipping iTerm2 nudge"
            fi
        done
        if [ "$NUDGE_OK" -gt 0 ]; then
            printf "  \033[0;90m✓ Nudge delivered\033[0m\n"
        elif [ "$NUDGE_FAIL" -gt 0 ]; then
            printf "  \033[1;33m⚠ Nudge failed — session may not see it until next prompt\033[0m\n"
        fi
    else
        printf "\033[1;31mFailed to send (HTTP %s).\033[0m\n" "$STATUS"
        # Show error detail if available
        ERROR_MSG=$(echo "$BODY" | jq -r '.error // .message // empty' 2>/dev/null) || true
        if [ -n "$ERROR_MSG" ]; then
            printf "  %s\n" "$ERROR_MSG"
        fi
        debug "Full response: $BODY"
    fi

    rm -f "$HTTP_CODE"

    # Pause after sending — offer resend, new target, or record again
    LAST_TRANSCRIPT="$TRANSCRIPT"
    LAST_SESSION="$SESSION_NAME"
    while true; do
        printf "\n\033[1;36m[Enter/r/t/q]\033[0m (Enter=new recording, r=resend, t=resend to different target, q=quit): "
        read -r AGAIN
        case "$AGAIN" in
            q|Q) printf "\033[0;90mBye.\033[0m\n"; exit 0 ;;
            r|R)
                printf "\033[0;90mResending to %s...\033[0m\n" "$LAST_SESSION"
                RESEND_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/live-messages/$LAST_SESSION" \
                    -H "Content-Type: application/json" \
                    -d "$(jq -n --arg content "$LAST_TRANSCRIPT" --arg from "$SENDER" \
                        '{from_session_id: $from, content: $content}')" 2>&1) || true
                RESEND_STATUS=$(echo "$RESEND_RESPONSE" | tail -1)
                if [ "$RESEND_STATUS" = "200" ] || [ "$RESEND_STATUS" = "201" ]; then
                    printf "\033[1;32mResent to %s.\033[0m\n" "$LAST_SESSION"
                else
                    printf "\033[1;31mResend failed (HTTP %s).\033[0m\n" "$RESEND_STATUS"
                fi
                continue
                ;;
            t|T)
                printf "\033[1;36mResend to:\033[0m "
                read -r RESEND_TARGET
                if [ -z "$RESEND_TARGET" ]; then
                    printf "\033[1;33mNo input — skipped.\033[0m\n"
                    continue
                fi
                RESEND_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/live-messages/$RESEND_TARGET" \
                    -H "Content-Type: application/json" \
                    -d "$(jq -n --arg content "$LAST_TRANSCRIPT" --arg from "$SENDER" \
                        '{from_session_id: $from, content: $content}')" 2>&1) || true
                RESEND_STATUS=$(echo "$RESEND_RESPONSE" | tail -1)
                if [ "$RESEND_STATUS" = "200" ] || [ "$RESEND_STATUS" = "201" ]; then
                    printf "\033[1;32mSent to %s.\033[0m\n" "$RESEND_TARGET"
                else
                    printf "\033[1;31mResend failed (HTTP %s).\033[0m\n" "$RESEND_STATUS"
                fi
                continue
                ;;
            *) break ;;
        esac
    done
done

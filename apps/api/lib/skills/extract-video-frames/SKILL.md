---
name: extract-video-frames
description: Extract and view frames from a video file using ffmpeg. Use when the user says "extract frames", "see frames from video", "export video frames", "get screenshots from video", "look at this video", or provides a video file path and wants you to see its contents.
---

# Extract Video Frames

Extract frames from a video file and view them using a two-phase approach: extract proportionally, then read in passes.

## Prerequisites

- `ffmpeg` must be installed (`brew install ffmpeg` on macOS)

## Arguments

The user provides:
- **Video path** (required): Path to the video file (.mov, .mp4, .webm, etc.)
- **Frame count** (optional): How many frames to extract. If specified, use that count. Otherwise use the proportional defaults below.

## Phase 1: Extract Frames (Proportional to Duration)

1. **Probe the video** to get duration:
   ```
   ffmpeg -i <video_path> 2>&1 | grep Duration
   ```

2. **Calculate frame count** based on duration:
   | Duration | Frames to extract | Rationale |
   |----------|-------------------|-----------|
   | < 5s | 5 | Short clip, minimal content |
   | 5–30s | 10 | Standard content |
   | 30–60s | 15 | Medium scroll/walkthrough |
   | 60–120s | 20 | Long walkthrough |
   | 120s+ | 30 | Extended content |

   The user can override with a specific count (e.g., "extract 50 frames").

3. **Extract frames** to a temp directory:
   ```
   mkdir -p /tmp/khef-frames-<name>
   ffmpeg -y -i <video_path> -vf "fps=<frame_count>/<duration>" -q:v 2 /tmp/khef-frames-<name>/frame_%04d.jpg
   ```
   Use `-q:v 2` for high quality JPEG output.

4. **Report** total frames extracted and where they're stored.

## Phase 2: Read in Passes (10 at a Time)

Each image consumes significant context, so read strategically:

### First pass: Read 10 evenly spaced frames
- If N frames were extracted, read frames at indices: 1, N/9*1, N/9*2, ... N (evenly spaced, including first and last)
- Example: 20 frames extracted → read frames 1, 3, 5, 7, 9, 11, 13, 15, 17, 20
- Describe what you see, noting content at each frame and where gaps might exist

### Subsequent passes: Fill in gaps on demand
- After the first pass, tell the user which sections you covered and where gaps might exist
- If the user asks to "fill in gaps" or you notice missing content between frames, read the intermediate frames in that region
- Always read in batches of up to 10
- Stop when the full document/content has been covered

## Frame Storage

- **Keep the frames** — do NOT delete the temp directory after reading
- Tell the user where the frames are stored so they can find them
- Only clean up if the user explicitly asks to delete the frames

## Tips

- For screen recordings of UI bugs, focus on frames where the UI changes (transitions, clicks, error states)
- When describing frames, note approximate timestamps and what changed between frames
- If the user says "see this video" with a path, extract and view without asking for confirmation
- Use `-ss <timestamp>` to extract a single frame at a specific time: `ffmpeg -ss 00:00:05 -i video.mp4 -frames:v 1 frame.jpg`
- For document scrollthrough videos, the first pass usually captures everything — only fill gaps if sections are clearly missing from the table of contents

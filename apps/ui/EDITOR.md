# Editor

The built-in code editor at `/editor` provides file editing with split panes, cross-file search, and a command palette.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Cmd+Shift+P** | Command palette (files + commands) |
| **Cmd+Shift+F** | Cross-file search (sidebar) |
| **Ctrl+N** | New file in current folder |
| **Cmd+Shift+\\** | Toggle split editor |
| **Cmd+1/2/3...8** | Focus split pane by position (when split) |
| **Cmd+S** | Save current file |
| **Cmd+F** | Find in file (CodeMirror built-in) |
| **Cmd+H** | Find and replace in file |
| **Cmd+=** | Zoom in |
| **Cmd+-** | Zoom out |
| **Cmd+0** | Reset zoom |
| **Cmd+9** | Revert file to saved version |
| **Ctrl+X, K** | Close tab (chord: press Ctrl+X, then K) |

## Split Editor

Split the editor into multiple independent panes, each with its own tab bar.

- **Cmd+Shift+\\** to split. If you have multiple tabs open, the next tab moves to the new pane. If only one tab, both panes show the same file.
- **Cmd+Shift+\\** again to merge. The leftmost two panes collapse into one (duplicates are skipped). Repeat to fully unsplit.
- **Right-click a tab > Open in Split** to move a specific tab into a new pane. Works from both the top bar and split pane tab bars.
- **Click a pane** to focus it. New files from the explorer open in the focused pane.
- Each pane has its own tab bar with close buttons and right-click context menus.
- Closing the last tab in a split pane removes that pane automatically.
- Split layout and all group tabs persist across page refresh.
- **Drag the divider** between panes to resize them. Minimum pane width is 80px.
- **Cmd+1/2/3...8** focuses the pane at that position.
- **Right-click a tab > Maximize Pane** to expand one pane to fill the editor. Other panes are hidden but preserved. A position badge (e.g., "2 / 3") appears in the tab bar — click it or right-click > Restore Pane to bring back the split.

## Cross-File Search

Search across all files in the open folder using ripgrep.

1. Press **Cmd+Shift+F** or click the search icon in the sidebar.
2. Type a query. Results appear grouped by file with line numbers.
3. Toggle **Aa** for case-sensitive search or **.\*** for regex.
4. Click a result to open the file at that line.

Requires `rg` (ripgrep) installed. Install with `brew install ripgrep`.

## Command Palette

Press **Cmd+Shift+P** to open. Three scopes:

- **Commands** — editor actions (toggle word wrap, zoom, close tab, etc.)
- **Project** — fuzzy file search within the open folder
- **Global** — fuzzy file search across all recent folders

Type to filter. Arrow keys to navigate. Enter to select.

## File Explorer

- Click the folder icon in the sidebar header to open a folder.
- Click a file to open it in a tab.
- Right-click the tree for file/folder creation and deletion.
- Drag the sidebar edge to resize.
- Click the collapse button (or the panel icon when collapsed) to show/hide.

## Tabs

- Modified tabs show a yellow dot indicator.
- Closing a modified tab prompts to save, discard, or cancel.
- **Close All** in the top bar closes all tabs (prompts if any are unsaved).
- Right-click a tab for: Copy Path, Copy Relative Path, Open in Split, Maximize/Restore Pane, Close, Close All.

## Autosave

Files auto-save after 900ms of idle time. If a file was modified externally, a conflict prompt appears on save.

## Markdown Preview

For `.md` files, the top bar shows Edit / Split / Preview mode buttons:

- **Edit** — editor only
- **Split** — editor + live preview side by side
- **Preview** — rendered preview only

Mermaid code blocks render as diagrams in preview mode.

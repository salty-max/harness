# The pane as a terminal paints it, in motion (bin/terminal-paint.sh runs it).
#
#   python3 -I terminal-paint.py record LOG MOD_DIR FAMILY_DIR
#       a claude session with the mod (--plugin-dir) in a pty, 130 by 60, in
#       the family folder: /harness, then one prompt that needs no tool, so a
#       turn runs. Its output with timestamps into LOG (JSON lines), 38 seconds.
#   <venv>/python -I terminal-paint.py render LOG OUT FROM_S TO_S STEP_S
#       the log replayed through pyte, the pane's columns at each moment: OUT.txt
#       (every frame as text) and OUT.html (the frames in colour, faint kept).
import base64, fcntl, html, json, os, pty, select, signal, struct, sys, termios, time

COLS, ROWS = 130, 60
PROMPT = "Without using any tools, write six short paragraphs about the Barrens in Classic WoW."


def record(log_path, mod, family, seconds=38.0, start=11.0):
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        os.chdir(family)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        # (the file tree's pane would open over the harness's)
        settings = '{"enabledPlugins":{"filetree@claude-code-filetree":false}}'
        os.execvp("claude", ["claude", "--no-chrome", "--settings", settings, "--plugin-dir", mod, "/harness"])

    def type_line(text):
        for ch in text:
            os.write(fd, ch.encode())
            time.sleep(0.01)
        time.sleep(0.4)
        os.write(fd, b"\r")

    t0 = time.time()
    try:
        with open(log_path, "w") as log:
            _record(fd, log, t0, seconds, start, type_line)
    finally:
        # (an interrupted run too: the session never outlives the recording)
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _record(fd, log, t0, seconds, start, type_line):
    """The session's output into `log` until `seconds`: /harness raised, then the prompt typed."""
    raised, sent = False, False
    while time.time() - t0 < seconds:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            log.write(json.dumps([round(time.time() - t0, 3), base64.b64encode(data).decode()]) + "\n")
            # The terminal's answers: the cursor's place, the device, the background.
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b[c" in data or b"\x1b[0c" in data:
                os.write(fd, b"\x1b[?62;22c")
            if b"\x1b]11;?" in data:
                os.write(fd, b"\x1b]11;rgb:1e1e/1e1e/2828\x1b\\")
        if not raised and time.time() - t0 > start - 2.5:
            type_line("/harness")
            raised = True
        if not sent and time.time() - t0 > start:
            type_line(PROMPT)
            sent = True


NAMED = {
    "black": "#1e1e28", "red": "#e06c75", "green": "#98c379", "brown": "#e5c07b", "yellow": "#e5c07b",
    "blue": "#61afef", "magenta": "#c678dd", "cyan": "#56b6c2", "white": "#dcdfe4",
    "brightblack": "#5c6370", "brightred": "#ef8891", "brightgreen": "#b5e09b", "brightyellow": "#f0d197",
    "brightblue": "#86c2f5", "brightmagenta": "#d79ef0", "brightcyan": "#7fd0db", "brightwhite": "#ffffff",
}
BG = "#1e1e28"


def render(log_path, out, t_from, t_to, step):
    import pyte

    class FaintScreen(pyte.Screen):
        """pyte drops SGR 2 (faint): kept in the cell's `strikethrough`, which the pane never draws."""

        def select_graphic_rendition(self, *attrs, **kw):
            rest, i, faint = [], 0, None
            while i < len(attrs):
                a = attrs[i]
                if a in (38, 48, 58):  # (a colour's own numbers: 5;n or 2;r;g;b)
                    n = 3 if i + 1 < len(attrs) and attrs[i + 1] == 5 else 5
                    rest.extend(attrs[i : i + n])
                    i += n
                    continue
                if a == 2:
                    faint = True
                else:
                    if a in (22, 0):
                        faint = False
                    rest.append(a)
                i += 1
            if rest or not attrs:
                super().select_graphic_rendition(*rest, **kw)
            if faint is not None:
                self.cursor.attrs = self.cursor.attrs._replace(strikethrough=faint)

    def colour(c, fallback):
        if c == "default":
            return fallback
        return NAMED.get(c) or ("#" + c if len(c) == 6 else fallback)

    def faint(hex_colour):
        h = hex_colour.lstrip("#")
        rgb = [int(h[i : i + 2], 16) for i in (0, 2, 4)]
        bg = [int(BG[i : i + 2], 16) for i in (1, 3, 5)]
        return "#%02x%02x%02x" % tuple((v + w) // 2 for v, w in zip(rgb, bg))

    screen = FaintScreen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    events = [json.loads(l) for l in open(log_path)]

    def pane_left():
        # The pane's divider: the column just left of the row naming the harness.
        for y in range(ROWS):
            row = "".join(screen.buffer[y][x].data for x in range(COLS))
            if "HARNESS" in row:
                return row.rfind("│", 0, row.index("HARNESS")) + 1
        return 0

    frames, texts, i, t, left = [], [], 0, t_from, None
    while t <= t_to + 1e-9:
        while i < len(events) and events[i][0] <= t:
            stream.feed(base64.b64decode(events[i][1]))
            i += 1
        left = pane_left() if left is None or left == 0 else left
        rows_html, rows_text = [], []
        for y in range(ROWS):
            cells = []
            for x in range(left, COLS):
                ch = screen.buffer[y][x]
                fg = colour(ch.fg, "#dcdfe4")
                if ch.strikethrough:
                    fg = faint(fg)
                bg = colour(ch.bg, "")
                if ch.reverse:
                    fg, bg = (bg or BG), fg
                style = f"color:{fg};" + (f"background:{bg};" if bg else "") + ("font-weight:700;" if ch.bold else "")
                cells.append(f'<span style="{style}">{html.escape(ch.data or " ")}</span>')
            rows_html.append("".join(cells))
            rows_text.append("".join(screen.buffer[y][x].data or " " for x in range(left, COLS)).rstrip())
        frames.append((round(t, 3), "\n".join(rows_html)))
        texts.append(f"===== t={round(t, 3)}s\n" + "\n".join(rows_text))
        t += step
    with open(out + ".txt", "w") as f:
        f.write("\n".join(texts))
    page = [
        f"<!doctype html><meta charset=utf-8><style>body{{background:{BG};margin:0;padding:12px;font:13px/1.25 Menlo,monospace;color:#dcdfe4}}"
        "pre{margin:0;white-space:pre;font:inherit}h3{font:11px Menlo;color:#888;margin:0 0 2px}"
        "div.f{display:inline-block;vertical-align:top;margin:0 18px 14px 0}</style>"
    ]
    page += [f"<div class=f><h3>t = {m}s</h3><pre>{body}</pre></div>" for m, body in frames]
    with open(out + ".html", "w") as f:
        f.write("".join(page))


if __name__ == "__main__":
    if sys.argv[1] == "record":
        record(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        render(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6]))

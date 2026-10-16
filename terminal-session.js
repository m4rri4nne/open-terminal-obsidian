"use strict";

const { spawn } = require("child_process");

/**
 * A shell (pty-host process + xterm instance), independent of where it is displayed.
 * It can be attached to / detached from DOM elements without losing the process —
 * needed for Canvas, which unloads cards that are off-screen.
 */
class TerminalSession {
  constructor(plugin, { cwd, command } = {}) {
    this.plugin = plugin;
    this.cwd = cwd;
    this.pendingCommand = command || null;
    this.host = null;
    this.term = null;
    this.fit = null;
    this.exited = false;
    this.disposed = false;
    this.lastActive = Date.now();
    this.parentEl = null;
    // Called by runInTerminal/reveal(); set by whoever displays the session
    this.onReveal = null;
    this.el = createDiv({ cls: "open-terminal-xterm" });
  }

  /** Shows the terminal inside parentEl (creates xterm the first time). */
  attach(parentEl) {
    if (this.disposed) return;
    this.detach();
    this.parentEl = parentEl;
    parentEl.appendChild(this.el);
    if (!this.term) this.createTerm();
    else {
      // The theme may have changed while the session was detached
      this.applyTheme();
      this.term.refresh(0, this.term.rows - 1);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(parentEl);
    this.resize();

    if (!this.host && !this.exited) this.startShell();
  }

  /** Removes the terminal from the DOM, keeping the shell alive. */
  detach() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.resizeObserver = null;
    this.parentEl = null;
    this.el.detach();
  }

  isAttached() {
    return !!this.parentEl && this.el.isConnected;
  }

  createTerm() {
    const { Terminal, FitAddon } = this.plugin.loadXterm();
    const css = getComputedStyle(document.body);
    const cssVar = (name, fallback) => css.getPropertyValue(name).trim() || fallback;

    const isMac = process.platform === "darwin";
    // On macOS, Obsidian's --font-monospace can resolve to a proportional/unloaded font,
    // which makes xterm's cell measurement wrong (uneven, wide letter spacing).
    const monoFallback = "'SF Mono', SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace";
    const fontFamily = isMac
      ? monoFallback
      : `${cssVar("--font-monospace", "Consolas")}, ${monoFallback}`;

    this.term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontSize: this.plugin.settings.fontSize,
      fontFamily,
      letterSpacing: 0,
      lineHeight: isMac ? 1.25 : 1.1,
      fontWeight: "400",
      fontWeightBold: "600",
      macOptionIsMeta: isMac,
      scrollback: 5000,
      allowProposedApi: true,
      theme: this.buildTheme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.el);

    // Re-measure the character cell once fonts are ready
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!this.term) return;
        this.term.options.fontFamily = fontFamily;
        this.resize();
      });
    }

    // Ctrl+C copies when there is a selection; Ctrl+V / Ctrl+Shift+V paste
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && key === "c") return false;
      if (e.ctrlKey && key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => this.term && this.term.paste(text));
        return false;
      }
      return true;
    });

    this.term.onData((data) => {
      this.lastActive = Date.now();
      if (this.host) this.send({ t: "i", d: data });
      else if (this.exited) this.startShell();
    });
  }

  /**
   * xterm colors from the current Obsidian theme. Each variable is resolved through a
   * probe element so xterm always gets a plain rgb() value (themes may use var(),
   * hsl(var(...)) or color-mix(), which xterm cannot parse).
   */
  buildTheme() {
    const probe = (this.el.isConnected ? this.el : document.body).createDiv();
    probe.style.display = "none";
    const color = (name, fallback) => {
      probe.style.color = "";
      probe.style.color = `var(${name}, ${fallback})`;
      return getComputedStyle(probe).color || fallback;
    };
    const background = color("--background-primary", "#1e1e1e");
    const theme = {
      background,
      foreground: color("--text-normal", "#dcddde"),
      cursor: color("--text-accent", "#7f6df2"),
      cursorAccent: background,
      selectionBackground: color("--text-selection", "rgba(127,109,242,0.35)"),
    };
    probe.remove();
    return theme;
  }

  /** Re-reads the theme colors (called when Obsidian's theme / light-dark mode changes). */
  applyTheme() {
    if (this.term) this.term.options.theme = this.buildTheme();
  }

  startShell() {
    if (!this.term || !this.cwd || this.disposed) return;
    this.exited = false;

    const node = this.plugin.resolveNodePath();
    if (!node) {
      this.term.writeln("\x1b[31mNode.js not found. Set the Node.js path in the plugin settings.\x1b[0m");
      return;
    }

    const { cmd, args } = this.plugin.getShell();
    this.fitNow();
    const hostArgs = [this.plugin.hostPath(), this.cwd, cmd, String(this.term.cols), String(this.term.rows), ...args];

    const host = spawn(node, hostArgs, {
      cwd: this.plugin.pluginDir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.host = host;
    this.lastSize = null;
    host.stdout.setEncoding("utf8");
    host.stderr.setEncoding("utf8");
    host.stdout.on("data", (d) => {
      if (this.term) this.term.write(d);
      // Initial command (e.g. from the Claude Skills plugin): send it once the shell has responded
      if (this.pendingCommand) {
        const cmd = this.pendingCommand;
        this.pendingCommand = null;
        setTimeout(() => this.send({ t: "i", d: cmd + "\r" }), 400);
      }
    });
    host.stderr.on("data", (d) => this.term && this.term.write(`\x1b[31m${d.replace(/\n/g, "\r\n")}\x1b[0m`));
    host.on("error", (err) => {
      this.term && this.term.writeln(`\x1b[31mFailed to start the terminal: ${err.message}\x1b[0m`);
    });
    host.on("exit", () => {
      if (this.host !== host) return;
      this.host = null;
      this.exited = true;
      if (this.term) this.term.write("\r\n\x1b[2m[process exited — press any key to restart]\x1b[0m\r\n");
    });
  }

  send(msg) {
    if (this.host && this.host.stdin.writable) this.host.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Stops the shell (the terminal stays visible and restarts on the next key press). */
  kill() {
    const host = this.host;
    if (!host) return;
    this.send({ t: "k" });
    setTimeout(() => {
      try {
        host.kill();
      } catch {}
    }, 1000);
  }

  /** Restarts the shell in the same folder. */
  restart() {
    const host = this.host;
    if (host) {
      this.host = null; // the "exit" handler ignores stale hosts
      try {
        host.kill();
      } catch {}
    }
    if (this.term) this.term.reset();
    this.startShell();
  }

  /** Is the shell running (process alive)? */
  isAlive() {
    return !!this.host && !!this.term;
  }

  /** Text of the cursor's line, up to the cursor position. */
  cursorLineText() {
    if (!this.term) return "";
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    return line ? line.translateToString(true, 0, b.cursorX) : "";
  }

  /** Is the shell idle at its prompt (no program running)? */
  isAtPrompt() {
    if (!this.isAlive() || this.pendingCommand) return false;
    const text = this.cursorLineText().trimEnd();
    // PowerShell: "PS C:\...>" | cmd: "C:\...>" | bash/zsh: "...$" "...#" "...%"
    return /^PS [^>]*>$/.test(text) || /^[A-Za-z]:\\[^>]*>$/.test(text) || /[$#%]$/.test(text);
  }

  /** Types text into the terminal; submit=true presses Enter. */
  sendText(text, { submit = true } = {}) {
    this.lastActive = Date.now();
    this.send({ t: "i", d: text });
    if (submit) setTimeout(() => this.send({ t: "i", d: "\r" }), 150);
  }

  reveal() {
    if (this.onReveal) this.onReveal();
    this.focus();
  }

  focus() {
    if (this.term) this.term.focus();
  }

  fitNow() {
    if (!this.fit || !this.el.isShown()) return;
    try {
      this.fit.fit();
    } catch {}
  }

  resize() {
    if (!this.term) return;
    const { cols, rows } = this.term;
    this.fitNow();
    if (this.term.cols !== cols || this.term.rows !== rows || !this.lastSize) {
      this.lastSize = true;
      this.send({ t: "r", c: this.term.cols, r: this.term.rows });
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.kill();
    this.host = null;
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }
}

module.exports = { TerminalSession };

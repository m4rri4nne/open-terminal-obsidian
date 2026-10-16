"use strict";

// Plugin entry point. Bundled into ../main.js by esbuild (npm run build).

const { Plugin, Notice, FileSystemAdapter, TFile, TFolder } = require("obsidian");
const path = require("path");
const { VIEW_TYPE, BLOCK_LANG, DEFAULT_SETTINGS } = require("./constants");
const shell = require("./shell");
const { TerminalView } = require("./terminal-view");
const { BlockSessions, newBlockMarkdown } = require("./block-sessions");
const { getActiveCanvas, addTerminalToCanvas } = require("./canvas");
const { OpenTerminalSettingTab } = require("./settings-tab");

class OpenTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    this.addRibbonIcon("terminal-square", "Open terminal", () => {
      this.openTerminal(this.getVaultPath());
    });

    this.addCommand({
      id: "open-terminal-vault",
      name: "Open terminal at vault root",
      callback: () => this.openTerminal(this.getVaultPath()),
    });

    this.addCommand({
      id: "open-terminal-current-folder",
      name: "Open terminal at current note's folder",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openTerminal(this.getAbsolutePath(file.parent));
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const folder = file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
        if (!folder) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in terminal")
            .setIcon("terminal-square")
            .onClick(() => this.openTerminal(this.getAbsolutePath(folder)))
        );
      })
    );

    // Terminals embedded in ```terminal blocks (notes and Canvas)
    this.blocks = new BlockSessions(this);
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => this.blocks.process(source, el, ctx));

    this.addCommand({
      id: "insert-terminal-block",
      name: "Insert terminal into note",
      editorCallback: (editor) => editor.replaceSelection(newBlockMarkdown() + "\n"),
    });

    this.addCommand({
      id: "add-terminal-to-canvas",
      name: "Add terminal to canvas",
      checkCallback: (checking) => {
        const canvas = getActiveCanvas(this.app);
        if (!canvas) return false;
        if (!checking) addTerminalToCanvas(canvas);
        return true;
      },
    });

    // Follow theme / light-dark changes (xterm colors are not CSS, so they must be re-applied)
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));

    this.addSettingTab(new OpenTerminalSettingTab(this.app, this));
  }

  applyTheme() {
    const views = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v) => v instanceof TerminalView && v.session);
    for (const view of views) view.session.applyTheme();
    for (const session of this.blocks.sessions.values()) session.applyTheme();
  }

  onunload() {
    this.blocks.disposeAll();
  }

  /**
   * Public API for other plugins: opens a terminal and runs a command.
   * E.g.: app.plugins.plugins["open-terminal"].runInTerminal("claude", { cwd })
   */
  async runInTerminal(command, { cwd, reuse = false } = {}) {
    cwd = cwd || this.getVaultPath();
    if (reuse) {
      const view = this.getTerminals().find((v) => v.isAtPrompt());
      if (view) {
        view.reveal();
        view.sendText(`${this.cdCommand(cwd)} ${this.shellSeparator()} ${command}`);
        return view;
      }
    }
    return this.openTerminal(cwd, command);
  }

  /**
   * Open terminals: views (newest to oldest), then blocks visible in
   * notes/Canvas (most recently used first).
   */
  getTerminals() {
    const views = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v) => v instanceof TerminalView)
      .reverse();
    return [...views, ...this.blocks.visible()];
  }

  async openTerminal(cwd, command) {
    if (!cwd) {
      new Notice("Could not determine the folder path.");
      return;
    }
    const { workspace } = this.app;
    let leaf;
    switch (this.settings.location) {
      case "tab":
        leaf = workspace.getLeaf("tab");
        break;
      case "right":
        leaf = workspace.getRightLeaf(false);
        break;
      default:
        leaf = workspace.getLeaf("split", "horizontal");
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { cwd, command } });
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  loadXterm() {
    if (!this.xterm) {
      const base = path.join(this.pluginDir(), "node_modules", "@xterm");
      const { Terminal } = window.require(path.join(base, "xterm", "lib", "xterm.js"));
      const { FitAddon } = window.require(path.join(base, "addon-fit", "lib", "addon-fit.js"));
      this.xterm = { Terminal, FitAddon };
    }
    return this.xterm;
  }

  getShell() {
    return shell.getShell(this.settings);
  }

  resolveNodePath() {
    return shell.resolveNodePath(this.settings);
  }

  cdCommand(dir) {
    return shell.cdCommand(this.getShell().cmd, dir);
  }

  shellSeparator() {
    return shell.shellSeparator(this.getShell().cmd);
  }

  quoteArg(arg) {
    return shell.quoteArg(this.getShell().cmd, arg);
  }

  pluginDir() {
    return path.join(this.getVaultPath(), this.manifest.dir);
  }

  hostPath() {
    return path.join(this.pluginDir(), "pty-host.js");
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return null;
  }

  getAbsolutePath(folder) {
    const base = this.getVaultPath();
    if (!base) return null;
    if (!folder || folder.isRoot()) return base;
    return path.join(base, folder.path);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = OpenTerminalPlugin;

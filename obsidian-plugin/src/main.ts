import { Plugin, ItemView, WorkspaceLeaf, Modal, Setting, Notice, TFile } from 'obsidian';
import * as KDBX from '../../lib/index';
import { argon2id, argon2d } from 'hash-wasm';

KDBX.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  if (version !== 0x13) throw new Error('Unsupported Argon2 version');
  const fn = type === KDBX.CryptoEngine.Argon2TypeArgon2id ? argon2id : type === KDBX.CryptoEngine.Argon2TypeArgon2d ? argon2d : null;
  if (!fn) throw new Error('Unsupported Argon2 type');
  const hex = await fn({ password: new Uint8Array(password), salt: new Uint8Array(salt), memorySize: Math.ceil(memory / 1024), iterations, parallelism, hashLength: length, outputType: 'hex' });
  return Uint8Array.from(hex.match(/.{2}/g)!.map(x => parseInt(x, 16))).buffer;
});

const VIEW = 'gaspar-kdbx-explorer';
class PasswordDialog extends Modal {
  constructor(app: any, private callback: (p: string | null) => void) { super(app); }
  onOpen() {
    this.titleEl.setText('Unlock KDBX');
    let input: HTMLInputElement;
    new Setting(this.contentEl).setName('Master password').addText(t => { input = t.inputEl; input.type = 'password'; input.autocomplete = 'off'; });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Unlock').setCta().onClick(() => { const p = input.value; input.value = ''; this.close(); this.callback(p); }))
      .addButton(b => b.setButtonText('Cancel').onClick(() => { this.close(); this.callback(null); }));
  }
}
class KdbxView extends ItemView {
  private db: any; private file: TFile | null = null; private selected: any = null; private dirty = false;
  getViewType() { return VIEW; } getDisplayText() { return 'GASPAR KDBX'; } getIcon() { return 'lock-keyhole'; }
  async onOpen() { this.render(); }
  async onClose() { if (this.dirty) await this.save(); this.db = null; }
  async save() {
    if (!this.db || !this.file || !this.dirty) return;
    try { const bytes = await this.db.save(); await this.app.vault.modifyBinary(this.file, bytes); this.dirty = false; new Notice('Encrypted KDBX saved'); }
    catch (e) { new Notice('Save failed: ' + String(e)); }
  }
  async open(file: TFile, password: string) {
    try {
      const bytes = await this.app.vault.readBinary(file);
      const credentials = new KDBX.Credentials(KDBX.ProtectedValue.fromString(password));
      this.db = await KDBX.Kdbx.load(bytes, credentials); this.file = file; this.selected = null; this.dirty = false; this.render();
    } catch (e) { new Notice('Unlock failed: ' + String(e)); }
  }
  private choose() {
    const m = new Modal(this.app); m.titleEl.setText('Choose KDBX');
    for (const f of this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'kdbx')) {
      m.contentEl.createEl('button', { text: f.path }).onclick = () => { m.close(); new PasswordDialog(this.app, p => { if (p !== null) void this.open(f, p); }).open(); };
    }
    m.open();
  }
  selectEntry(entry: any) { this.selected = entry; this.render(); }
  private render() {
    this.contentEl.empty(); this.contentEl.addClass('gaspar-kdbx');
    const bar = this.contentEl.createDiv({ cls: 'gaspar-toolbar' });
    bar.createEl('button', { text: 'Open KDBX' }).onclick = () => this.choose();
    if (!this.db) { this.contentEl.createEl('p', { text: 'Locked. Password is not stored.' }); return; }
    bar.createEl('button', { text: 'Save' }).onclick = () => void this.save();
    bar.createEl('button', { text: 'Lock' }).onclick = async () => { await this.save(); if (!this.dirty) { this.db = null; this.file = null; this.render(); } };
    const tree = this.contentEl.createDiv({ cls: 'gaspar-tree' });
    const editor = this.contentEl.createDiv({ cls: 'gaspar-editor' });
    const show = (g: any, depth: number) => {
      const group = tree.createDiv({ text: '📁 ' + g.name }); group.style.paddingLeft = depth * 14 + 'px';
      for (const e of g.entries) {
        const item = tree.createDiv({ text: '📄 ' + String(e.fields.get('Title') || 'Untitled') });
        item.style.paddingLeft = (depth + 1) * 14 + 'px';
        item.onclick = () => {
          this.selected = e; editor.empty();
          const area = editor.createEl('textarea'); area.value = String(e.fields.get('GASPAR_MARKDOWN') || '');
          area.oninput = () => { e.fields.set('GASPAR_MARKDOWN', area.value); this.dirty = true; };
        };
      }
      for (const child of g.groups) show(child, depth + 1);
    };
    show(this.db.getDefaultGroup(), 0);
    if (this.selected) {
      editor.empty(); const area = editor.createEl('textarea');
      area.value = String(this.selected.fields.get('GASPAR_MARKDOWN') || '');
      area.oninput = () => { this.selected.fields.set('GASPAR_MARKDOWN', area.value); this.dirty = true; };
    }
  }
}
export default class GasparKdbxPlugin extends Plugin {
  private unlocked = new Map<string, any>();
  private observer: MutationObserver | null = null;
  private syncing = false;
  private async unlock(file: TFile): Promise<any | null> {
    const cached = this.unlocked.get(file.path);
    if (cached) return cached;
    return new Promise(resolve => {
      new PasswordDialog(this.app, async password => {
        if (password === null) { resolve(null); return; }
        try {
          const bytes = await this.app.vault.readBinary(file);
          const credentials = new KDBX.Credentials(KDBX.ProtectedValue.fromString(password));
          const db = await KDBX.Kdbx.load(bytes, credentials);
          this.unlocked.set(file.path, db); resolve(db);
        } catch (e) { new Notice('KDBX unlock failed: ' + String(e)); resolve(null); }
      }).open();
    });
  }
  private renderGroup(parent: HTMLElement, group: any, file: TFile, depth = 0) {
    const row = parent.createDiv({ cls: 'gaspar-virtual-row gaspar-virtual-group' });
    row.style.paddingLeft = (depth * 16 + 12) + 'px';
    row.setText('▸ 📁 ' + String(group.name || 'Group'));
    const children = parent.createDiv({ cls: 'gaspar-virtual-children' });
    children.style.display = 'none';
    row.onclick = ev => { ev.stopPropagation(); children.style.display = children.style.display === 'none' ? 'block' : 'none'; row.setText((children.style.display === 'none' ? '▸ ' : '▾ ') + '📁 ' + String(group.name || 'Group')); };
    for (const child of group.groups) this.renderGroup(children, child, file, depth + 1);
    for (const entry of group.entries) {
      const item = children.createDiv({ cls: 'gaspar-virtual-row gaspar-virtual-entry' });
      item.style.paddingLeft = ((depth + 1) * 16 + 12) + 'px';
      item.setText('📄 ' + String(entry.fields.get('Title') || 'Untitled') + '.md');
      item.onclick = async ev => {
        ev.stopPropagation();
        await this.open();
        const view = this.app.workspace.getLeavesOfType(VIEW)[0]?.view as KdbxView | undefined;
        if (view) {
          // Open through the existing encrypted editor, not a plaintext vault file.
          const db = this.unlocked.get(file.path);
          if (db) { await view.open(file, await this.requestPasswordForEditor(file)); view.selectEntry(entry); }
        }
      };
    }
  }
  private async requestPasswordForEditor(file: TFile): Promise<string> {
    return new Promise(resolve => new PasswordDialog(this.app, p => resolve(p || '')).open());
  }
  private refreshExplorer() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const files = new Map(this.app.vault.getFiles().filter(f => f.extension.toLowerCase() === 'kdbx').map(f => [f.path, f]));
      document.querySelectorAll('.workspace-leaf-content[data-type="file-explorer"] .tree-item[data-path]').forEach(el => {
        const node = el as HTMLElement;
        const file = files.get(node.getAttribute('data-path') || '');
        if (!file || node.querySelector(':scope > .gaspar-kdbx-virtual')) return;
        const container = node.createDiv({ cls: 'gaspar-kdbx-virtual' });
        const toggle = container.createDiv({ cls: 'gaspar-virtual-row gaspar-kdbx-toggle', text: '▸ 🔒 Browse as folder' });
        const contents = container.createDiv({ cls: 'gaspar-virtual-children' });
        contents.style.display = 'none';
        toggle.onclick = async ev => {
          ev.preventDefault(); ev.stopPropagation();
          if (contents.style.display !== 'none') { contents.style.display = 'none'; toggle.setText('▸ 🔒 Browse as folder'); return; }
          const db = await this.unlock(file);
          if (!db) return;
          contents.empty();
          this.renderGroup(contents, db.getDefaultGroup(), file);
          contents.style.display = 'block'; toggle.setText('▾ 🔓 ' + file.name);
        };
      });
    } finally { this.syncing = false; }
  }

  async onload() {
    this.registerView(VIEW, leaf => new KdbxView(leaf));
    this.app.workspace.onLayoutReady(() => {
      this.refreshExplorer();
      this.observer = new MutationObserver(() => this.refreshExplorer());
      this.observer.observe(document.body, { childList: true, subtree: true });
    });
    this.register(() => { this.observer?.disconnect(); this.unlocked.clear(); });
    this.addRibbonIcon('lock-keyhole', 'GASPAR KDBX Explorer', () => void this.open());
    this.addCommand({ id: 'open-kdbx-explorer', name: 'Open KDBX Explorer', callback: () => void this.open() });
  }
  private async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
}

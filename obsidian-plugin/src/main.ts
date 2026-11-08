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
  private async open(file: TFile, password: string) {
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
  }
}
export default class GasparKdbxPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW, leaf => new KdbxView(leaf));
    this.addRibbonIcon('lock-keyhole', 'GASPAR KDBX Explorer', () => void this.open());
    this.addCommand({ id: 'open-kdbx-explorer', name: 'Open KDBX Explorer', callback: () => void this.open() });
  }
  private async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
}

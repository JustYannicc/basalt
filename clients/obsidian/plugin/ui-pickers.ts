import { FuzzySuggestModal, Modal, type App, type TFolder } from "obsidian";
import { recoveryFolder } from "../local-vault.ts";

/** A two-button confirmation. The action's failure stays visible in the modal instead of a toast. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly options: {
      title: string;
      body: string;
      confirm: string;
      warning?: boolean;
      run: () => Promise<void>;
    },
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, options } = this;
    this.setTitle(options.title);
    contentEl.addClass("basalt-sync-modal");
    contentEl.createEl("p", { text: options.body });
    const error = contentEl.createDiv({ cls: "basalt-sync-callout is-error basalt-sync-hidden" });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = actions.createEl("button", {
      text: options.confirm,
      cls: options.warning ? "mod-warning" : "mod-cta",
    });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      error.addClass("basalt-sync-hidden");
      try {
        await options.run();
        this.close();
      } catch (failure) {
        error.setText(failure instanceof Error ? failure.message : String(failure));
        error.removeClass("basalt-sync-hidden");
        confirm.disabled = false;
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly pinned: readonly string[],
    private readonly choose: (folder: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a folder to keep offline");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllFolders(false)
      .filter(
        (folder) =>
          !this.pinned.includes(folder.path) &&
          folder.path !== recoveryFolder &&
          !folder.path.startsWith(`${recoveryFolder}/`),
      );
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.choose(folder.path);
  }
}

export const PROJECT_ID = "vscode-markdown-live-editor" as const;

export interface ProjectIdentity {
  readonly id: typeof PROJECT_ID;
  readonly displayName: string;
}

export const PROJECT_IDENTITY: ProjectIdentity = {
  id: PROJECT_ID,
  displayName: "Markdown Live Editor",
};

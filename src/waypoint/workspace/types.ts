export const SLASH_COMMAND_HINTS = ["/model", "/stop", "/status", "/commands"] as const;

export type AgentsFormState =
  | {
      mode: "add";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "edit";
      userId: string;
      handwrittenName: string;
    }
  | {
      mode: "remove";
      userId: string;
    };

export type EditPendingFields = {
  name: boolean;
  description: boolean;
};

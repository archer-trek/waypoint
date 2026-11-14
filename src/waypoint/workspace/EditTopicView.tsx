import type { FormEvent } from "react";
import type { EditPendingFields } from "./types";

export type EditTopicViewProps = {
  safeInset: number;
  editPendingFields: EditPendingFields;
  editNameInput: string;
  editDescriptionInput: string;
  editSubmitting: boolean;
  editError?: string;
  onSubmit: (event: FormEvent) => void;
  onEditNameInputChange: (value: string) => void;
  onEditDescriptionInputChange: (value: string) => void;
  onCloseEditForm: () => void;
};

/** Edit Topic name and description form panel. */
export function EditTopicView({
  safeInset,
  editPendingFields,
  editNameInput,
  editDescriptionInput,
  editSubmitting,
  editError,
  onSubmit,
  onEditNameInputChange,
  onEditDescriptionInputChange,
  onCloseEditForm,
}: EditTopicViewProps) {
  return (
    <section aria-label="编辑 Topic" className="waypoint-dialog">
      <div
        className="waypoint-dialog-body"
        style={{ paddingBottom: safeInset > 0 ? `${safeInset}px` : undefined }}
      >
        <h2>编辑 Topic</h2>
        <form onSubmit={onSubmit}>
          {editPendingFields.name ? (
            <label>
              Topic 名字
              <input
                name="edit-topic-name"
                value={editNameInput}
                disabled={editSubmitting}
                onChange={(event) => onEditNameInputChange(event.target.value)}
              />
            </label>
          ) : null}
          {editPendingFields.description ? (
            <>
              <label>
                Description（可选）
                <textarea
                  name="edit-topic-description"
                  value={editDescriptionInput}
                  disabled={editSubmitting}
                  onChange={(event) =>
                    onEditDescriptionInputChange(event.target.value)
                  }
                />
              </label>
              <p className="waypoint-field-hint">
                留空表示没有额外上下文；填写后会发给这条 Topic 绑定的 Bot，不是私密备忘。
              </p>
            </>
          ) : null}
          {editError ? <p role="alert">{editError}</p> : null}
          <div className="waypoint-form-actions">
            <button type="submit" disabled={editSubmitting}>
              {editSubmitting ? "正在保存…" : "保存"}
            </button>
            <button
              type="button"
              disabled={editSubmitting}
              onClick={onCloseEditForm}
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

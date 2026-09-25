import {
  HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE,
  type HarnessSessionListParams,
} from "@harnessmix/shared-contracts";
import type { RendererSettingsMessages } from "./localization.js";

const PAGE_SIZE_CHOICES = [20, 50, 100] as const;

// Owns the search box and pager for the session-import list. Harness discovery
// and the import action itself live in the page module; this control only
// tracks query/offset/limit state and reports changes upward.
export function createSessionImportListControls(
  document: Document,
  messages: RendererSettingsMessages,
  onChange: () => void,
) {
  let query = "";
  let offset = 0;
  let limit: number = HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE;
  let total = 0;
  let loading = false;
  let locked = false;

  const searchForm = document.createElement("form");
  searchForm.className = "settings-session-import-search";
  searchForm.setAttribute("role", "search");
  const search = document.createElement("input");
  search.type = "search";
  search.value = "";
  search.maxLength = 4_096;
  search.placeholder = messages.sessionImportSearchPlaceholder;
  search.setAttribute("aria-label", messages.sessionImportSearchPlaceholder);
  search.dataset.sessionImportAction = "search-input";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "settings-command-button settings-command-button--secondary";
  submit.textContent = messages.sessionImportSearch;
  submit.dataset.sessionImportAction = "search";
  searchForm.append(search, submit);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (locked) return;
    query = search.value.trim();
    offset = 0;
    onChange();
  });

  const pagination = document.createElement("div");
  pagination.className = "settings-session-import-pagination";
  const pageSizeLabel = document.createElement("label");
  pageSizeLabel.textContent = messages.sessionImportPageSize;
  const pageSize = document.createElement("select");
  pageSize.dataset.sessionImportAction = "page-size";
  pageSize.setAttribute("aria-label", messages.sessionImportPageSize);
  for (const size of PAGE_SIZE_CHOICES) {
    const option = document.createElement("option");
    option.value = String(size);
    option.textContent = String(size);
    pageSize.append(option);
  }
  pageSize.value = String(limit);
  pageSizeLabel.append(pageSize);
  pageSize.addEventListener("change", () => {
    if (locked) return;
    const value = Number(pageSize.value);
    if (!(PAGE_SIZE_CHOICES as readonly number[]).includes(value)) return;
    limit = value;
    offset = 0;
    onChange();
  });

  const summary = document.createElement("span");
  summary.setAttribute("role", "status");
  summary.dataset.sessionImportAction = "page-summary";

  const previous = document.createElement("button");
  const next = document.createElement("button");
  const pagerButtons: ReadonlyArray<{
    button: HTMLButtonElement;
    step: number;
  }> = [
    { button: previous, step: -1 },
    { button: next, step: 1 },
  ];
  previous.textContent = messages.sessionImportPrevious;
  previous.dataset.sessionImportAction = "previous";
  next.textContent = messages.sessionImportNext;
  next.dataset.sessionImportAction = "next";
  for (const { button, step } of pagerButtons) {
    button.type = "button";
    button.className = "settings-command-button settings-command-button--secondary";
    button.addEventListener("click", () => {
      if (button.disabled || locked || loading) return;
      offset += step * limit;
      onChange();
    });
  }

  const navigation = document.createElement("div");
  navigation.className = "settings-session-import-pagination__navigation";
  navigation.append(previous, next);
  pagination.append(pageSizeLabel, summary, navigation);

  const syncDisabledState = (): void => {
    search.disabled = locked;
    submit.disabled = locked;
    pageSize.disabled = locked;
    previous.disabled = locked || loading || offset === 0;
    next.disabled = locked || loading || offset + limit >= total;
    summary.textContent = loading
      ? ""
      : messages.sessionImportPageSummary
          .replace("{page}", String(total ? Math.floor(offset / limit) + 1 : 0))
          .replace("{pages}", String(Math.ceil(total / limit)))
          .replace("{total}", String(total));
  };
  syncDisabledState();

  return {
    searchForm,
    pagination,
    params(): Pick<HarnessSessionListParams, "query" | "offset" | "limit"> {
      return { query, offset, limit };
    },
    reset(): void {
      offset = 0;
      total = 0;
      syncDisabledState();
    },
    setBusy(value: boolean, lock = false): void {
      loading = value;
      locked = lock;
      syncDisabledState();
    },
    setTotal(value: number): boolean {
      total = value;
      const lastOffset = Math.max(0, Math.ceil(total / limit) - 1) * limit;
      const changed = offset > lastOffset;
      if (changed) offset = lastOffset;
      syncDisabledState();
      return changed;
    },
  };
}

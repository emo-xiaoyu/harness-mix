/**
 * Pets API client (catalog / community market / preview / install / select).
 * Results are cast to the readonly shapes below; `normalizeRendererPetSelection`
 * is the one defensive coercion for data arriving from storage.
 */
export interface RendererPetItem {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly source: "official" | "community" | "installed";
  readonly installed: boolean;
  readonly spriteVersionNumber?: number | undefined;
  readonly spritesheetUrl?: string | undefined;
  readonly previewUrl?: string | undefined;
  readonly posterUrl?: string | undefined;
  readonly downloadUrl?: string | undefined;
}

export interface RendererPetCatalogResult {
  readonly data: readonly RendererPetItem[];
  readonly officialAvailable: boolean;
  readonly petsDir: string;
}

export interface RendererPetCommunityResult {
  readonly data: readonly RendererPetItem[];
  readonly total: number;
  readonly source: string;
}

export interface RendererPetPreviewResult {
  readonly id: string;
  readonly mime: string;
  readonly dataBase64: string;
}

export interface RendererPetInstallParams {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly spritesheetUrl?: string | undefined;
  readonly spriteVersionNumber?: number | undefined;
}

export interface RendererPetInstallResult {
  readonly id: string;
  readonly path: string;
  readonly installed: boolean;
  readonly alreadyInstalled?: boolean | undefined;
}

export interface RendererPetSelection {
  readonly id: string | null;
  readonly displayName?: string | undefined;
  readonly spriteVersionNumber?: number | undefined;
}

/** Coerce an arbitrary RPC result into a safe selection shape. */
export function normalizeRendererPetSelection(input: unknown): RendererPetSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { id: null };
  const record = input as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return { id: null };
  const displayName =
    typeof record.displayName === "string" && record.displayName ? record.displayName : undefined;
  const spriteVersionNumber =
    typeof record.spriteVersionNumber === "number" &&
    Number.isInteger(record.spriteVersionNumber) &&
    record.spriteVersionNumber >= 1
      ? record.spriteVersionNumber
      : undefined;
  return {
    id: record.id,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(spriteVersionNumber !== undefined ? { spriteVersionNumber } : {}),
  };
}

export interface RendererPetsClient {
  catalog(): Promise<RendererPetCatalogResult>;
  community(query?: {
    page?: number;
    pageSize?: number;
    sort?: string;
    search?: string;
  }): Promise<RendererPetCommunityResult>;
  preview(id: string): Promise<RendererPetPreviewResult>;
  install(params: RendererPetInstallParams): Promise<RendererPetInstallResult>;
  uninstall(id: string): Promise<{ id: string; removed: boolean }>;
  selection(): Promise<RendererPetSelection>;
  select(id: string | null): Promise<RendererPetSelection>;
}

export function createRendererPetsClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererPetsClient {
  const call = <T>(method: string, params: unknown): Promise<T> =>
    send(method, params) as Promise<T>;
  return {
    catalog: () => call<RendererPetCatalogResult>("harnessmix/pets/catalog", {}),
    community: (query = {}) => call<RendererPetCommunityResult>("harnessmix/pets/community", query),
    preview: (id) => call<RendererPetPreviewResult>("harnessmix/pets/preview", { id }),
    install: (params) => call<RendererPetInstallResult>("harnessmix/pets/install", params),
    uninstall: (id) => call<{ id: string; removed: boolean }>("harnessmix/pets/uninstall", { id }),
    selection: () => call<RendererPetSelection>("harnessmix/pets/selection", {}),
    select: (id) => call<RendererPetSelection>("harnessmix/pets/select", { id }),
  };
}

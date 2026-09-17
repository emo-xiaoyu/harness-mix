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
}

export function createRendererPetsClient(
  send: (method: string, params: unknown) => Promise<unknown>,
): RendererPetsClient {
  return {
    catalog: async () => (await send("harnessmix/pets/catalog", {})) as RendererPetCatalogResult,
    community: async (query = {}) =>
      (await send("harnessmix/pets/community", query)) as RendererPetCommunityResult,
    preview: async (id: string) =>
      (await send("harnessmix/pets/preview", { id })) as RendererPetPreviewResult,
    install: async (params: RendererPetInstallParams) =>
      (await send("harnessmix/pets/install", params)) as RendererPetInstallResult,
    uninstall: async (id: string) =>
      (await send("harnessmix/pets/uninstall", { id })) as { id: string; removed: boolean },
  };
}

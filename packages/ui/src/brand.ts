import { createContext, useContext } from 'react';

/** How the app presents itself: its name, icon, version and where its source lives. Given by the app that wraps the UI. */
export interface Brand {
  name: string;
  icon?: string;
  /** For example 0.1.0. */
  version?: string;
  /** The code version the app was built from (a short git commit). */
  commit?: string;
  /** The project's page: its source code, and where to report problems. */
  sourceUrl?: string;
}

export const DEFAULT_BRAND: Brand = { name: 'Pagewright PDF' };

export const BrandContext = createContext<Brand>(DEFAULT_BRAND);

export function useBrand(): Brand {
  return useContext(BrandContext);
}

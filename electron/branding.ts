import path from 'node:path';
import type { App } from 'electron';

export const PRODUCT_NAME = 'Luma';
export const LEGACY_USER_DATA_NAME = '拾光';

/** Display branding must not relocate the library, encrypted key or job state. */
export function configureApplicationIdentity(app: Pick<App, 'getPath' | 'setName' | 'setPath'>, directoryOverride?: string) {
  const directory = directoryOverride ? path.resolve(directoryOverride) : path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME);
  app.setName(PRODUCT_NAME);
  app.setPath('userData', directory);
  return directory;
}

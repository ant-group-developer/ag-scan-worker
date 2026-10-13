import { ROLE_PACKAGES } from '@ag-farm/protocol';
import { RELEASE_PACKAGE } from './release-package';

describe('RELEASE_PACKAGE', () => {
  it('is the package the installer and the hub know for the scan role', () => {
    expect(RELEASE_PACKAGE).toBe(ROLE_PACKAGES.scan);
  });
});

import {
  acknowledgeNativeHandoff,
  prepareNativeHandoff,
} from "@t3tools/shared/nativeOwnershipHandoff";

export {
  acquireServiceInstallerLease,
  activeServiceReplacementExists,
} from "@t3tools/shared/nativeOwnershipHandoff";

export const prepareServiceHandoff = (baseDir: string, replacement = true) =>
  prepareNativeHandoff(baseDir, "service", replacement);

export const acknowledgeServiceHandoff = (baseDir: string) =>
  acknowledgeNativeHandoff(baseDir, "service");

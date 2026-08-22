/**
 * ClineAdapter — shape type for the Cline provider adapter.
 *
 * The driver model ({@link ../Drivers/ClineDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module ClineAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClineAdapterShape — per-instance Cline adapter contract.
 */
export interface ClineAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

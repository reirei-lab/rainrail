import type { RuntimeCapabilityName } from './workflow-plugin.js';

export type DashboardCardEntry =
  | { type: 'core'; name: string }
  | { type: 'plugin'; pluginName: string; cardName: string };

export type DashboardCardAvailability =
  | { status: 'available' }
  | {
    status: 'unavailable';
    reason: 'invalid_plugin' | 'missing_capability' | 'entry_resolution_failed';
    message: string;
    missingCapabilities?: RuntimeCapabilityName[];
  };

export interface DashboardCardSize {
  columns: number;
  rows: number;
}

export interface DashboardCardSizeConstraints {
  default: DashboardCardSize;
  min?: DashboardCardSize;
  max?: DashboardCardSize;
}

export type DashboardCardSettingsSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
} & Record<string, unknown>;

export interface DashboardCardDefinition {
  id: string;
  title: string;
  description?: string;
  entry: DashboardCardEntry;
  category: string;
  requiredCapabilities?: readonly RuntimeCapabilityName[];
  size: DashboardCardSizeConstraints;
  settingsSchema?: DashboardCardSettingsSchema;
}

export interface DashboardCardProvider {
  name: string;
  kind: 'dashboard-card-provider';
  cards: readonly DashboardCardDefinition[];
}

export interface DashboardCardCatalogEntry {
  definition: DashboardCardDefinition;
  availability: DashboardCardAvailability;
}

export interface DashboardCardListOptions {
  availableCapabilities?: readonly RuntimeCapabilityName[];
  enabledPlugins?: readonly string[];
  entryResolutionFailures?: Readonly<Record<string, string>>;
}

export interface DashboardLayoutItem {
  cardId: string;
  x: number;
  y: number;
  columns: number;
  rows: number;
  settings?: Record<string, unknown>;
}

export type DashboardCardRegistryErrorCode =
  | 'duplicate_id'
  | 'invalid_definition'
  | 'invalid_entry'
  | 'invalid_size';

export class DashboardCardRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: DashboardCardRegistryErrorCode,
    public readonly cardId?: string,
  ) {
    super(message);
    this.name = 'DashboardCardRegistryError';
  }
}

export interface DashboardCardRegistry {
  register(definition: DashboardCardDefinition): void;
  registerProvider(provider: DashboardCardProvider): void;
  list(options?: DashboardCardListOptions): DashboardCardCatalogEntry[];
}

export function defineDashboardCard(definition: DashboardCardDefinition): DashboardCardDefinition {
  return definition;
}

export function defineDashboardCardProvider(provider: DashboardCardProvider): DashboardCardProvider {
  return provider;
}

export function createDashboardCardRegistry(): DashboardCardRegistry {
  const cards = new Map<string, DashboardCardDefinition>();

  const register = (definition: DashboardCardDefinition): void => {
    validateDefinition(definition);
    if (cards.has(definition.id)) {
      throw new DashboardCardRegistryError(
        `Dashboard card id "${definition.id}" is already registered`,
        'duplicate_id',
        definition.id,
      );
    }

    cards.set(definition.id, definition);
  };

  return {
    register,
    registerProvider(provider) {
      for (const card of provider.cards) {
        register(card);
      }
    },
    list(options = {}) {
      return [...cards.values()].map((definition) => ({
        definition,
        availability: availabilityFor(definition, options),
      }));
    },
  };
}

function availabilityFor(
  definition: DashboardCardDefinition,
  options: DashboardCardListOptions,
): DashboardCardAvailability {
  const missingCapabilities = missingRequiredCapabilities(definition, options.availableCapabilities);
  const entryResolutionFailure = options.entryResolutionFailures?.[definition.id];
  const invalidPlugin = definition.entry.type === 'plugin'
    && options.enabledPlugins !== undefined
    && !options.enabledPlugins.includes(definition.entry.pluginName);

  if (entryResolutionFailure === undefined && !invalidPlugin && missingCapabilities.length === 0) {
    return { status: 'available' };
  }

  if (entryResolutionFailure !== undefined) {
    return {
      status: 'unavailable',
      reason: 'entry_resolution_failed',
      message: entryResolutionFailure,
    };
  }

  if (invalidPlugin) {
    const pluginName = definition.entry.type === 'plugin' ? definition.entry.pluginName : '';
    const pluginMessage = `Plugin "${pluginName}" is not enabled`;
    if (missingCapabilities.length > 0) {
      return {
        status: 'unavailable',
        reason: 'invalid_plugin',
        missingCapabilities,
        message: `${pluginMessage} and required capabilities are missing: ${missingCapabilities.join(', ')}`,
      };
    }

    return {
      status: 'unavailable',
      reason: 'invalid_plugin',
      message: pluginMessage,
    };
  }

  return {
    status: 'unavailable',
    reason: 'missing_capability',
    missingCapabilities,
    message: `Required capabilities are missing: ${missingCapabilities.join(', ')}`,
  };
}

function missingRequiredCapabilities(
  definition: DashboardCardDefinition,
  availableCapabilities: readonly RuntimeCapabilityName[] | undefined,
): RuntimeCapabilityName[] {
  const required = definition.requiredCapabilities ?? [];
  if (required.length === 0 || availableCapabilities === undefined) {
    return [];
  }

  const available = new Set(availableCapabilities);
  return required.filter((capability) => !available.has(capability));
}

function validateDefinition(definition: DashboardCardDefinition): void {
  if (!isNonEmptyString(definition.id)) {
    throw new DashboardCardRegistryError(
      'Dashboard card id must be a non-empty string',
      'invalid_definition',
    );
  }

  if (!isNonEmptyString(definition.title)) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" title must be a non-empty string`,
      'invalid_definition',
      definition.id,
    );
  }

  if (!isNonEmptyString(definition.category)) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" category must be a non-empty string`,
      'invalid_definition',
      definition.id,
    );
  }

  validateEntry(definition);
  validateSize(definition);
}

function validateEntry(definition: DashboardCardDefinition): void {
  if (definition.entry?.type === 'core') {
    if (isNonEmptyString(definition.entry.name)) return;
  } else if (definition.entry?.type === 'plugin') {
    if (isNonEmptyString(definition.entry.pluginName) && isNonEmptyString(definition.entry.cardName)) return;
  }

  throw new DashboardCardRegistryError(
    `Dashboard card "${definition.id}" entry must be a valid core or plugin entry`,
    'invalid_entry',
    definition.id,
  );
}

function validateSize(definition: DashboardCardDefinition): void {
  const { size } = definition;
  if (size === undefined) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" size.default must be defined`,
      'invalid_size',
      definition.id,
    );
  }

  assertSize(definition, 'default', size.default);
  if (size.min !== undefined) assertSize(definition, 'min', size.min);
  if (size.max !== undefined) assertSize(definition, 'max', size.max);

  if (size.min !== undefined) {
    assertGreaterOrEqual(definition, 'default columns', size.default.columns, 'min columns', size.min.columns);
    assertGreaterOrEqual(definition, 'default rows', size.default.rows, 'min rows', size.min.rows);
  }

  if (size.max !== undefined) {
    assertLessOrEqual(definition, 'default columns', size.default.columns, 'max columns', size.max.columns);
    assertLessOrEqual(definition, 'default rows', size.default.rows, 'max rows', size.max.rows);
  }
}

function assertSize(definition: DashboardCardDefinition, field: string, value: DashboardCardSize): void {
  if (!isPositiveInteger(value?.columns) || !isPositiveInteger(value?.rows)) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" size.${field} columns and rows must be positive integers`,
      'invalid_size',
      definition.id,
    );
  }
}

function assertGreaterOrEqual(
  definition: DashboardCardDefinition,
  leftName: string,
  left: number,
  rightName: string,
  right: number,
): void {
  if (left < right) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" ${leftName} must be greater than or equal to ${rightName}`,
      'invalid_size',
      definition.id,
    );
  }
}

function assertLessOrEqual(
  definition: DashboardCardDefinition,
  leftName: string,
  left: number,
  rightName: string,
  right: number,
): void {
  if (left > right) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" ${leftName} must be less than or equal to ${rightName}`,
      'invalid_size',
      definition.id,
    );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

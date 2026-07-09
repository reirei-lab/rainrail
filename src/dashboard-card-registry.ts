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
  additionalProperties?: boolean | Record<string, unknown>;
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
  id: string;
  cardId: string;
  x: number;
  y: number;
  columns: number;
  rows: number;
  config?: Record<string, unknown>;
}

export type DashboardCardRegistryErrorCode =
  | 'duplicate_id'
  | 'invalid_definition'
  | 'invalid_entry'
  | 'invalid_provider'
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
    const prepared = prepareDefinition(definition);
    if (cards.has(prepared.id)) {
      throw new DashboardCardRegistryError(
        `Dashboard card id "${prepared.id}" is already registered`,
        'duplicate_id',
        prepared.id,
      );
    }

    cards.set(prepared.id, prepared);
  };

  return {
    register,
    registerProvider(provider) {
      validateProvider(provider);
      const preparedCards: DashboardCardDefinition[] = [];
      const providerIds = new Set<string>();
      for (const card of provider.cards) {
        const prepared = prepareDefinition(card);
        validateProviderCard(provider, prepared);
        if (cards.has(prepared.id) || providerIds.has(prepared.id)) {
          throw new DashboardCardRegistryError(
            `Dashboard card id "${prepared.id}" is already registered`,
            'duplicate_id',
            prepared.id,
          );
        }
        providerIds.add(prepared.id);
        preparedCards.push(prepared);
      }

      for (const card of preparedCards) {
        cards.set(card.id, card);
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
    && (options.enabledPlugins === undefined || !options.enabledPlugins.includes(definition.entry.pluginName));

  if (entryResolutionFailure === undefined && !invalidPlugin && missingCapabilities.length === 0) {
    return { status: 'available' };
  }

  if (entryResolutionFailure !== undefined) {
    if (missingCapabilities.length > 0) {
      return {
        status: 'unavailable',
        reason: 'entry_resolution_failed',
        missingCapabilities,
        message: `${entryResolutionFailure} and required capabilities are missing: ${missingCapabilities.join(', ')}`,
      };
    }

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
  if (required.length === 0) {
    return [];
  }

  if (availableCapabilities === undefined) return [...required];

  const available = new Set(availableCapabilities);
  return required.filter((capability) => !available.has(capability));
}

function validateDefinition(definition: DashboardCardDefinition): void {
  if (!isPlainObject(definition)) {
    throw new DashboardCardRegistryError(
      'Dashboard card definition must be a plain object',
      'invalid_definition',
    );
  }

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

  if (definition.description !== undefined && typeof definition.description !== 'string') {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" description must be a string`,
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
  validateRequiredCapabilities(definition);
  validateSettingsSchema(definition);
  validateSize(definition);
}

function validateEntry(definition: DashboardCardDefinition): void {
  if (definition.entry?.type === 'core') {
    if (isNonEmptyString(definition.entry.name)) {
      const expectedId = `core.${definition.entry.name}`;
      if (definition.id !== expectedId) {
        throw new DashboardCardRegistryError(
          `Dashboard card "${definition.id}" id must match core entry namespace "${expectedId}"`,
          'invalid_entry',
          definition.id,
        );
      }
      return;
    }
  } else if (definition.entry?.type === 'plugin') {
    if (isNonEmptyString(definition.entry.pluginName) && isNonEmptyString(definition.entry.cardName)) {
      validatePluginEntryIdentifier(definition, 'pluginName', definition.entry.pluginName);
      validatePluginEntryIdentifier(definition, 'cardName', definition.entry.cardName);
      const expectedId = `plugin:${definition.entry.pluginName}.${definition.entry.cardName}`;
      if (definition.id !== expectedId) {
        throw new DashboardCardRegistryError(
          `Dashboard card "${definition.id}" id must match plugin entry namespace "${expectedId}"`,
          'invalid_entry',
          definition.id,
        );
      }
      return;
    }
  }

  throw new DashboardCardRegistryError(
    `Dashboard card "${definition.id}" entry must be a valid core or plugin entry`,
    'invalid_entry',
    definition.id,
  );
}

function validatePluginEntryIdentifier(
  definition: DashboardCardDefinition,
  field: 'pluginName' | 'cardName',
  value: string,
): void {
  if (value.includes('.') || value.includes(':')) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" ${field} must not contain "." or ":"`,
      'invalid_entry',
      definition.id,
    );
  }
}

function validateRequiredCapabilities(definition: DashboardCardDefinition): void {
  const { requiredCapabilities } = definition;
  if (requiredCapabilities === undefined) return;

  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((capability) => !isNonEmptyString(capability))) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" requiredCapabilities must be an array of non-empty strings`,
      'invalid_definition',
      definition.id,
    );
  }
}

function validateProvider(provider: DashboardCardProvider): void {
  if (!isPlainObject(provider)) {
    throw new DashboardCardRegistryError(
      'Dashboard card provider must be a plain object',
      'invalid_provider',
    );
  }

  if (!isNonEmptyString(provider.name)) {
    throw new DashboardCardRegistryError(
      'Dashboard card provider name must be a non-empty string',
      'invalid_provider',
    );
  }

  if (provider.kind !== 'dashboard-card-provider') {
    throw new DashboardCardRegistryError(
      'Dashboard card provider kind must be "dashboard-card-provider"',
      'invalid_provider',
    );
  }

  if (!Array.isArray(provider.cards)) {
    throw new DashboardCardRegistryError(
      'Dashboard card provider cards must be an array',
      'invalid_provider',
    );
  }
}

function validateProviderCard(provider: DashboardCardProvider, definition: DashboardCardDefinition): void {
  if (provider.name === 'core') {
    if (definition.entry?.type === 'core') return;

    throw new DashboardCardRegistryError(
      `Provider "core" cannot register plugin card "${definition.id}"`,
      'invalid_provider',
      definition.id,
    );
  }

  if (definition.entry?.type !== 'plugin') {
    throw new DashboardCardRegistryError(
      `Provider "${provider.name}" cannot register non-plugin card "${definition.id}"`,
      'invalid_provider',
      definition.id,
    );
  }

  if (definition.entry.pluginName === provider.name) return;

  throw new DashboardCardRegistryError(
    `Provider "${provider.name}" cannot register plugin card "${definition.id}" for plugin "${definition.entry.pluginName}"`,
    'invalid_provider',
    definition.id,
  );
}

function validateSettingsSchema(definition: DashboardCardDefinition): void {
  const { settingsSchema } = definition;
  if (settingsSchema === undefined) return;

  if (!isPlainObject(settingsSchema)) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" settingsSchema must be a plain JSON object`,
      'invalid_definition',
      definition.id,
    );
  }

  if (settingsSchema.type !== 'object') {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" settingsSchema.type must be "object"`,
      'invalid_definition',
      definition.id,
    );
  }

  if (
    settingsSchema.additionalProperties !== undefined
    && typeof settingsSchema.additionalProperties !== 'boolean'
    && !isPlainObject(settingsSchema.additionalProperties)
  ) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" settingsSchema.additionalProperties must be a boolean or plain JSON object`,
      'invalid_definition',
      definition.id,
    );
  }

  if (!isJsonSerializable(settingsSchema, new WeakSet())) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" settingsSchema must contain only JSON-serializable values`,
      'invalid_definition',
      definition.id,
    );
  }
}

function validateSize(definition: DashboardCardDefinition): void {
  const { size } = definition;
  if (!isPlainObject(size)) {
    throw new DashboardCardRegistryError(
      `Dashboard card "${definition.id}" size must be a plain object`,
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

function prepareDefinition(definition: DashboardCardDefinition): DashboardCardDefinition {
  validateDefinition(definition);
  return freezeDefinition(cloneDefinition(definition));
}

function cloneDefinition(definition: DashboardCardDefinition): DashboardCardDefinition {
  return {
    id: definition.id,
    title: definition.title,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    entry: cloneEntry(definition.entry),
    category: definition.category,
    ...(definition.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: [...definition.requiredCapabilities] }),
    size: {
      default: { ...definition.size.default },
      ...(definition.size.min === undefined ? {} : { min: { ...definition.size.min } }),
      ...(definition.size.max === undefined ? {} : { max: { ...definition.size.max } }),
    },
    ...(definition.settingsSchema === undefined
      ? {}
      : { settingsSchema: structuredClone(definition.settingsSchema) }),
  };
}

function cloneEntry(entry: DashboardCardEntry): DashboardCardEntry {
  if (entry.type === 'core') {
    return { type: 'core', name: entry.name };
  }

  return { type: 'plugin', pluginName: entry.pluginName, cardName: entry.cardName };
}

function freezeDefinition(definition: DashboardCardDefinition): DashboardCardDefinition {
  Object.freeze(definition.entry);
  if (definition.requiredCapabilities !== undefined) Object.freeze(definition.requiredCapabilities);
  Object.freeze(definition.size.default);
  if (definition.size.min !== undefined) Object.freeze(definition.size.min);
  if (definition.size.max !== undefined) Object.freeze(definition.size.max);
  Object.freeze(definition.size);
  if (definition.settingsSchema !== undefined) deepFreeze(definition.settingsSchema);
  return Object.freeze(definition);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const propertyValue of Object.values(value)) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonSerializable(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null) return true;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') return true;
  if (valueType === 'number') return Number.isFinite(value);
  if (valueType !== 'object') return false;

  const objectValue = value as object;
  if (ancestors.has(objectValue)) return false;
  ancestors.add(objectValue);
  let serializable: boolean;
  if (Array.isArray(value)) {
    serializable = value.every((item) => isJsonSerializable(item, ancestors));
  } else if (!isPlainObject(value)) {
    serializable = false;
  } else {
    serializable = Object.values(value).every((item) => isJsonSerializable(item, ancestors));
  }
  ancestors.delete(objectValue);

  return serializable;
}

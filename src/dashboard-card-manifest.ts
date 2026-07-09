import {
  createDashboardCardRegistry,
  type DashboardCardDefinition,
  type DashboardCardProvider,
  type DashboardCardSettingsSchema,
  type DashboardCardSizeConstraints,
  DashboardCardRegistryError,
} from './dashboard-card-registry.js';
import type { RuntimeCapabilityName } from './workflow-plugin.js';

export interface DashboardPluginManifest {
  name: string;
  version: string;
  dashboard?: DashboardPluginManifestDashboard;
}

export interface DashboardPluginManifestDashboard {
  cards?: readonly DashboardPluginManifestCard[];
}

export interface DashboardPluginManifestCard {
  name: string;
  title: string;
  description?: string;
  category: string;
  requiredCapabilities?: readonly RuntimeCapabilityName[];
  size: DashboardCardSizeConstraints;
  settingsSchema?: DashboardCardSettingsSchema;
}

export function createDashboardCardProviderFromManifest(
  manifest: DashboardPluginManifest,
): DashboardCardProvider {
  if (!isPlainObject(manifest)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest must be a plain object',
      'invalid_provider',
    );
  }

  if (!isNonEmptyString(manifest.name)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest name must be a non-empty string',
      'invalid_provider',
    );
  }

  if (manifest.dashboard !== undefined && !isPlainObject(manifest.dashboard)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest dashboard must be a plain object',
      'invalid_provider',
    );
  }

  const manifestCards = manifest.dashboard?.cards ?? [];
  if (!Array.isArray(manifestCards)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest dashboard.cards must be an array',
      'invalid_provider',
    );
  }

  const provider: DashboardCardProvider = {
    name: manifest.name,
    kind: 'dashboard-card-provider',
    cards: manifestCards.map((card) => manifestCardToDefinition(manifest.name, card)),
  };

  createDashboardCardRegistry().registerProvider(provider);
  return provider;
}

function manifestCardToDefinition(
  pluginName: string,
  card: DashboardPluginManifestCard,
): DashboardCardDefinition {
  if (!isPlainObject(card)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest dashboard card must be a plain object',
      'invalid_definition',
    );
  }

  if (!isNonEmptyString(card.name)) {
    throw new DashboardCardRegistryError(
      'Plugin manifest dashboard card name must be a non-empty string',
      'invalid_definition',
    );
  }

  return {
    id: `plugin:${pluginName}.${card.name}`,
    title: card.title,
    ...(card.description === undefined ? {} : { description: card.description }),
    entry: { type: 'plugin', pluginName, cardName: card.name },
    category: card.category,
    ...(card.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: [...card.requiredCapabilities] }),
    size: card.size,
    ...(card.settingsSchema === undefined ? {} : { settingsSchema: card.settingsSchema }),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

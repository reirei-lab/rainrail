export type OfficialPluginCommandMetadata = {
  readonly name: string;
  readonly summary: string;
  readonly helpText: string;
};

export type OfficialPluginMetadata = {
  readonly name: string;
  readonly alias: string;
  readonly aliases: readonly string[];
  readonly version: string;
  readonly summary: string;
  readonly helpText: string;
  readonly commands: readonly OfficialPluginCommandMetadata[];
};

export const OFFICIAL_PLUGIN_CATALOG: readonly OfficialPluginMetadata[] = [
  {
    name: 'GitHub',
    alias: 'github',
    aliases: ['github', 'gh'],
    version: '0.1.0',
    summary: 'Manage GitHub webhooks, repository checks, and provider setup.',
    helpText: 'GitHub official plugin metadata for repository event intake and task provider operations.',
    commands: [
      {
        name: 'setup',
        summary: 'Prepare GitHub provider authentication and repository defaults.',
        helpText: 'Usage: rainrail github setup [options]',
      },
      {
        name: 'doctor',
        summary: 'Check GitHub token, app, webhook, and rate-limit readiness.',
        helpText: 'Usage: rainrail github doctor [options]',
      },
      {
        name: 'webhook add',
        summary: 'Register a GitHub webhook endpoint for a repository.',
        helpText: 'Usage: rainrail github webhook add <owner/repo> [options]',
      },
    ],
  },
  {
    name: 'Cloudflare',
    alias: 'cloudflare',
    aliases: ['cloudflare', 'cf'],
    version: '0.1.0',
    summary: 'Manage Cloudflare Worker deployment, secrets, and tail event intake.',
    helpText: 'Cloudflare official plugin metadata for Worker operations and tail event sources.',
    commands: [
      {
        name: 'setup',
        summary: 'Prepare Cloudflare account, Worker, and secret configuration.',
        helpText: 'Usage: rainrail cloudflare setup [options]',
      },
      {
        name: 'doctor',
        summary: 'Check Wrangler authentication, Worker routes, and required secrets.',
        helpText: 'Usage: rainrail cloudflare doctor [options]',
      },
      {
        name: 'tail',
        summary: 'Inspect Cloudflare Worker tail event source connectivity.',
        helpText: 'Usage: rainrail cloudflare tail [options]',
      },
    ],
  },
  {
    name: 'OpenClaw',
    alias: 'openclaw',
    aliases: ['openclaw', 'oc'],
    version: '0.1.0',
    summary: 'Manage OpenClaw runtime provider checks and agent dispatch wiring.',
    helpText: 'OpenClaw official plugin metadata for runtime provider and agent session operations.',
    commands: [
      {
        name: 'setup',
        summary: 'Prepare OpenClaw runtime provider defaults for local projects.',
        helpText: 'Usage: rainrail openclaw setup [options]',
      },
      {
        name: 'doctor',
        summary: 'Check OpenClaw command availability and dispatch configuration.',
        helpText: 'Usage: rainrail openclaw doctor [options]',
      },
      {
        name: 'session test',
        summary: 'Run a non-destructive OpenClaw agent session connectivity check.',
        helpText: 'Usage: rainrail openclaw session test [options]',
      },
    ],
  },
];

export function getOfficialPluginByAlias(alias: string): OfficialPluginMetadata | undefined {
  return OFFICIAL_PLUGIN_CATALOG.find((plugin) => plugin.aliases.includes(alias));
}

export function formatOfficialPluginHelp(
  plugin: OfficialPluginMetadata,
  invocation: readonly string[] = [plugin.alias],
): string {
  const commandRows = plugin.commands.map((command) => {
    const paddedName = command.name.padEnd(12, ' ');
    return `  ${paddedName} ${command.summary}`;
  }).join('\n');
  const aliasText = plugin.aliases.join(', ');

  return [
    `Usage: rainrail ${invocation.join(' ')} <command> [options]`,
    '',
    `${plugin.name} official plugin`,
    plugin.helpText,
    '',
    `Aliases: ${aliasText}`,
    '',
    'Commands:',
    commandRows,
    '',
  ].join('\n');
}

export function formatOfficialPluginCommandHelp(
  plugin: OfficialPluginMetadata,
  command: OfficialPluginCommandMetadata,
  invocation: readonly string[] = [plugin.alias],
): string {
  const defaultUsagePrefix = `Usage: rainrail ${plugin.alias} ${command.name}`;
  const invocationUsagePrefix = `Usage: rainrail ${[...invocation, command.name].join(' ')}`;
  const helpText = command.helpText.startsWith(defaultUsagePrefix)
    ? `${invocationUsagePrefix}${command.helpText.slice(defaultUsagePrefix.length)}`
    : command.helpText;

  return [
    helpText,
    '',
    `${plugin.name} official plugin`,
    command.summary,
    '',
  ].join('\n');
}

export function getOfficialPluginCommand(
  plugin: OfficialPluginMetadata,
  args: readonly string[],
): OfficialPluginCommandMetadata | undefined {
  if (args.length === 0) {
    return undefined;
  }

  return plugin.commands.find((command) => {
    const commandParts = command.name.split(' ');
    return commandParts.every((part, index) => args[index] === part);
  });
}

export function isOfficialPluginHelpRequest(args: readonly string[]): boolean {
  return args.length === 0 || args[0] === 'help' || args[0] === '--help';
}

export function isOfficialPluginCommandHelpRequest(
  command: OfficialPluginCommandMetadata,
  args: readonly string[],
): boolean {
  const commandLength = command.name.split(' ').length;
  const nextArg = args[commandLength];
  return args.length === commandLength + 1 && (nextArg === 'help' || nextArg === '--help');
}

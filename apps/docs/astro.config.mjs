import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.rainrail.dev',
  integrations: [
    starlight({
      title: 'Rainrail Docs',
      description:
        'Documentation for Rainrail event routing, agent workflows, and operations.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/reirei-lab/rainrail',
        },
      ],
      sidebar: [
        {
          label: 'Quickstart',
          items: [{ label: 'Overview', slug: 'quickstart' }],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Overview', slug: 'concepts' },
            { label: 'Event model', slug: 'concepts/event-model' },
            { label: 'Runtime boundaries', slug: 'concepts/runtime-boundaries' },
            { label: 'Event delivery', slug: 'concepts/event-delivery' },
            { label: 'Operational state', slug: 'concepts/operational-state' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Overview', slug: 'guides' },
            { label: 'Add a source adapter', slug: 'guides/source-adapter' },
            { label: 'Add a workflow plugin', slug: 'guides/workflow-plugin' },
            { label: 'Run local delivery', slug: 'guides/local-delivery' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Overview', slug: 'reference' },
            { label: 'Plugin runtime', slug: 'reference/plugin-runtime' },
            {
              label: 'GitHub webhook normalization',
              slug: 'reference/github-webhook-normalization',
            },
            { label: 'Operational API v1', slug: 'reference/operational-api-v1' },
            { label: 'Contracts manifest', slug: 'reference/contracts-manifest' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Overview', slug: 'operations' },
            { label: 'Cloudflare Worker', slug: 'operations/cloudflare-worker' },
            { label: 'Cloudflare Pages', slug: 'operations/cloudflare-pages' },
            { label: 'Task queue', slug: 'operations/task-queue' },
          ],
        },
        {
          label: 'Examples',
          items: [{ label: 'Plugin runtime sample', slug: 'examples/plugin-runtime' }],
        },
      ],
    }),
  ],
});

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
          items: [{ label: 'Overview', slug: 'concepts' }],
        },
        {
          label: 'Guides',
          items: [{ label: 'Overview', slug: 'guides' }],
        },
        {
          label: 'Reference',
          items: [{ label: 'Overview', slug: 'reference' }],
        },
        {
          label: 'Operations',
          items: [{ label: 'Overview', slug: 'operations' }],
        },
      ],
    }),
  ],
});

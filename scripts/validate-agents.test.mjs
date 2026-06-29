import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

describe('AGENTS.md development rules', () => {
  it('documents Rainrail as a TypeScript monorepo for event orchestration work', () => {
    expect(agents).toContain('TypeScript monorepo');
    expect(agents).toContain('plugin');
    expect(agents).toContain('event');
    expect(agents).toContain('orchestration');
  });

  it('requires t-wada style TDD and Red-Green-Refactor', () => {
    expect(agents).toContain('t-wada style TDD');
    expect(agents).toContain('failing test');
    expect(agents).toContain('Red-Green-Refactor');
  });

  it('requires English Conventional Commit logs while allowing Japanese GitHub discussion', () => {
    expect(agents).toContain('Conventional Commits');
    expect(agents).toContain('Commit logs must be written in English');
    expect(agents).toContain('Issue and PR bodies and comments may be written in Japanese');
  });

  it('covers secret handling, PR contents, and Japanese docs for specification decisions', () => {
    expect(agents).toContain('Never commit secrets, tokens, credentials');
    expect(agents).toContain('Summary');
    expect(agents).toContain('Verification');
    expect(agents).toContain('Related issue');
    expect(agents).toContain('docs/');
    expect(agents).toContain('specs/');
    expect(agents).toContain('Japanese');
  });

  it('documents Codex code review expectations', () => {
    expect(agents).toContain('## Codex Code Review Guidelines');
    expect(agents).toContain('Write review comments in Japanese');
    expect(agents).toContain('security risks');
    expect(agents).toContain('edge cases');
  });
});
